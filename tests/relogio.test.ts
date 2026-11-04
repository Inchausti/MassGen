// Relógio automático da POC (D-MG-07): "o relógio da POC avança por comando ou a cada intervalo configurado, e o envio
// acompanha o relógio". Sobe o app com o intervalo mínimo de 1 segundo e um SplitHub falso que recebe os avisos e baixa o
// que chega. Confere:
// - que cada passo é o Fechar o dia nos dois entes, com a defasagem da CBS e os avisos, e fecha um dia só;
// - a data de parada;
// - quem liga e quem pausa, na trilha;
// - que o dia fechado por comando não fecha de novo;
// - a subida do servidor, inclusive depois de uma queda entre o fechamento e a anotação do passo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { lerZip } from '../server/emulacao/zip.ts';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PORTA_APP = 13957;
const PORTA_SPLITHUB = 13958;
const API = `http://localhost:${PORTA_APP}/api`;
const IBS = `http://localhost:${PORTA_APP}/entes/ibs`;
const WEBHOOK = `http://localhost:${PORTA_SPLITHUB}/webhook/ibs`;
const RETORNO = `http://localhost:${PORTA_SPLITHUB}/retorno/cbs`;
const ROOT = 'root.poc@empresa.com.br';
const SENHA = 'senha-de-teste-123';
const dados = mkdtempSync(path.join(tmpdir(), 'massgen-relogio-'));
const ENV = {
  PORT: String(PORTA_APP), MASSGEN_DATA_DIR: dados, ALLOWED_DESTINATION_DOMAINS: 'localhost', MASSGEN_HOST: '', MASSGEN_CONFIAR_CLOUDFLARE_ACCESS: 'false',
  MASSGEN_ROOTS: ROOT, MASSGEN_URL_PUBLICA: `http://localhost:${PORTA_APP}`, MASSGEN_COOKIE_SEGURO: 'false', MASSGEN_AVISO_ESPERAS_MS: '50,50',
  MASSGEN_RELOGIO_MIN_SEG: '1',
};
let app: { p: ChildProcess; saida: () => string } | undefined;
let splithub: Server;

// ---------------------------------------------------------------- uma nota fictícia, valores redondos

const CLIENTE = '12345678000190';
const FORNECEDOR = '98765432000110';

function chaveDe(cnpj: string, numero: number): string {
  const base = `352611${cnpj}55001${String(numero).padStart(9, '0')}1${String(numero).padStart(8, '0')}`;
  let soma = 0;
  let peso = 2;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const dv = 11 - (soma % 11);
  return base + (dv >= 10 ? 0 : dv);
}

const CHAVE = chaveDe(FORNECEDOR, 1001);
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${CHAVE}" versao="4.00">
<ide><cUF>35</cUF><natOp>Compra</natOp><mod>55</mod><serie>1</serie><nNF>1001</nNF><dhEmi>2026-11-01T10:00:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>1</finNFe></ide>
<emit><CNPJ>${FORNECEDOR}</CNPJ><xNome>Fornecedor</xNome></emit><dest><CNPJ>${CLIENTE}</CNPJ><xNome>Cliente</xNome></dest>
<total><ICMSTot><vNF>100000.00</vNF></ICMSTot><IBSCBSTot><vBCIBSCBS>100000.00</vBCIBSCBS><gIBS><gIBSUF><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSUF>600.00</vIBSUF></gIBSUF><gIBSMun><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSMun>400.00</vIBSMun></gIBSMun><vIBS>1000.00</vIBS></gIBS><gCBS><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vCBS>500.00</vCBS></gCBS></IBSCBSTot></total></infNFe></NFe>
<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${CHAVE}</chNFe><dhRecbto>2026-11-01T10:00:05-03:00</dhRecbto><nProt>135260000001001</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;

// ---------------------------------------------------------------- o app e o SplitHub falso

let cookie = '';
let pocId = '';
let credIbs = { clientId: '', clientSecret: '' };
const avisosIbs: { idSolic: number; tipo: string; arquivos: number }[] = [];
const baixadosCbs: { tiquete: string; status: number }[] = [];
let ocupado = 0;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

function subirApp(): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server/main.ts'], { cwd: RAIZ, env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    let pronto = false;
    p.stdout!.on('data', (b) => { saida += b; if (!pronto && /MassGen no ar/.test(saida)) { pronto = true; app = { p, saida: () => saida }; resolve(); } });
    p.stderr!.on('data', (b) => { saida += b; });
    p.on('exit', (c) => { if (!pronto) reject(new Error(`o app saiu com ${c}: ${saida}`)); });
    setTimeout(() => { if (!pronto) reject(new Error(`o app não subiu: ${saida}`)); }, 15000);
  });
}

// Queda do servidor: no Windows, kill é o TerminateProcess; no Linux, SIGKILL. Nada do app roda depois.
async function derrubarApp(): Promise<void> {
  const p = app!.p;
  app = undefined;
  const saiu = once(p, 'exit');
  p.kill('SIGKILL');
  await saiu;
}

async function chamar(metodo: string, url: string, op: { corpo?: unknown; cabecalhos?: Record<string, string> } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(cookie && url.startsWith(API) ? { cookie } : {}), ...op.cabecalhos },
    body: op.corpo === undefined ? undefined : JSON.stringify(op.corpo),
  });
  const texto = await r.text();
  let corpo: any;
  try { corpo = texto ? JSON.parse(texto) : undefined; } catch { corpo = texto; }
  return { status: r.status, corpo };
}

async function api<T = any>(metodo: string, rota: string, corpo?: unknown): Promise<T> {
  const r = await chamar(metodo, API + rota, { corpo });
  if (r.status >= 400) throw new Error(`${metodo} ${rota} → ${r.status}: ${JSON.stringify(r.corpo)}`);
  return r.corpo as T;
}

const doIbs = () => ({ clientid: credIbs.clientId, clientsecret: credIbs.clientSecret });

// Responde 2xx a cada aviso e baixa o que veio, nos dois entes.
function subirSplitHub(): Promise<void> {
  splithub = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'HEAD') { res.writeHead(u.pathname === '/retorno/cbs' ? 200 : 404).end(); return; }
    let texto = '';
    for await (const c of req) texto += c;
    const corpo = JSON.parse(texto);
    ocupado++;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"recebido":true}');
    try {
      if (u.pathname === '/webhook/ibs') {
        avisosIbs.push({ idSolic: corpo.idSolic, tipo: corpo.tipoSolic, arquivos: corpo.arquivos.length });
        for (const a of corpo.arquivos) {
          const r = await fetch(`${IBS}/v1/aassist/arquivo/${a.nomeArq}`, { headers: doIbs() });
          if (r.status === 200) lerZip(Buffer.from(await r.arrayBuffer()));
        }
      } else if (u.pathname === '/retorno/cbs' && corpo.urlAssinada) {
        const r = await fetch(corpo.urlAssinada);
        await r.arrayBuffer();
        baixadosCbs.push({ tiquete: corpo.tiqueteSolicitacao, status: r.status });
      }
    } finally {
      ocupado--;
    }
  });
  return new Promise((r) => splithub.listen(PORTA_SPLITHUB, r));
}

async function calmo(): Promise<void> {
  let quietos = 0;
  for (let i = 0; i < 200 && quietos < 5; i++) {
    await esperar(100);
    quietos = ocupado === 0 ? quietos + 1 : 0;
  }
}

async function ate<T>(ler: () => Promise<T>, cond: (v: T) => boolean, msg: string, limiteMs = 20000): Promise<T> {
  const fim = Date.now() + limiteMs;
  let v = await ler();
  while (!cond(v)) {
    if (Date.now() > fim) throw new Error(`${msg}: ${JSON.stringify(v)}`);
    await esperar(100);
    v = await ler();
  }
  return v;
}

const poc = () => api('GET', `/pocs/${pocId}`);
const relogio = async () => (await poc()).relogioAuto;
const trilha = async (acao: string) => (await api<any[]>('GET', `/auditoria?alvo=${pocId}&limite=500`)).filter((l) => l.acao === acao).reverse();
const automatico = (corpo: unknown) => chamar('POST', `${API}/pocs/${pocId}/relogio/automatico/ligar`, { corpo });

before(async () => {
  await subirSplitHub();
  await subirApp();
  let link = '';
  for (let i = 0; i < 50 && !link; i++) {
    link = /Primeiro acesso de root\.poc@empresa\.com\.br: (\S+)/.exec(app!.saida())?.[1] ?? '';
    if (!link) await esperar(100);
  }
  const r = await fetch(`${API}/convites/${link.split('/convite/')[1]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nome: 'Root', senha: SENHA }) });
  cookie = r.headers.getSetCookie().find((c) => c.startsWith('massgen_sessao='))!.split(';')[0];
});

after(async () => {
  if (app) await derrubarApp();
  splithub?.close();
  rmSync(dados, { recursive: true, force: true });
});

// ---------------------------------------------------------------- ponta a ponta

test('POC com a nota no RT-A1 e a CBS um dia depois do IBS; os dois entes apontam para o SplitHub falso', async () => {
  const r = await api('POST', '/pocs', { nome: 'POC Relógio', cnpj: CLIENTE, competencia: '2026-11' });
  pocId = r.poc.id;
  credIbs = r.credenciais.find((c: any) => c.ente === 'ibs');
  assert.equal(r.poc.relogioAuto.estado, 'desligado', 'o relógio começa só por comando');
  const imp = await api('POST', `/pocs/${pocId}/notas`, { arquivos: [{ nome: '1001.xml', conteudo: XML }] });
  assert.equal(imp.aceitas, 1);
  const hab = await chamar('POST', `${IBS}/v1/aassist/habilitar`, { cabecalhos: doIbs(), corpo: { queroHabilitar: 'HAB', webhookUrl: WEBHOOK, tokenContrib: 'token-do-splithub' } });
  assert.equal(hab.status, 200);
  await api('PUT', `/pocs/${pocId}/cbs/url-retorno`, { urlRetorno: RETORNO });
  await api('PUT', `/pocs/${pocId}`, { defasagemCbs: 1 });
  const [nota] = await api<any[]>('GET', `/pocs/${pocId}/notas`);
  const rt = await api('POST', `/pocs/${pocId}/roteiros`, { notaIds: [nota.id], roteiro: 'RT-A1' });
  assert.deepEqual(rt.itens.map((i: any) => `${i.id}@${i.dia}`), [
    'E-IBS-01@2026-11-01', 'E-IBS-05@2026-11-02', 'E-IBS-06@2026-11-03', 'E-CBS-C01@2026-11-02', 'E-CBS-C02@2026-11-03', 'E-CBS-C07@2026-11-04',
  ]);
});

test('recusas: intervalo fora do limite, data de parada antes do relógio, pausar ou retomar o que não foi ligado', async () => {
  assert.equal((await automatico({ intervaloSeg: 0 })).status, 400);
  assert.equal((await automatico({})).status, 400, 'o intervalo é obrigatório ao ligar');
  assert.equal((await automatico({ intervaloSeg: 86401 })).status, 400);
  const antes = await automatico({ intervaloSeg: 1, pararEm: '2026-10-31' });
  assert.equal(antes.status, 400);
  assert.match(antes.corpo.erro, /data de parada/);
  assert.equal((await automatico({ intervaloSeg: 1, pararEm: '30/11/2026' })).status, 400);
  assert.equal((await chamar('POST', `${API}/pocs/${pocId}/relogio/automatico/pausar`)).status, 409);
  assert.equal((await chamar('POST', `${API}/pocs/${pocId}/relogio/automatico/retomar`, { corpo: {} })).status, 409);
  assert.equal((await chamar('PUT', `${API}/pocs/${pocId}/relogio/automatico`, { corpo: { intervaloSeg: 5 } })).status, 409);
  assert.equal((await relogio()).estado, 'desligado');
  assert.equal((await poc()).dia, '2026-11-01', 'nada andou');
});

test('ligado: um dia por passo nos dois entes, com a defasagem da CBS e os avisos; pausa sozinho depois da data de parada', async () => {
  const r = await automatico({ intervaloSeg: 1, pararEm: '2026-11-04' });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.estado, 'rodando');
  assert.equal(r.corpo.diaAlvo, '2026-11-01');
  assert.equal(r.corpo.ligadoPor, ROOT);
  assert.ok(Date.parse(r.corpo.proximoEm) > Date.now(), 'ligar não fecha o dia na hora');
  assert.equal((await automatico({ intervaloSeg: 1 })).status, 409, 'ligado uma vez, depois é pausar e retomar');

  const fim = await ate(relogio, (a) => a.estado === 'pausado', 'o relógio não pausou na data de parada');
  assert.match(fim.motivo, /dia de parada \(04\/11\)/);
  assert.equal(fim.passos, 4);
  assert.equal((await poc()).dia, '2026-11-05', 'fecha 01/11 a 04/11, inclusive, e para');
  await calmo();

  // Cada passo, na trilha, levou o relógio um dia adiante, com o relógio como autor e quem o ligou.
  const passos = (await trilha('poc.relogio')).filter((l) => l.detalhes.automatico);
  assert.deepEqual(passos.map((l) => `${l.detalhes.de}>${l.detalhes.para}`), ['2026-11-01>2026-11-02', '2026-11-02>2026-11-03', '2026-11-03>2026-11-04', '2026-11-04>2026-11-05']);
  for (const l of passos) assert.equal(l.usuario, `relógio automático (ligado por ${ROOT})`);
  for (let i = 1; i < passos.length; i++) assert.ok(Date.parse(passos[i].em) - Date.parse(passos[i - 1].em) >= 900, 'um intervalo inteiro entre um passo e o seguinte');

  // IBS: um Delta por dia com lançamento (01 a 03/11), avisado e baixado.
  assert.deepEqual(passos.map((l) => l.detalhes.deltas.map((d: any) => `${d.dia}:${d.aviso}`)), [['2026-11-01:ok'], ['2026-11-02:ok'], ['2026-11-03:ok'], []]);
  assert.equal(avisosIbs.filter((a) => a.tipo === 'DIFERENCIAL').length, 3);
  // CBS: a defasagem de +1 põe os eventos de 02 a 04/11; cada dia avisa sem pedido em /creditos.
  assert.deepEqual(passos.map((l) => l.detalhes.cbs.map((c: any) => `${c.dia}:${c.tiquetes.map((t: any) => `${t.endpoint}:${t.aviso}`).join(',')}`)),
    [[], ['2026-11-02:creditos:ok'], ['2026-11-03:creditos:ok'], ['2026-11-04:creditos:ok']]);
  assert.equal(baixadosCbs.length, 3);
  assert.ok(baixadosCbs.every((b) => b.status === 200), 'nenhum link venceu: um dia por passo');
  const det = await poc();
  assert.equal(det.eventos.recebido, 6, 'os seis eventos do RT-A1 chegaram ao SplitHub');

  const auto = await trilha('poc.relogio_auto');
  assert.equal(auto[0].usuario, ROOT, 'quem ligou');
  assert.equal(auto[0].detalhes.acao, 'ligar');
  assert.equal(auto.at(-1).detalhes.acao, 'pausar');
  assert.equal(auto.at(-1).usuario, `relógio automático (ligado por ${ROOT})`);
  assert.match(auto.at(-1).resumo, /pausou sozinho: chegou ao dia de parada/);
});

test('pausar e retomar: quem pausou e quem retomou ficam na trilha; pausado, o relógio não anda', async () => {
  const ret = await chamar('POST', `${API}/pocs/${pocId}/relogio/automatico/retomar`, { corpo: { pararEm: '2026-11-03' } });
  assert.equal(ret.status, 400, 'a nova data de parada não pode vir antes do relógio');
  const r = await api('POST', `/pocs/${pocId}/relogio/automatico/retomar`, { pararEm: null });
  assert.equal(r.estado, 'rodando');
  assert.equal(r.diaAlvo, '2026-11-05');
  assert.equal(r.pararEm, null);
  assert.equal(r.intervaloSeg, 1, 'retomar mantém o intervalo');
  await ate(poc, (p) => p.dia >= '2026-11-06', 'retomado, o relógio não andou');
  const p = await api('POST', `/pocs/${pocId}/relogio/automatico/pausar`);
  assert.equal(p.estado, 'pausado');
  assert.equal(p.pausadoPor, ROOT);
  assert.equal(p.motivo, null);
  // O passo que já estava em andamento termina; o seguinte não sai.
  const parado = await ate(relogio, (a) => !a.emAndamento, 'o passo em andamento não terminou');
  const dia = (await poc()).dia;
  await esperar(2500);
  assert.equal((await poc()).dia, dia, 'pausado, o relógio não anda');
  assert.equal(parado.proximoEm, null);
  assert.equal((await chamar('POST', `${API}/pocs/${pocId}/relogio/automatico/pausar`)).status, 409);
  const auto = await trilha('poc.relogio_auto');
  const ultimas = auto.slice(-2);
  assert.deepEqual(ultimas.map((l) => [l.detalhes.acao, l.usuario]), [['retomar', ROOT], ['pausar', ROOT]]);
});

test('comando conta como passo: o dia fechado por comando não fecha de novo, e o passo seguinte espera o intervalo inteiro', async () => {
  const d0 = (await poc()).dia;
  const d1 = new Date(Date.parse(`${d0}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const d2 = new Date(Date.parse(`${d0}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  const r = await api('POST', `/pocs/${pocId}/relogio/automatico/retomar`, { intervaloSeg: 3 });
  assert.equal(r.diaAlvo, d0);
  const manual = await api('POST', `/pocs/${pocId}/relogio/fechar`, {});
  assert.equal(manual.dia, d1);
  const pulou = await ate(relogio, (a) => /já tinha fechado/.test(a.ultimoResumo ?? ''), 'o passo não percebeu o dia fechado por comando', 10000);
  assert.equal(pulou.diaAlvo, d1);
  assert.equal((await poc()).dia, d1, 'o passo não fechou outro dia no lugar');
  const passos = pulou.passos;
  const depois = await ate(poc, (p) => p.dia === d2, 'o passo seguinte não fechou o dia', 10000);
  assert.equal(depois.relogioAuto.passos, passos + 1);
  const fechados = (await trilha('poc.relogio')).map((l) => l.detalhes.de);
  assert.equal(new Set(fechados).size, fechados.length, 'nenhum dia aparece fechado duas vezes na trilha');
  // Mudar o intervalo rodando conta do último passo.
  const c = await api('PUT', `/pocs/${pocId}/relogio/automatico`, { intervaloSeg: 600 });
  assert.equal(c.intervaloSeg, 600);
  assert.ok(Date.parse(c.proximoEm) - Date.now() > 590000);
  await api('POST', `/pocs/${pocId}/relogio/automatico/pausar`);
});

test('subida do servidor: o relógio volta sozinho; depois de uma queda entre o fechamento e a anotação, o dia não fecha de novo', async () => {
  const d0 = (await poc()).dia;
  const d1 = new Date(Date.parse(`${d0}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const d2 = new Date(Date.parse(`${d0}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  await derrubarApp();
  // O estado que a queda deixa: o dia d0 fechou (o relógio da POC já está em d1), o passo não chegou a anotar (dia_alvo
  // ainda é d0), e a hora do passo passou com o servidor fora.
  const db = new DatabaseSync(path.join(dados, 'massgen.db'));
  db.prepare('UPDATE pocs SET dia = ? WHERE id = ?').run(d1, pocId);
  db.prepare("UPDATE relogios SET estado = 'rodando', intervalo_seg = 2, dia_alvo = ?, proximo_em = ?, pausado_por = NULL, pausado_em = NULL WHERE poc_id = ?")
    .run(d0, new Date(Date.now() - 60000).toISOString(), pocId);
  db.close();

  await subirApp();
  await ate(async () => app!.saida(), (s) => /Relógio automático retomado em 1 POC/.test(s), 'a subida não retomou o relógio', 5000);
  const subida = (await trilha('poc.relogio_auto')).at(-1);
  assert.equal(subida.detalhes.acao, 'subida');
  assert.equal(subida.detalhes.jaFechado, true);
  // O passo vencido sai logo e não fecha nada: o dia d0 já tinha fechado.
  const pulou = await ate(relogio, (a) => a.diaAlvo === d1 && /já tinha fechado/.test(a.ultimoResumo ?? ''), 'o passo da subida não acertou o dia', 10000);
  assert.equal((await poc()).dia, d1, 'o dia que fechou antes da queda não fechou de novo');
  assert.ok(Date.parse(pulou.proximoEm) > Date.now(), 'o seguinte espera o intervalo inteiro');
  // E o agendamento segue.
  await ate(poc, (p) => p.dia === d2, 'o relógio não seguiu depois da subida', 10000);

  // Uma queda comum, com o passo seguinte ainda no futuro: na volta, o relógio continua do mesmo ponto.
  await derrubarApp();
  await subirApp();
  const volta = (await trilha('poc.relogio_auto')).at(-1);
  assert.equal(volta.detalhes.acao, 'subida');
  assert.equal(volta.detalhes.jaFechado, false);
  const d3 = new Date(Date.parse(`${d2}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  await ate(poc, (p) => p.dia === d3, 'o relógio não voltou a andar depois da segunda subida', 10000);
  await api('POST', `/pocs/${pocId}/relogio/automatico/pausar`);
  const fechados = (await trilha('poc.relogio')).filter((l) => l.detalhes.automatico).map((l) => l.detalhes.de);
  assert.equal(new Set(fechados).size, fechados.length, 'nenhum dia fechou duas vezes');
});

test('apagar a POC com o relógio rodando leva o relógio junto; o servidor segue no ar', async () => {
  await api('POST', `/pocs/${pocId}/relogio/automatico/retomar`, { intervaloSeg: 1 });
  await esperar(1500);
  assert.equal((await chamar('DELETE', `${API}/pocs/${pocId}`)).status, 204);
  await esperar(2500);
  assert.equal((await chamar('GET', `${API}/pocs/${pocId}`)).status, 404);
  assert.equal((await chamar('GET', `${API}/saude`)).status, 200);
  assert.doesNotMatch(app!.saida(), /Relógio automático da POC .*:/, 'nenhum passo falhou depois da POC apagada');
});

// Etapa 3 da v4.3: a cobertura completa. Um lote de notas fictícias (valores redondos) fecha os 59 tipos: os 24 do IBS, os
// 26 da CBS e os 9 casos de transporte e falha, ligados um a um. Sobe o app e um SplitHub falso que faz o que a seção 07
// espera dele: baixa o que chega, pede de novo quando o link vence ou o processamento estoura, e pede o Arquivo Manual do
// dia sem Delta, da linha que faltou e de um período já entregue. No caminho: o plano automático e a prévia que não
// grava, a defasagem entre os entes, o XML que falta (D-MG-05), a nota ausente no SplitHub (T08), as regras do Arquivo
// Manual e a troca de roteiro de uma nota que já tem história.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fatiar, hashExtrato, type OperacaoDoDia } from '../server/emulacao/arquivo-ibs.ts';
import { lerZip } from '../server/emulacao/zip.ts';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PORTA_APP = 13947;
const PORTA_SPLITHUB = 13948;
const API = `http://localhost:${PORTA_APP}/api`;
const IBS = `http://localhost:${PORTA_APP}/entes/ibs`;
const CBS = `http://localhost:${PORTA_APP}/entes/cbs`;
const WEBHOOK = `http://localhost:${PORTA_SPLITHUB}/webhook/ibs`;
const RETORNO = `http://localhost:${PORTA_SPLITHUB}/retorno/cbs`;
const ROOT = 'root.poc@empresa.com.br';
const SENHA = 'senha-de-teste-123';
const dados = mkdtempSync(path.join(tmpdir(), 'massgen-cobertura-'));
const processos: ChildProcess[] = [];
let splithub: Server;

// ---------------------------------------------------------------- o lote (fictício, valores redondos)

const CLIENTE = '12345678000190';
const FORNECEDOR = '98765432000110';
const COMPRADOR = '11222333000144';

function chaveDe(cnpj: string, numero: number): string {
  const base = `352611${cnpj}55001${String(numero).padStart(9, '0')}1${String(numero).padStart(8, '0')}`;
  let soma = 0;
  let peso = 2;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const dv = 11 - (soma % 11);
  return base + (dv >= 10 ? 0 : dv);
}

interface Nfe { numero: number; emit: string; dest: string; ibs: number; cbs: number; dia?: string; fin?: string; ref?: string }

function nfe(o: Nfe): { chave: string; xml: string; numero: number } {
  const chave = chaveDe(o.emit, o.numero);
  const dia = o.dia ?? '2026-11-01';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00">
<ide><cUF>35</cUF><natOp>Venda</natOp><mod>55</mod><serie>1</serie><nNF>${o.numero}</nNF><dhEmi>${dia}T10:00:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>${o.fin ?? '1'}</finNFe>${o.ref ? `<NFref><refNFe>${o.ref}</refNFe></NFref>` : ''}</ide>
<emit><CNPJ>${o.emit}</CNPJ><xNome>Emitente ${o.numero}</xNome></emit><dest><CNPJ>${o.dest}</CNPJ><xNome>Destinatário ${o.numero}</xNome></dest>
<total><ICMSTot><vNF>100000.00</vNF></ICMSTot><IBSCBSTot><vBCIBSCBS>100000.00</vBCIBSCBS><gIBS><gIBSUF><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSUF>${(o.ibs * 0.6).toFixed(2)}</vIBSUF></gIBSUF><gIBSMun><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSMun>${(o.ibs * 0.4).toFixed(2)}</vIBSMun></gIBSMun><vIBS>${o.ibs.toFixed(2)}</vIBS></gIBS><gCBS><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vCBS>${o.cbs.toFixed(2)}</vCBS></gCBS></IBSCBSTot></total></infNFe></NFe>
<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${chave}</chNFe><dhRecbto>${dia}T10:00:05-03:00</dhRecbto><nProt>1352600000${o.numero}</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
  return { chave, xml, numero: o.numero };
}

function cancelamento(chave: string, dia: string): string {
  return `<procEventoNFe versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><evento versao="1.00"><infEvento Id="ID110111${chave}01"><chNFe>${chave}</chNFe><dhEvento>${dia}T09:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>135260000000001</nProt><xJust>Pedido refeito pelo cliente</xJust></detEvento></infEvento></evento><retEvento versao="1.00"><infEvento><cStat>135</cStat><chNFe>${chave}</chNFe><nProt>135260000000099</nProt></infEvento></retEvento></procEventoNFe>`;
}

// Oito notas de entrada e oito de saída: cinco comuns, uma com a complementar, uma cancelada e uma com a devolução de
// cada lado. Mais uma de entrada que o SplitHub não tem (T08).
const entrada = (n: number) => nfe({ numero: n, emit: FORNECEDOR, dest: CLIENTE, ibs: 2000, cbs: 1000 });
const saida = (n: number) => nfe({ numero: n, emit: CLIENTE, dest: COMPRADOR, ibs: 2000, cbs: 1000 });
const ENTRADAS = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009].map(entrada);
const SAIDAS = [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008].map(saida);
const E = (n: number) => ENTRADAS.find((x) => x.numero === n)!;
const S = (n: number) => SAIDAS.find((x) => x.numero === n)!;
const RELACIONADAS = [
  nfe({ numero: 1106, emit: FORNECEDOR, dest: CLIENTE, ibs: 200, cbs: 100, dia: '2026-11-02', fin: '2', ref: E(1006).chave }),
  nfe({ numero: 3008, emit: CLIENTE, dest: FORNECEDOR, ibs: 2000, cbs: 1000, dia: '2026-11-02', fin: '4', ref: E(1008).chave }),
  nfe({ numero: 2106, emit: CLIENTE, dest: COMPRADOR, ibs: 200, cbs: 100, dia: '2026-11-02', fin: '2', ref: S(2006).chave }),
  nfe({ numero: 4008, emit: COMPRADOR, dest: CLIENTE, ibs: 2000, cbs: 1000, dia: '2026-11-02', fin: '4', ref: S(2008).chave }),
];
const CANCELAMENTOS = [cancelamento(E(1007).chave, '2026-11-03'), cancelamento(S(2007).chave, '2026-11-03')];

// ---------------------------------------------------------------- unidade

test('fatiamento: a quebra do T05 tira a operação do arquivo no meio, mesmo cabendo, com o hash acumulado em cada parte', () => {
  const linhas = ['a', 'b', 'c'].map((id, i) => ({ linha: { ID: i + 1 }, hash: `h${i + 1}`, eventoId: id }));
  const ops: OperacaoDoDia[] = [{ cabecalho: { ID: 1 }, linhas }, { cabecalho: { ID: 2 }, linhas: [{ linha: { ID: 9 }, hash: 'h9', eventoId: 'z' }] }];
  assert.equal(fatiar(ops, 1000).length, 1);
  const f = fatiar(ops, 1000, 'a');
  assert.equal(f.length, 2);
  assert.deepEqual(f[0].operacoes.map((o) => [o.cabecalho.ID, o.eventos, o.hash]), [[1, ['a'], 'h1']]);
  assert.deepEqual(f[1].operacoes.map((o) => [o.cabecalho.ID, o.eventos, o.hash]), [[1, ['b', 'c'], 'h3'], [2, ['z'], 'h9']]);
  // Quebra no último lançamento da operação não abre arquivo novo.
  assert.equal(fatiar(ops, 1000, 'c').length, 1);
});

// ---------------------------------------------------------------- o SplitHub falso

interface ArquivoIbs { idSolic: number; tipo: string; nome: string; conteudo: any }
const avisosIbs: any[] = [];
const arquivosIbs: ArquivoIbs[] = [];
const avisosCbs: { endpoint: string | null; corpo: any }[] = [];
const downloadsCbs: { tiquete: string; endpoint: string | null; status: number }[] = [];
let ocupado = 0;
let cookie = '';
let pocId = '';
let credIbs = { clientId: '', clientSecret: '' };
let credCbs = { clientId: '', clientSecret: '' };
const notas: Record<string, any> = {};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const doIbs = () => ({ clientid: credIbs.clientId, clientsecret: credIbs.clientSecret });

function subir(arquivo: string, env: Record<string, string>, pronto: RegExp): Promise<{ saida: () => string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [arquivo], { cwd: RAIZ, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    processos.push(p);
    let saida = '';
    const ok = (b: Buffer) => { saida += b; if (pronto.test(saida)) resolve({ saida: () => saida }); };
    p.stdout!.on('data', ok);
    p.stderr!.on('data', (b) => { saida += b; });
    p.on('exit', (c) => reject(new Error(`${arquivo} saiu com ${c}: ${saida}`)));
    setTimeout(() => reject(new Error(`${arquivo} não subiu: ${saida}`)), 15000);
  });
}

async function chamar(metodo: string, url: string, op: { corpo?: unknown; cabecalhos?: Record<string, string>; form?: Record<string, string> } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: { 'content-type': op.form ? 'application/x-www-form-urlencoded' : 'application/json', ...(cookie && url.startsWith(API) ? { cookie } : {}), ...op.cabecalhos },
    body: op.form ? new URLSearchParams(op.form).toString() : op.corpo === undefined ? undefined : JSON.stringify(op.corpo),
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

// A Nova Solicitação do MOC é um GET com corpo; o fetch não manda corpo em GET, o node:http manda.
function getComCorpo(url: string, cabecalhos: Record<string, string>, corpo: unknown): Promise<{ status: number; corpo: any }> {
  return new Promise((resolve, reject) => {
    const texto = JSON.stringify(corpo);
    const r = request(url, { method: 'GET', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(texto), ...cabecalhos } }, async (res) => {
      let t = '';
      for await (const c of res) t += c;
      resolve({ status: res.statusCode!, corpo: t ? JSON.parse(t) : undefined });
    });
    r.on('error', reject);
    r.end(texto);
  });
}

const manual = (ini: string, fim: string, cnpj = CLIENTE) => getComCorpo(`${IBS}/v1/aassist/solicitacao/incluir`, doIbs(), { cnpj, dataTransacaoIni: ini, dataTransacaoFim: fim });

async function tokenCbs(): Promise<string> {
  const r = await chamar('POST', `${CBS}/token`, { form: { grant_type: 'client_credentials', client_id: credCbs.clientId, client_secret: credCbs.clientSecret } });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  return r.corpo.access_token;
}

// Uma urlRetorno por endpoint: o aviso de erro da documentação não traz o tíquete, e é assim que o SplitHub sabe qual pedido falhou.
const pedirCbs = async (endpoint: string) =>
  chamar('POST', `${CBS}/apuracao-cbs/v2/${endpoint}/12345678`, { cabecalhos: { authorization: `Bearer ${await tokenCbs()}` }, corpo: { urlRetorno: `${RETORNO}?endpoint=${endpoint}` } });

// Responde 2xx, baixa o que veio e, na CBS, pede de novo quando o link vence (T02) ou o processamento estoura (T03).
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
        avisosIbs.push(corpo);
        for (const a of corpo.arquivos) {
          const r = await fetch(`${IBS}/v1/aassist/arquivo/${a.nomeArq}`, { headers: doIbs() });
          if (r.status !== 200) continue;
          const [json] = lerZip(Buffer.from(await r.arrayBuffer()));
          arquivosIbs.push({ idSolic: corpo.idSolic, tipo: corpo.tipoSolic, nome: a.nomeArq, conteudo: JSON.parse(json.dados.toString('utf8')) });
        }
      } else if (u.pathname === '/retorno/cbs') {
        const endpoint = u.searchParams.get('endpoint');
        avisosCbs.push({ endpoint, corpo });
        if (corpo.codigoErro && endpoint) await pedirCbs(endpoint);
        else if (corpo.urlAssinada) {
          const r = await fetch(corpo.urlAssinada);
          await r.arrayBuffer();
          downloadsCbs.push({ tiquete: corpo.tiqueteSolicitacao, endpoint, status: r.status });
          if (r.status === 410 && endpoint) await pedirCbs(endpoint);
        }
      }
    } finally {
      ocupado--;
    }
  });
  return new Promise((r) => splithub.listen(PORTA_SPLITHUB, r));
}

// Espera o SplitHub falso parar de trabalhar (avisos que chegam em segundo plano incluídos).
async function calmo(): Promise<void> {
  let quietos = 0;
  for (let i = 0; i < 200 && quietos < 6; i++) {
    await esperar(100);
    quietos = ocupado === 0 ? quietos + 1 : 0;
  }
}

async function ate(cond: () => boolean | Promise<boolean>, msg: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await esperar(100);
  }
  throw new Error(msg);
}

const fechar = async () => { const r = await api('POST', `/pocs/${pocId}/relogio/fechar`, {}); await calmo(); return r; };
const cobertura = () => api(`GET`, `/pocs/${pocId}/cobertura`);

before(async () => {
  await subirSplitHub();
  const app = await subir('server/main.ts', {
    PORT: String(PORTA_APP), MASSGEN_DATA_DIR: dados, ALLOWED_DESTINATION_DOMAINS: 'localhost', MASSGEN_HOST: '', MASSGEN_CONFIAR_CLOUDFLARE_ACCESS: 'false',
    MASSGEN_ROOTS: ROOT, MASSGEN_URL_PUBLICA: `http://localhost:${PORTA_APP}`, MASSGEN_COOKIE_SEGURO: 'false', MASSGEN_AVISO_ESPERAS_MS: '50,50',
  }, /MassGen no ar/);
  let link = '';
  for (let i = 0; i < 50 && !link; i++) {
    link = /Primeiro acesso de root\.poc@empresa\.com\.br: (\S+)/.exec(app.saida())?.[1] ?? '';
    if (!link) await esperar(100);
  }
  const r = await fetch(`${API}/convites/${link.split('/convite/')[1]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nome: 'Root', senha: SENHA }) });
  cookie = r.headers.getSetCookie().find((c) => c.startsWith('massgen_sessao='))!.split(';')[0];
});

after(() => {
  for (const p of processos) p.kill();
  splithub?.close();
  rmSync(dados, { recursive: true, force: true });
});

// ---------------------------------------------------------------- ponta a ponta

test('POC: o lote entra inteiro, com as relacionadas ligadas e os dois cancelamentos; os dois entes apontam para o SplitHub falso', async () => {
  const r = await api('POST', '/pocs', { nome: 'POC Cobertura', cnpj: CLIENTE, competencia: '2026-11' });
  pocId = r.poc.id;
  credIbs = r.credenciais.find((c: any) => c.ente === 'ibs');
  credCbs = r.credenciais.find((c: any) => c.ente === 'cbs');
  const imp = await api('POST', `/pocs/${pocId}/notas`, {
    arquivos: [...ENTRADAS, ...SAIDAS, ...RELACIONADAS].map((n) => ({ nome: `${n.numero}.xml`, conteudo: n.xml }))
      .concat(CANCELAMENTOS.map((c, i) => ({ nome: `cancelamento-${i}.xml`, conteudo: c }))),
  });
  assert.equal(imp.aceitas, 21);
  assert.equal(imp.cancelamentos, 2);
  assert.equal(imp.ligadas, 4);
  for (const n of await api<any[]>('GET', `/pocs/${pocId}/notas`)) notas[n.numero] = n;
  const hab = await chamar('POST', `${IBS}/v1/aassist/habilitar`, { cabecalhos: doIbs(), corpo: { queroHabilitar: 'HAB', webhookUrl: WEBHOOK, tokenContrib: 'token-do-splithub' } });
  assert.equal(hab.status, 200);
  await api('PUT', `/pocs/${pocId}/cbs/url-retorno`, { urlRetorno: RETORNO });
  const c = await cobertura();
  assert.equal(c.meta, 50, 'sem caso ligado, a meta é a dos dois catálogos');
  assert.equal(c.recebidos, 0);
  assert.equal(c.ibs.length, 24);
  assert.equal(c.cbs.length, 26);
  assert.deepEqual(c.faltam, [], 'o lote tem todos os XMLs que os tipos pedem');
  assert.ok(c.ibs.every((l: any) => l.situacao === 'sem nota no plano'));
});

test('D-MG-05 e defasagem: o painel diz qual XML falta; a CBS anda dias depois do IBS (ou antes), pela POC ou pelo roteiro', async () => {
  const r = await api('POST', '/pocs', { nome: 'POC Uma Nota', cnpj: CLIENTE, competencia: '2026-11' });
  const id = r.poc.id;
  await api('POST', `/pocs/${id}/notas`, { arquivos: [{ nome: 'uma.xml', conteudo: entrada(1001).xml }] });
  const c = await api('GET', `/pocs/${id}/cobertura`);
  const devolucao = c.faltam.find((f: any) => f.xml === 'uma NF-e de devolução de uma nota de entrada');
  assert.ok(devolucao, JSON.stringify(c.faltam.map((f: any) => f.xml)));
  assert.equal(devolucao.texto, 'Para cobrir E-IBS-19 e E-IBS-20, o lote precisa de uma NF-e de devolução de uma nota de entrada.');
  // O D07 aceita qualquer das três relacionadas, dos dois lados: a frase dele lista as alternativas.
  const d07 = c.faltam.find((f: any) => f.tipos.includes('E-CBS-D07'));
  assert.match(d07.xml, /o XML do cancelamento de uma nota de entrada ou .*uma NF-e complementar de uma nota de saída/);
  assert.equal(c.ibs.find((l: any) => l.id === 'E-IBS-19').situacao, 'falta nota de devolução');
  assert.equal(c.ibs.find((l: any) => l.id === 'E-IBS-02').situacao, 'falta nota de saída');
  assert.equal(c.cbs.find((l: any) => l.id === 'E-CBS-C04').situacao, 'sem nota no plano', 'a nota de entrada que há cobre o RT-A7');
  const nota = (await api<any[]>('GET', `/pocs/${id}/notas`))[0].id;
  await api('PUT', `/pocs/${id}`, { defasagemCbs: 2 });
  const dias = (p: any, ente: string) => p.itens.filter((i: any) => i.ente === ente).map((i: any) => i.dia).sort();
  const p1 = await api('POST', `/pocs/${id}/roteiros/previa`, { notaIds: [nota], roteiro: 'RT-A1' });
  assert.equal(p1.defasagem, 2);
  assert.deepEqual(dias(p1, 'ibs'), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.deepEqual(dias(p1, 'cbs'), ['2026-11-03', '2026-11-04', '2026-11-05']);
  const p2 = await api('POST', `/pocs/${id}/roteiros/previa`, { notaIds: [nota], roteiro: 'RT-A1', defasagem: -1 });
  assert.equal(dias(p2, 'ibs')[0], '2026-11-02');
  assert.equal(dias(p2, 'cbs')[0], '2026-11-01');
  const ruim = await chamar('PUT', `${API}/pocs/${id}`, { corpo: { defasagemCbs: 31 } });
  assert.equal(ruim.status, 400);
  await api('DELETE', `/pocs/${id}`);
});

test('casos: desligados por padrão; ligar põe na meta e arma a provocação; o que nasce do uso não arma', async () => {
  let c = await cobertura();
  assert.equal(c.casos.length, 9);
  assert.ok(c.casos.every((x: any) => !x.ligado && x.situacao === 'desligado'));
  for (const caso of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09']) await api('PUT', `/pocs/${pocId}/casos/${caso}`, { ligado: true });
  c = await cobertura();
  assert.equal(c.meta, 59);
  const caso = (id: string) => c.casos.find((x: any) => x.id === id);
  assert.deepEqual(caso('T09').armado, ['ibs', 'cbs']);
  assert.deepEqual(caso('T02').armado, ['cbs']);
  assert.deepEqual(caso('T05').armado, ['ibs']);
  assert.deepEqual(caso('T01').armado, []);
  assert.match(caso('T05').situacao, /^armado · espera a próxima oportunidade no IBS/);
  assert.match(caso('T04').situacao, /^espera o SplitHub: um arquivo manual baixado/i);
  const r = await chamar('PUT', `${API}/pocs/${pocId}/casos/T04`, { corpo: { rearmar: true } });
  assert.equal(r.status, 409);
  assert.equal((await chamar('PUT', `${API}/pocs/${pocId}/casos/T10`, { corpo: { ligado: true } })).status, 404);
});

test('T08: a nota ausente no SplitHub não sai sem "incluir não importadas"', async () => {
  const id = notas['1009'].id;
  const m = await api('PUT', `/pocs/${pocId}/notas/splithub`, { notaIds: [id], splithub: 'ausente' });
  assert.equal(m.notas, 1);
  assert.equal((await api<any[]>('GET', `/pocs/${pocId}/notas?splithub=ausente`)).length, 1);
  const sem = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [id], tipos: ['E-IBS-01'] });
  assert.equal(sem.itens.length, 0);
  assert.match(sem.bloqueios[0].motivo, /não está no SplitHub.*T08/);
  const com = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [id], tipos: ['E-IBS-01'], incluirAusentes: true });
  assert.equal(com.itens.length, 1);
  const rot = await api('POST', `/pocs/${pocId}/roteiros/previa`, { notaIds: [id], roteiro: 'RT-A1' });
  assert.equal(rot.itens.length, 0);
});

test('plano: a prévia não grava; o plano dá a cada nota o roteiro que cobre o que falta e põe os 50 tipos no plano', async () => {
  const antes = await api<any[]>('GET', `/pocs/${pocId}/envios`);
  const previa = await api('POST', `/pocs/${pocId}/plano/previa`, {});
  assert.equal(previa.notas, 17);
  assert.equal((await api<any[]>('GET', `/pocs/${pocId}/envios`)).length, antes.length, 'a prévia desfaz');
  assert.ok((await cobertura()).ibs.every((l: any) => l.notas === 0));
  const plano = await api('POST', `/pocs/${pocId}/plano`, {});
  assert.deepEqual(
    plano.envios.map((e: any) => [e.roteiro, e.intervalo, e.inicio, e.notas.length]),
    previa.envios.map((e: any) => [e.roteiro, e.intervalo, e.inicio, e.notas.length]),
    'a prévia mostra o que o plano grava',
  );
  const roteiroDe = (n: number) => plano.envios.find((e: any) => e.notas.some((x: any) => x.id === notas[String(n)].id))?.roteiro;
  // A nota rara usa o roteiro que pede o que ela tem.
  assert.equal(roteiroDe(1006), 'RT-A4');
  assert.equal(roteiroDe(1007), 'RT-A5');
  assert.equal(roteiroDe(1008), 'RT-A6');
  assert.equal(roteiroDe(2006), 'RT-F5');
  assert.equal(roteiroDe(2007), 'RT-F6');
  assert.equal(roteiroDe(2008), 'RT-F7');
  // A ausente (T08) vai pelos dois entes; tudo já coberto, o caminho feliz.
  assert.equal(roteiroDe(1009), 'RT-A1');
  // T05 e T07 ligados: duas operações com dois lançamentos no mesmo dia, uma em cada dia.
  const juntos = plano.envios.filter((e: any) => e.intervalo === 0);
  assert.deepEqual(juntos.map((e: any) => e.inicio).sort(), ['2026-11-01', '2026-11-02']);
  const c = plano.cobertura;
  for (const l of [...c.ibs, ...c.cbs]) assert.ok(l.notas > 0, `${l.id} ficou fora do plano`);
  assert.ok(c.ibs.every((l: any) => l.situacao.startsWith('planejado · dia ')));
  assert.equal(c.notasLivres, 0);
  // Refazer libera as 17 (nada saiu ainda) e monta de novo; na prévia, nada muda.
  const refazer = await api('POST', `/pocs/${pocId}/plano/previa`, { refazer: true });
  assert.equal(refazer.liberadas.notas, 17);
  assert.equal(refazer.notas, 17);
  assert.equal((await cobertura()).notasLivres, 0);
  const sem = await chamar('POST', `${API}/pocs/${pocId}/plano`, { corpo: {} });
  assert.equal(sem.status, 422, 'sem nota livre, nada a planejar');
});

test('dia 1: T05 fatia uma operação em dois arquivos do Delta; T09 descarta o primeiro 2xx e repete o mesmo aviso, nos dois entes', async () => {
  const r = await fechar();
  const delta = r.processados.find((p: any) => p.tipo === 'DIFERENCIAL');
  assert.equal(delta.provocado.caso, 'T05');
  assert.ok(delta.arquivos.length >= 2);
  assert.equal(delta.aviso.resultado, 'ok');
  assert.equal(delta.aviso.tentativas, 2, 'T09: o 2xx descartado e o repetido');
  const doDelta = arquivosIbs.filter((a) => a.idSolic === delta.idSolic);
  const nomes = new Set(doDelta.map((a) => a.nome));
  assert.equal(nomes.size, delta.arquivos.length, 'o SplitHub baixou todas as partes');
  const porOperacao = new Map<number, number>();
  for (const a of doDelta.filter((x, i, l) => l.findIndex((y) => y.nome === x.nome) === i)) {
    for (const op of a.conteudo.header.operacoes) porOperacao.set(op.ID, (porOperacao.get(op.ID) ?? 0) + 1);
  }
  assert.ok([...porOperacao.values()].some((n) => n === 2), 'uma operação em dois arquivos');
  assert.equal(avisosIbs.filter((a) => a.idSolic === delta.idSolic).length, 2, 'o SplitHub recebeu o mesmo aviso duas vezes');
  const cbs = r.cbs[0];
  assert.ok(cbs.avisos.some((a: any) => a.tentativas === 2));
  const aviso = await api('GET', `/pocs/${pocId}/avisos/${delta.aviso.id}`);
  assert.equal(aviso.chamadas[0].status, 200);
  assert.match(aviso.chamadas[0].erro, /^T09: o MassGen descartou/);
  const c = await cobertura();
  const caso = (id: string) => c.casos.find((x: any) => x.id === id);
  assert.equal(caso('T05').coberto, true);
  assert.equal(caso('T09').coberto, true);
  assert.deepEqual(caso('T05').armado, [], 'a provocação sai uma vez e desarma');
});

test('dias 2 e 3: T07 tira uma linha do Delta e o hash não fecha sem ela; T06 deixa um dia inteiro sem Delta', async () => {
  const r2 = await fechar();
  const delta = r2.processados.find((p: any) => p.tipo === 'DIFERENCIAL');
  assert.equal(delta.provocado.caso, 'T07');
  const bar = await api('GET', `/pocs/${pocId}/barramento`);
  const t07 = bar.provocacoes.find((p: any) => p.caso === 'T07');
  assert.equal(bar.solicitacoes.find((s: any) => s.idSolic === delta.idSolic).provocacao, 'T07');
  const arquivo = arquivosIbs.find((a) => a.idSolic === delta.idSolic)!;
  const op = arquivo.conteudo.header.operacoes.find((o: any) => o.ID === t07.detalhe.operacao);
  assert.ok(op.extrato_cc.lista.every((l: any) => l.ID !== t07.detalhe.lancamento), 'a linha omitida não está no arquivo');
  // O SplitHub recalcula o hash da operação nova com as linhas que recebeu: não fecha.
  const recalculado = op.extrato_cc.lista.reduce((h: string | null, l: any) => hashExtrato(h, l), null);
  assert.notEqual(recalculado, op.extrato_cc.hash);
  const r3 = await fechar();
  const semDelta = r3.processados.find((p: any) => p.tipo === 'DIFERENCIAL');
  assert.equal(semDelta.semDelta, true);
  assert.equal(semDelta.provocado.caso, 'T06');
  assert.equal(semDelta.arquivos.length, 0);
  assert.equal(avisosIbs.filter((a) => a.dataHoraTransIni?.startsWith('2026-11-03')).length, 0, 'nenhum aviso do dia sem Delta');
  const c = await cobertura();
  assert.match(c.casos.find((x: any) => x.id === 'T06').situacao, /^provocado · espera o SplitHub: perceber a falta/);
});

test('Arquivo Manual: as regras do pedido, o cancelamento e a entrega no Processamento Diário seguinte (T04, T06, T07)', async () => {
  // Recusas: outro contribuinte, duas competências, dia ainda não processado.
  assert.equal((await manual('2026-11-01', '2026-11-01', COMPRADOR)).status, 400);
  assert.equal((await manual('2026-10-31', '2026-11-01')).status, 400);
  const futuro = await manual('2026-11-04', '2026-11-05');
  assert.equal(futuro.status, 400);
  assert.match(futuro.corpo.mensagem, /dia simulado/);
  // O dia sem Delta e a linha que faltou, num pedido só; e um período já entregue (T04).
  const um = await manual('2026-11-02', '2026-11-03');
  assert.equal(um.status, 200, JSON.stringify(um.corpo));
  assert.equal(um.corpo.tipoSolicitacao, 'MANUAL');
  assert.equal(um.corpo.sitSolicitacao, 'SOLICITADA');
  const sobreposto = await manual('2026-11-03', '2026-11-03');
  assert.equal(sobreposto.status, 409);
  // A query também serve, para quem não manda corpo num GET.
  const dois = await chamar('GET', `${IBS}/v1/aassist/solicitacao/incluir?cnpj=${CLIENTE.slice(0, 8)}&dataTransacaoIni=2026-11-01&dataTransacaoFim=2026-11-01`, { cabecalhos: doIbs() });
  assert.equal(dois.status, 200, JSON.stringify(dois.corpo));
  const tres = await manual('2026-11-04', '2026-11-04');
  assert.equal(tres.status, 429, 'duas por dia');
  const lista = await chamar('GET', `${IBS}/v1/aassist/solicitacao/listar/2026-11-01&2026-11-30&solicitada`, { cabecalhos: doIbs() });
  assert.deepEqual(lista.corpo.itens.map((i: any) => [i.tipoSolic, i.idSolic]).sort(), [['MANUAL', um.corpo.IdSolicitacao], ['MANUAL', dois.corpo.IdSolicitacao]].sort());
  // Cancelamento: só a manual SOLICITADA; o Delta não; a que não existe, 404.
  const delta = (await api('GET', `/pocs/${pocId}/barramento`)).solicitacoes.find((s: any) => s.tipo === 'DIFERENCIAL');
  assert.equal((await chamar('DELETE', `${IBS}/v1/aassist/solicitacao/cancelamento/${delta.idSolic}`, { cabecalhos: doIbs() })).status, 409);
  assert.equal((await chamar('DELETE', `${IBS}/v1/aassist/solicitacao/cancelamento/1`, { cabecalhos: doIbs() })).status, 404);
  const r = await fechar();
  const manuais = r.processados.filter((p: any) => p.tipo === 'MANUAL');
  assert.equal(manuais.length, 2);
  assert.ok(manuais.every((m: any) => m.aviso.resultado === 'ok'));
  assert.equal((await chamar('DELETE', `${IBS}/v1/aassist/solicitacao/cancelamento/${um.corpo.IdSolicitacao}`, { cabecalhos: doIbs() })).status, 409, 'já processada');
  const baixado = arquivosIbs.find((a) => a.idSolic === um.corpo.IdSolicitacao)!;
  assert.equal(baixado.tipo, 'MANUAL');
  assert.equal(baixado.conteudo.header.tiposolicitacao, 'solicitação manual');
  assert.equal(baixado.conteudo.header.parametrosgeracao.datainicial, '2026-11-02 00:00:00');
  // No dia novo: a cancelada não conta no limite nem na sobreposição; a manual já entregue ainda conta na sobreposição.
  const a = await manual('2026-11-04', '2026-11-04');
  assert.equal(a.status, 200);
  const cancelada = await chamar('DELETE', `${IBS}/v1/aassist/solicitacao/cancelamento/${a.corpo.IdSolicitacao}`, { cabecalhos: doIbs() });
  assert.equal(cancelada.status, 200);
  assert.equal(cancelada.corpo.sitSolicitacao, 'CANCELADA');
  assert.equal((await manual('2026-11-04', '2026-11-04')).status, 200);
  assert.equal((await manual('2026-11-02', '2026-11-02')).status, 409, 'o período da manual enviada');
  assert.equal((await manual('2026-11-05', '2026-11-05')).status, 200);
  assert.equal((await manual('2026-10-30', '2026-10-31')).status, 429, 'duas por dia, em qualquer competência');
  const c = await cobertura();
  const caso = (id: string) => c.casos.find((x: any) => x.id === id);
  assert.equal(caso('T04').coberto, true, 'o Manual repetiu lançamentos do Delta baixado');
  assert.equal(caso('T06').coberto, true, 'o dia sem Delta chegou pelo Manual');
  assert.equal(caso('T07').coberto, true, 'a linha que faltou chegou pelo Manual');
});

test('T03 e T02: o pedido estoura com APURACAO-408, o novo nasce com o link vencido (410), e o terceiro chega', async () => {
  const r = await pedirCbs('creditos');
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  await ate(() => downloadsCbs.some((d) => d.endpoint === 'creditos' && d.status === 200), 'o SplitHub não conseguiu baixar os créditos');
  await calmo();
  const erro = avisosCbs.find((a) => a.endpoint === 'creditos' && a.corpo.codigoErro);
  assert.deepEqual(erro!.corpo, { codigoErro: 'APURACAO-408', mensagemErro: 'Tempo limite de processamento excedido (240 minutos).' });
  assert.ok(downloadsCbs.some((d) => d.endpoint === 'creditos' && d.status === 410));
  const bar = await api('GET', `/pocs/${pocId}/barramento`);
  const pedidos = bar.tiquetes.filter((t: any) => t.origem === 'pedido' && t.endpoint === 'creditos');
  assert.deepEqual(pedidos.map((t: any) => [t.estado, t.provocacao]).reverse(), [['ERRO', 'T03'], ['CONCLUIDA', 'T02'], ['CONCLUIDA', null]]);
  const c = await cobertura();
  assert.equal(c.casos.find((x: any) => x.id === 'T03').coberto, true);
  assert.equal(c.casos.find((x: any) => x.id === 'T02').coberto, true);
});

test('o lote fecha os 59 tipos: os 24 do IBS, os 26 da CBS e os 9 casos, cada um entregue e baixado pelo SplitHub', async () => {
  for (let i = 0; i < 20; i++) {
    const p = await api('GET', `/pocs/${pocId}`);
    if (!p.proximos.ibs && !p.proximos.cbs) break;
    await fechar();
  }
  const c = await cobertura();
  const faltando = [...c.ibs, ...c.cbs].filter((l: any) => !l.coberto).map((l: any) => `${l.id}: ${l.situacao}`);
  assert.deepEqual(faltando, []);
  assert.deepEqual(c.casos.filter((x: any) => !x.coberto).map((x: any) => `${x.id}: ${x.situacao}`), []);
  assert.equal(c.meta, 59);
  assert.equal(c.recebidos, 59);
  assert.deepEqual(c.porEnte.ibs, { meta: 24, recebidos: 24 });
  assert.deepEqual(c.porEnte.cbs, { meta: 26, recebidos: 26 });
  assert.equal(c.casos.find((x: any) => x.id === 'T08').coberto, true);
  assert.equal(c.casos.find((x: any) => x.id === 'T01').coberto, true);
});

test('troca de roteiro (D-MG-04): a prévia não grava; a nota com história continua dela, sem repetir o que já aconteceu', async () => {
  const id = notas['1001'].id;
  const antes = await api('GET', `/pocs/${pocId}/notas/${id}`);
  assert.equal(antes.nota.roteiro, 'RT-A7');
  const previa = await api('POST', `/pocs/${pocId}/notas/${id}/roteiro/previa`, { roteiro: 'RT-A1' });
  assert.equal(previa.continuacao, true);
  assert.ok(previa.pulados.some((p: any) => p.id === 'E-CBS-C01' && /já aconteceu/.test(p.motivo)), JSON.stringify(previa.pulados));
  assert.deepEqual([...new Set(previa.itens.filter((i: any) => i.ente === 'ibs').map((i: any) => i.id))], ['E-IBS-01', 'E-IBS-05', 'E-IBS-06']);
  assert.equal((await api('GET', `/pocs/${pocId}/notas/${id}`)).nota.roteiro, 'RT-A7', 'a prévia desfaz');
  const r = await api('POST', `/pocs/${pocId}/notas/${id}/roteiro`, { roteiro: 'RT-A1', intervaloDias: 0 });
  assert.equal(r.de, 'RT-A7');
  const depois = await api('GET', `/pocs/${pocId}/notas/${id}`);
  assert.equal(depois.nota.roteiro, 'RT-A1');
  assert.ok(depois.historico.filter((h: any) => h.situacao === 'planejado').length >= 3);
  // Com eventos planejados, trocar de novo substitui o que ainda não saiu.
  const outra = await api('POST', `/pocs/${pocId}/notas/${id}/roteiro`, { roteiro: 'RT-A2' });
  assert.ok(outra.substituidos >= 3);
  const ruim = await chamar('POST', `${API}/pocs/${pocId}/notas/${id}/roteiro`, { corpo: { roteiro: 'RT-F1' } });
  assert.equal(ruim.status, 422, 'roteiro de saída numa nota de entrada');
});

test('collection do IBS: a Nova Solicitação e o Cancelamento, com as decisões do emulador; a da CBS fala do aviso de erro', async () => {
  const ibs = await api('GET', `/pocs/${pocId}/collection`);
  const nomes = ibs.item.map((i: any) => i.name);
  assert.ok(nomes.includes('5.5 Nova Solicitação (Arquivo Manual)'));
  assert.ok(nomes.includes('5.6 Cancelamento de Solicitação'));
  const nova = ibs.item.find((i: any) => i.name.startsWith('5.5'));
  assert.equal(nova.request.method, 'GET');
  assert.deepEqual(Object.keys(JSON.parse(nova.request.body.raw)), ['cnpj', 'dataTransacaoIni', 'dataTransacaoFim']);
  assert.match(ibs.info.description, /2 por dia e 2 por competência/);
  const cbs = await api('GET', `/pocs/${pocId}/collection?ente=cbs`);
  assert.match(cbs.info.description, /Aviso de erro: .*codigoErro, mensagemErro/);
  assert.equal(JSON.stringify(ibs).includes(credIbs.clientSecret), false);
});

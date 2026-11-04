// Etapa 1 da v4.3: o IBS de ponta a ponta. Sobe o app e um SplitHub falso, que recebe o webhook do Comitê Gestor emulado
// e baixa cada arquivo. Uma nota de entrada percorre o RT-A1 e uma de saída o RT-F1; depois, o envio sob demanda,
// o pré-requisito, o forçar, o aviso que falha, o reenvio, o fatiamento e a substituição do planejado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { criarZip, lerZip } from '../server/emulacao/zip.ts';
import { lerDocumento, lerXml, dataHoraMoc } from '../server/emulacao/xml.ts';
import { fatiar, hashExtrato } from '../server/emulacao/arquivo-ibs.ts';
import { CATALOGO_IBS, ROTEIROS, TIPO_IBS, numeroIbs } from '../server/emulacao/catalogo.ts';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PORTA_APP = 13927;
const PORTA_SPLITHUB = 13928;
const API = `http://localhost:${PORTA_APP}/api`;
const ENTE = `http://localhost:${PORTA_APP}/entes/ibs`;
const ROOT = 'root.poc@empresa.com.br';
const SENHA = 'senha-de-teste-123';
const dados = mkdtempSync(path.join(tmpdir(), 'massgen-ibs-'));
const processos: ChildProcess[] = [];
let splithub: Server;

// ---------------------------------------------------------------- notas de teste (fictícias, valores redondos)

const CLIENTE = '12345678000190';
const FORNECEDOR = '98765432000110';
const COMPRADOR = '11222333000144';

function chaveDe(cnpj: string, numero: number, serie = 1): string {
  const base = `352611${cnpj}55${String(serie).padStart(3, '0')}${String(numero).padStart(9, '0')}1${String(numero).padStart(8, '0')}`;
  let soma = 0;
  let peso = 2;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const dv = 11 - (soma % 11);
  return base + (dv >= 10 ? 0 : dv);
}

interface Nfe { numero: number; emit: string; dest: string; ibs: number; dia?: string; fin?: string; ref?: string; amb?: string; semGrupo?: boolean; mod?: string }

function nfe(o: Nfe): { chave: string; xml: string } {
  const chave = chaveDe(o.emit, o.numero);
  const dia = o.dia ?? '2026-11-01';
  const ibs = o.ibs.toFixed(2);
  const uf = (o.ibs * 0.6).toFixed(2);
  const mun = (o.ibs * 0.4).toFixed(2);
  const grupo = o.semGrupo ? '' : `<IBSCBSTot><vBCIBSCBS>10000.00</vBCIBSCBS><gIBS><gIBSUF><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSUF>${uf}</vIBSUF></gIBSUF><gIBSMun><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSMun>${mun}</vIBSMun></gIBSMun><vIBS>${ibs}</vIBS></gIBS><gCBS><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vCBS>${(o.ibs * 0.9).toFixed(2)}</vCBS></gCBS></IBSCBSTot>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00">
<ide><cUF>35</cUF><natOp>Venda &amp; revenda</natOp><mod>${o.mod ?? '55'}</mod><serie>1</serie><nNF>${o.numero}</nNF><dhEmi>${dia}T10:00:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>${o.amb ?? '1'}</tpAmb><finNFe>${o.fin ?? '1'}</finNFe>${o.ref ? `<NFref><refNFe>${o.ref}</refNFe></NFref>` : ''}</ide>
<emit><CNPJ>${o.emit}</CNPJ><xNome>Emitente ${o.numero}</xNome></emit><dest><CNPJ>${o.dest}</CNPJ><xNome>Destinatário ${o.numero}</xNome></dest>
<total><ICMSTot><vNF>10000.00</vNF></ICMSTot>${grupo}</total></infNFe></NFe>
<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${chave}</chNFe><dhRecbto>${dia}T10:00:05-03:00</dhRecbto><nProt>1352600000${o.numero}</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
  return { chave, xml };
}

function cancelamento(chave: string, dia: string): string {
  return `<procEventoNFe versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><evento versao="1.00"><infEvento Id="ID110111${chave}01"><chNFe>${chave}</chNFe><dhEvento>${dia}T09:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>135260000000001</nProt><xJust>Pedido refeito pelo cliente</xJust></detEvento></infEvento></evento><retEvento versao="1.00"><infEvento><cStat>135</cStat><chNFe>${chave}</chNFe><nProt>135260000000099</nProt></infEvento></retEvento></procEventoNFe>`;
}

const ENTRADA = nfe({ numero: 1001, emit: FORNECEDOR, dest: CLIENTE, ibs: 1000 });
const SAIDA = nfe({ numero: 2001, emit: CLIENTE, dest: COMPRADOR, ibs: 2000 });
const COMPLEMENTAR = nfe({ numero: 1002, emit: FORNECEDOR, dest: CLIENTE, ibs: 100, dia: '2026-11-02', fin: '2', ref: ENTRADA.chave });
const ENTRADA_2 = nfe({ numero: 1003, emit: FORNECEDOR, dest: CLIENTE, ibs: 3000 });
const CANCELADA = nfe({ numero: 1004, emit: FORNECEDOR, dest: CLIENTE, ibs: 4000 });
const HOMOLOGACAO = nfe({ numero: 1005, emit: FORNECEDOR, dest: CLIENTE, ibs: 500, amb: '2' });
const SEM_GRUPO = nfe({ numero: 1006, emit: FORNECEDOR, dest: CLIENTE, ibs: 500, semGrupo: true });
const DE_OUTRO = nfe({ numero: 1007, emit: FORNECEDOR, dest: COMPRADOR, ibs: 500 });

// ---------------------------------------------------------------- unidades

test('XML: lê a NF-e com o grupo de IBS e CBS, a nota referenciada e o cancelamento', () => {
  const d = lerDocumento(COMPLEMENTAR.xml);
  assert.equal(d.tipo, 'nfe');
  if (d.tipo !== 'nfe') return;
  assert.equal(d.nota.chave, COMPLEMENTAR.chave);
  assert.equal(d.nota.finalidade, 'complementar');
  assert.deepEqual(d.nota.refChaves, [ENTRADA.chave]);
  assert.equal(d.nota.vIbs, 100);
  assert.equal(d.nota.vIbsUf, 60);
  assert.equal(d.nota.vIbsMun, 40);
  assert.equal(d.nota.emitCnpj, FORNECEDOR);
  const c = lerDocumento(cancelamento(CANCELADA.chave, '2026-11-05'));
  assert.equal(c.tipo, 'cancelamento');
  if (c.tipo === 'cancelamento') assert.equal(c.cancelamento.autorizado, true);
  assert.equal(lerXml('<a x="1 &lt; 2"><b>&#65;&amp;</b></a>').filhos[0].texto, 'A&');
  assert.equal(lerDocumento('<nada/>').tipo, 'outro');
  assert.equal(lerDocumento('<a><b></a>').tipo, 'outro');
  assert.equal(dataHoraMoc('2026-11-04T10:15:00-03:00'), '2026-11-04 10:15:00.000 -03:00');
});

test('ZIP: o que o MassGen compacta ele mesmo lê, igual a cada geração', () => {
  const a = criarZip([{ nome: 'a.json', dados: Buffer.from('{"x":1}') }, { nome: 'pasta/b.xml', dados: Buffer.from('<b/>'.repeat(1000)) }], '2026-11-15 01:30:00');
  const b = criarZip([{ nome: 'a.json', dados: Buffer.from('{"x":1}') }, { nome: 'pasta/b.xml', dados: Buffer.from('<b/>'.repeat(1000)) }], '2026-11-15 01:30:00');
  assert.ok(a.equals(b));
  const lido = lerZip(a);
  assert.deepEqual(lido.map((e) => e.nome), ['a.json', 'pasta/b.xml']);
  assert.equal(lido[1].dados.toString(), '<b/>'.repeat(1000));
});

test('catálogo: 24 tipos do IBS, com pré-requisitos que existem, e roteiros que só usam tipos do catálogo', () => {
  assert.equal(CATALOGO_IBS.length, 24);
  for (const t of CATALOGO_IBS) for (const alt of t.precisa) for (const x of alt) assert.ok(TIPO_IBS.has(x), `${t.id} precisa de ${x}`);
  for (const r of ROTEIROS) for (const p of r.ibs) assert.ok(TIPO_IBS.has(p.tipo), `${r.id} usa ${p.tipo}`);
  assert.equal(ROTEIROS.length, 17);
  assert.equal(numeroIbs('E-IBS-05'), '05');
  assert.equal(numeroIbs(5), '05');
  assert.equal(numeroIbs('E-IBS-25'), undefined);
});

test('fatiamento: o cabeçalho se repete, a lista leva a fatia e o hash é o acumulado até a fatia', () => {
  let h: string | null = null;
  const linhas = [1, 2, 3].map((i) => { const linha = { ID: i }; h = hashExtrato(h, linha); return { linha, hash: h, eventoId: `e${i}` }; });
  const f = fatiar([{ cabecalho: { ID: 9 }, linhas }], 2);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0].operacoes[0].cabecalho, f[1].operacoes[0].cabecalho);
  assert.equal(f[0].operacoes[0].lista.length, 2);
  assert.equal(f[0].operacoes[0].hash, linhas[1].hash);
  assert.equal(f[1].operacoes[0].hash, linhas[2].hash);
});

// ---------------------------------------------------------------- ponta a ponta

interface Recebido { token: string | undefined; corpo: any; arquivos: any[] }
const recebidos: Recebido[] = [];
let modoSplitHub: 'ok' | 'falha' = 'ok';
let credencial = { clientId: '', clientSecret: '' };

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

let cookie = '';

async function chamar(metodo: string, url: string, op: { corpo?: unknown; cabecalhos?: Record<string, string> } = {}) {
  const r = await fetch(url, {
    method: metodo, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...op.cabecalhos },
    body: op.corpo === undefined ? undefined : JSON.stringify(op.corpo),
  });
  const texto = await r.text();
  let corpo: any;
  try { corpo = texto ? JSON.parse(texto) : undefined; } catch { corpo = texto; }
  return { status: r.status, corpo, cabecalhos: r.headers };
}

async function api<T = any>(metodo: string, rota: string, corpo?: unknown): Promise<T> {
  const r = await chamar(metodo, API + rota, { corpo });
  if (r.status >= 400) throw new Error(`${metodo} ${rota} → ${r.status}: ${JSON.stringify(r.corpo)}`);
  return r.corpo as T;
}

const credenciais = () => ({ clientid: credencial.clientId, clientsecret: credencial.clientSecret });
// Os roteiros e o histórico trazem os dois entes; aqui só o IBS importa (a CBS está em cbs.test.ts).
const ibs = (x: any) => x.ente === 'ibs';

// O SplitHub falso: responde ao aviso e baixa cada arquivo depois, como um consumidor assíncrono.
function subirSplitHub(): Promise<void> {
  splithub = createServer(async (req, res) => {
    let texto = '';
    for await (const c of req) texto += c;
    if (modoSplitHub === 'falha') { res.writeHead(500, { 'content-type': 'application/json' }).end('{"erro":"fora do ar"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"recebido":true}');
    const corpo = JSON.parse(texto);
    const arquivos: any[] = [];
    for (const a of corpo.arquivos) {
      const r = await fetch(`${ENTE}/v1/aassist/arquivo/${a.nomeArq}`, { headers: credenciais() });
      const zip = Buffer.from(await r.arrayBuffer());
      const [json] = lerZip(zip);
      arquivos.push({ nome: json.nome, conteudo: JSON.parse(json.dados.toString('utf8')) });
    }
    recebidos.push({ token: req.headers.tokencontrib as string | undefined, corpo, arquivos });
  });
  return new Promise((r) => splithub.listen(PORTA_SPLITHUB, r));
}

async function esperarRecebidos(n: number): Promise<Recebido[]> {
  for (let i = 0; i < 100; i++) {
    if (recebidos.length >= n) return recebidos;
    await esperar(50);
  }
  throw new Error(`O SplitHub falso recebeu ${recebidos.length} de ${n} avisos.`);
}

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

let pocId = '';
const notas: Record<string, string> = {};

test('POC: credencial do IBS emulado mostrada uma vez, e o lote de XMLs separa o que entra do que fica de fora', async () => {
  const r = await api('POST', '/pocs', { nome: 'POC Exemplo', cnpj: '12.345.678/0001-90', competencia: '2026-11' });
  pocId = r.poc.id;
  credencial = r.credenciais.find((c: any) => c.ente === 'ibs');
  assert.deepEqual(r.credenciais.map((c: any) => c.ente), ['ibs', 'cbs'], 'as duas credenciais saem juntas, uma vez');
  assert.equal(r.poc.dia, '2026-11-01');
  assert.equal(r.poc.cnpjRaiz, '12345678');
  assert.match(credencial.clientSecret, /^[\w-]{20,}$/);
  assert.equal(JSON.stringify(await api('GET', `/pocs/${pocId}`)).includes(credencial.clientSecret), false, 'o segredo não volta');

  const zip = criarZip([ENTRADA, SAIDA, COMPLEMENTAR, ENTRADA_2, CANCELADA, HOMOLOGACAO, SEM_GRUPO, DE_OUTRO].map((n, i) => ({ nome: `nota${i}.xml`, dados: Buffer.from(n.xml) }))
    .concat([{ nome: 'leia-me.txt', dados: Buffer.from('oi') }]));
  const imp = await api('POST', `/pocs/${pocId}/notas`, {
    arquivos: [{ nome: 'lote.zip', conteudo: zip.toString('base64'), base64: true }, { nome: 'cancelamento.xml', conteudo: cancelamento(CANCELADA.chave, '2026-11-05') }],
  });
  assert.equal(imp.aceitas, 5);
  assert.equal(imp.fora, 3);
  assert.equal(imp.cancelamentos, 1);
  assert.equal(imp.ligadas, 1, 'a complementar se liga à original');
  const motivos = imp.itens.filter((i: any) => i.resultado === 'fora').map((i: any) => i.motivo).sort();
  assert.deepEqual(motivos, ['a nota não tem o grupo de IBS e CBS', 'nota de homologação', 'o CNPJ raiz 12345678 não está na nota como emitente nem como destinatário']);
  assert.ok(imp.itens.some((i: any) => i.resultado === 'ignorado' && i.motivo === 'não é XML'));
  const rep = await api('POST', `/pocs/${pocId}/notas`, { arquivos: [{ nome: 'de-novo.xml', conteudo: ENTRADA.xml }] });
  assert.equal(rep.repetidas, 1);

  for (const n of await api<any[]>('GET', `/pocs/${pocId}/notas`)) notas[n.numero] = n.id;
  const lista = await api<any[]>('GET', `/pocs/${pocId}/notas?papel=fornecedor`);
  assert.deepEqual(lista.map((n) => n.numero), ['2001']);
});

test('IBS emulado: credencial errada é 401; a habilitação pede HAB e webhook HTTPS ou local, na lista do app', async () => {
  const errada = await chamar('POST', `${ENTE}/v1/aassist/habilitar`, { cabecalhos: { clientid: credencial.clientId, clientsecret: 'errado' }, corpo: {} });
  assert.equal(errada.status, 401);
  const semHab = await chamar('POST', `${ENTE}/v1/aassist/habilitar`, { cabecalhos: credenciais(), corpo: { queroHabilitar: 'X', webhookUrl: 'https://a.b' } });
  assert.equal(semHab.status, 400);
  const fora = await chamar('POST', `${ENTE}/v1/aassist/habilitar`, { cabecalhos: credenciais(), corpo: { queroHabilitar: 'HAB', webhookUrl: 'https://splithub.exemplo.com/webhook' } });
  assert.equal(fora.status, 400);
  assert.match(fora.corpo.habilitado, /lista de domínios permitidos/);
  const http = await chamar('POST', `${ENTE}/v1/aassist/habilitar`, { cabecalhos: credenciais(), corpo: { queroHabilitar: 'HAB', webhookUrl: 'http://sandbox.exemplo/webhook' } });
  assert.match(http.corpo.habilitado, /HTTPS/);
  const ok = await chamar('POST', `${ENTE}/v1/aassist/habilitar`, {
    cabecalhos: credenciais(), corpo: { QueroHabilitar: 'HAB', webhookUrl: `http://localhost:${PORTA_SPLITHUB}/webhook/ibs`, tokenContrib: 'token-do-splithub' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  assert.equal(ok.corpo.habilitado, 'HABILITADO');
  assert.match(ok.corpo.dataHabilitacao, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  const poc = await api('GET', `/pocs/${pocId}`);
  assert.equal(poc.ibs.habilitado, true);
  assert.equal(poc.ibs.tokenContrib, true);
  const bar = await api('GET', `/pocs/${pocId}/barramento`);
  assert.equal(bar.chamadas.length, 4, 'a chamada com credencial errada não entra na POC');
  assert.equal(JSON.stringify(bar).includes('token-do-splithub'), false, 'o token não aparece nas chamadas');
});

test('RT-A1 e RT-F1: a entrada e a saída percorrem os roteiros, um Delta por dia, avisado e baixado pelo SplitHub', async () => {
  const a1 = await api('POST', `/pocs/${pocId}/roteiros`, { notaIds: [notas['1001']], roteiro: 'RT-A1' });
  assert.deepEqual(a1.itens.filter(ibs).map((i: any) => `${i.id}@${i.dia}`), ['E-IBS-01@2026-11-01', 'E-IBS-05@2026-11-02', 'E-IBS-06@2026-11-03']);
  const f1 = await api('POST', `/pocs/${pocId}/roteiros`, { notaIds: [notas['2001']], roteiro: 'RT-F1' });
  assert.deepEqual(f1.itens.filter(ibs).map((i: any) => `${i.id}@${i.dia}`), ['E-IBS-02@2026-11-01', 'E-IBS-09@2026-11-02']);
  const errado = await chamar('POST', `${API}/pocs/${pocId}/roteiros`, { corpo: { notaIds: [notas['2001']], roteiro: 'RT-A1' } });
  assert.equal(errado.status, 422);

  const r = await api('POST', `/pocs/${pocId}/relogio/fechar`, { ate: '2026-11-03' });
  assert.equal(r.dia, '2026-11-04');
  assert.equal(r.processados.length, 3);
  assert.ok(r.processados.every((p: any) => p.aviso.resultado === 'ok'));
  // Os downloads correm em paralelo: a ordem de chegada pode não ser a dos dias.
  const avisos = [...(await esperarRecebidos(3))].sort((a, b) => a.corpo.idSolic - b.corpo.idSolic);

  // Dia 1: um Delta com as duas operações; o aviso devolve o tokenContrib.
  const d1 = avisos[0];
  assert.equal(d1.token, 'token-do-splithub');
  assert.equal(d1.corpo.tipoSolic, 'DIFERENCIAL');
  assert.equal(d1.corpo.sitSolic, 'GERADA');
  assert.equal(d1.corpo.cnpj, CLIENTE);
  assert.equal(d1.corpo.dataHoraTransIni, '2026-11-01T00:00:00Z');
  assert.equal(d1.corpo.dataValidSolic, '2027-01-31T01:30:00Z', '90 dias depois de 02/11');
  assert.equal(d1.corpo.qtdOperSolic, 2);
  assert.match(d1.corpo.arquivos[0].nomeArq, /^aassist_2026-11_01_detalhada_\d+_parte001\.zip$/);
  const h1 = d1.arquivos[0].conteudo.header;
  assert.equal(h1.tiposolicitacao, 'diferencial(delta)');
  assert.equal(h1.nomearquivo, d1.arquivos[0].nome);
  assert.equal(h1.parametrosgeracao.datainicial, '2026-11-01 00:00:00');
  assert.equal(h1.parametrosgeracao.qtdoperacoes, 2);
  const entrada = h1.operacoes.find((o: any) => o.CHAVE_ACESSO === ENTRADA.chave);
  const saida = h1.operacoes.find((o: any) => o.CHAVE_ACESSO === SAIDA.chave);
  assert.equal(entrada.CNPJ_FORNECEDOR, '98765432');
  assert.equal(entrada.CNPJ_ADQUIRENTE, '12345678');
  assert.equal(entrada.DTH_EMISSAO, '2026-11-01 10:00:00.000 -03:00');
  assert.equal(entrada.extrato_cc.lista[0].MOV, 'Aquisicao');
  assert.equal(entrada.extrato_cc.lista[0].CREDITO_A_PROPRIAR, 1000);
  assert.equal(entrada.extrato_cc.lista[0].DEBITO_EM_ABERTO, 0, 'campo vazio vem com 0');
  assert.equal(saida.extrato_cc.lista[0].MOV, 'Fornecimento');
  assert.equal(saida.extrato_cc.lista[0].DEBITO_EM_ABERTO, 2000);

  // O hash do extrato encadeia os lançamentos da operação de um dia para o outro.
  const linhasEntrada = avisos.flatMap((a) => a.arquivos.flatMap((f) => f.conteudo.header.operacoes.filter((o: any) => o.ID === entrada.ID)));
  let h: string | null = null;
  for (const op of linhasEntrada) { for (const l of op.extrato_cc.lista) h = hashExtrato(h, l); assert.equal(op.extrato_cc.hash, h); }
  const movs = linhasEntrada.flatMap((o) => o.extrato_cc.lista.map((l: any) => `${l.MOV}:${l.CREDITO_A_PROPRIAR}/${l.CREDITO_NAO_UTILIZADO}/${l.CREDITO_UTILIZADO}`));
  assert.deepEqual(movs, ['Aquisicao:1000/0/0', 'Apropriacao de Credito:-1000/1000/0', 'Utilizacao de Credito:0/-1000/1000']);
  const extincao = avisos[1].arquivos[0].conteudo.header.operacoes.find((o: any) => o.CHAVE_ACESSO === SAIDA.chave).extrato_cc.lista[0];
  assert.equal(extincao.MOV, 'Extincao por Recolhimento');
  assert.equal(extincao.DEBITO_EM_ABERTO, -2000);
  assert.equal(extincao.DEBITO_EXTINTO, 2000);

  await esperar(100);
  const nota = await api('GET', `/pocs/${pocId}/notas/${notas['1001']}`);
  const doIbs = nota.historico.filter(ibs);
  assert.deepEqual(doIbs.map((e: any) => `${e.tipo}:${e.situacao}`), ['E-IBS-01:recebido', 'E-IBS-05:recebido', 'E-IBS-06:recebido']);
  assert.equal(doIbs[0].arquivo.downloads.total, 1);
  assert.equal(doIbs[0].arquivo.aviso.status, 200);
  assert.deepEqual(Object.fromEntries(nota.saldos.map((s: any) => [s.campo, s.noEnte])), { RFDT: 0, RFAT: 0, CAP: 0, CNU: 0, CU: 1000, DEA: 0, DEX: 0 });

  const lista = await chamar('GET', `${ENTE}/v1/aassist/solicitacao/listar/2026-11-01&2026-11-30&todas`, { cabecalhos: credenciais() });
  assert.equal(lista.status, 200);
  assert.equal(lista.corpo.itens.length, 3);
  assert.ok(lista.corpo.itens.every((s: any) => s.sitSolic === 'ENVIADA' && s.arquivos[0].nome));
  assert.equal(lista.cabecalhos.get('tokencontrib'), 'token-do-splithub');
});

test('envio sob demanda: nota relacionada, pré-requisito incluído antes, papel, saldo e o dia fechado na hora', async () => {
  // A complementar da 1001 só cabe pelo tipo 03; marcar a própria complementar leva à operação original.
  const p1 = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [notas['1002']], tipos: ['E-IBS-03', 'E-IBS-02'] });
  assert.deepEqual(p1.itens.map((i: any) => [i.id, i.valor, i.relNota]), [['E-IBS-03', 100, 'NF-e 1.002']]);
  assert.match(p1.bloqueios[0].motivo, /só em nota de saída/);

  // A 1003 não teve evento: escolher só a utilização inclui a aquisição e a apropriação antes.
  const p2 = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [notas['1003']], tipos: [{ tipo: 'E-IBS-06', pct: 50 }] });
  assert.deepEqual(p2.itens.map((i: any) => [i.id, i.origem, i.valor]), [['E-IBS-01', 'pre-requisito', 3000], ['E-IBS-05', 'pre-requisito', 3000], ['E-IBS-06', 'escolhido', 1500]]);

  // Sem saldo: a 1001 já usou todo o crédito.
  const p3 = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [notas['1001']], tipos: ['E-IBS-06'] });
  assert.equal(p3.itens.length, 0);
  assert.match(p3.bloqueios[0].motivo, /sem saldo/);

  // Cancelamento: a 1004 tem o XML do cancelamento, de 05/11; o relógio está em 04/11.
  const p4 = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [notas['1004']], tipos: ['E-IBS-15'] });
  assert.match(p4.bloqueios.at(-1).motivo, /relógio está em 04\/11/);

  const antes = recebidos.length;
  const r = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1002'], notas['1003']], tipos: ['E-IBS-03', { tipo: 'E-IBS-06', pct: 50 }] });
  assert.equal(r.envio.numero, 3);
  assert.equal(r.fechamento.dia, '2026-11-05', 'D-MG-14: o dia fecha na hora');
  assert.equal(r.fechamento.processados[0].lancamentos, 4);
  const [aviso] = (await esperarRecebidos(antes + 1)).slice(antes);
  assert.equal(aviso.corpo.qtdOperSolic, 2);
  const movs = aviso.arquivos[0].conteudo.header.operacoes.flatMap((o: any) => o.extrato_cc.lista.map((l: any) => l.MOV));
  assert.deepEqual(movs, ['Complemento de Aquisicao', 'Aquisicao', 'Apropriacao de Credito', 'Utilizacao de Credito']);
  const envios = await api<any[]>('GET', `/pocs/${pocId}/envios`);
  assert.equal(envios[0].tipo, 'manual');
  assert.equal(envios[0].resumo.eventos, 4);
});

test('forçar: só root, e libera a ordem; o duplicado sai assim mesmo para testar a reação do SplitHub', async () => {
  const sem = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [notas['1001']], tipos: ['E-IBS-01'] });
  assert.match(sem.bloqueios[0].motivo, /já aconteceu/);
  const com = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [notas['1001']], tipos: ['E-IBS-01'], forcar: true });
  assert.equal(com.itens[0].forcado, true);
  assert.equal(com.itens[0].valor, 1000);
});

test('aviso sem 2xx: três tentativas, evento "não recebido"; o reenvio repete o mesmo aviso e o mesmo arquivo', async () => {
  modoSplitHub = 'falha';
  const r = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1002']], tipos: ['E-IBS-05'] });
  const p = r.fechamento.processados[0];
  assert.equal(p.aviso.resultado, 'erro');
  assert.equal(p.aviso.tentativas, 3);
  let nota = await api('GET', `/pocs/${pocId}/notas/${notas['1001']}`);
  const ultimo = nota.historico.filter(ibs).at(-1);
  assert.equal(ultimo.tipo, 'E-IBS-05');
  assert.equal(ultimo.valor, 100);
  assert.equal(ultimo.situacao, 'nao_recebido');
  const detalhe = await api('GET', `/pocs/${pocId}/avisos/${p.aviso.id}`);
  assert.equal(detalhe.chamadas.length, 3);
  assert.equal(detalhe.chamadas[0].cabecalhos.tokenContrib, '••••••');

  modoSplitHub = 'ok';
  const antes = recebidos.length;
  const re = await api('POST', `/pocs/${pocId}/avisos/${p.aviso.id}/reenviar`);
  assert.equal(re.resultado, 'ok');
  const [aviso] = (await esperarRecebidos(antes + 1)).slice(antes);
  assert.equal(JSON.stringify(aviso.corpo), JSON.stringify(detalhe.corpo), 'mesmo aviso');
  await esperar(100);
  nota = await api('GET', `/pocs/${pocId}/notas/${notas['1001']}`);
  assert.equal(nota.historico.filter(ibs).at(-1).situacao, 'recebido');
});

test('fatiamento real: com 1 lançamento por arquivo, a operação vem em duas partes com o hash acumulado', async () => {
  await api('PUT', `/pocs/${pocId}`, { lancamentosPorArquivo: 1 });
  const antes = recebidos.length;
  const r = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1003']], tipos: [{ tipo: 'E-IBS-06', pct: 50 }, 'E-IBS-09'], forcar: false });
  // 09 precisa de débito aberto ao adquirente, que esta nota não tem: só a utilização sai.
  assert.match(r.bloqueios[0].motivo, /não cabe nesta nota/);
  assert.equal(r.fechamento.processados[0].arquivos.length, 1);
  await esperarRecebidos(antes + 1);
  const r2 = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['2001']], tipos: [{ tipo: 'E-IBS-10', pct: 50 }], forcar: true });
  assert.equal(r2.itens.length, 1);
  const r3 = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1003']], tipos: ['E-IBS-07'], forcar: true });
  assert.equal(r3.itens[0].valor, 0);
  await esperarRecebidos(antes + 3);

  // Duas linhas da mesma operação num dia, com 1 por arquivo.
  const n0 = recebidos.length;
  const r4 = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1004']], tipos: [{ tipo: 'E-IBS-05', pct: 50 }] });
  assert.deepEqual(r4.itens.map((i: any) => i.id), ['E-IBS-01', 'E-IBS-05']);
  const p = r4.fechamento.processados[0];
  assert.equal(p.arquivos.length, 2);
  assert.match(p.arquivos[1].nome, /_parte002\.zip$/);
  const [aviso] = (await esperarRecebidos(n0 + 1)).slice(n0);
  assert.equal(aviso.corpo.qtdArqVincul, 2);
  const [a, b] = aviso.arquivos.map((x) => x.conteudo.header.operacoes[0]);
  const { extrato_cc: ea, ...cabA } = a;
  const { extrato_cc: eb, ...cabB } = b;
  assert.deepEqual(cabA, cabB, 'o cabeçalho da operação se repete igual');
  assert.equal(ea.hash, hashExtrato(null, ea.lista[0]));
  assert.equal(eb.hash, hashExtrato(ea.hash, eb.lista[0]), 'o hash da segunda parte acumula a primeira');
  await api('PUT', `/pocs/${pocId}`, { lancamentosPorArquivo: 5000 });
});

test('substituição: o envio manual torna repetido o que o roteiro planejou, e o planejado não sai', async () => {
  const novo = nfe({ numero: 1010, emit: FORNECEDOR, dest: CLIENTE, ibs: 1000, dia: '2026-11-15' });
  await api('POST', `/pocs/${pocId}/notas`, { arquivos: [{ nome: 'nova.xml', conteudo: novo.xml }] });
  const id = (await api<any[]>('GET', `/pocs/${pocId}/notas?busca=1010`))[0].id;
  assert.equal((await api('GET', `/pocs/${pocId}`)).dia, '2026-11-10');
  const volta = await chamar('POST', `${API}/pocs/${pocId}/relogio/fechar`, { corpo: { ate: '2026-11-09' } });
  assert.equal(volta.status, 409, 'o relógio não volta');
  await api('POST', `/pocs/${pocId}/relogio/fechar`, { ate: '2026-11-14' });
  const rot = await api('POST', `/pocs/${pocId}/roteiros`, { notaIds: [id], roteiro: 'RT-A1', intervaloDias: 2 });
  assert.deepEqual(rot.itens.filter(ibs).map((i: any) => i.dia), ['2026-11-15', '2026-11-17', '2026-11-19']);
  await api('POST', `/pocs/${pocId}/relogio/fechar`, { ate: '2026-11-15' });
  const man = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [id], tipos: ['E-IBS-05'] });
  assert.equal(man.envio.substituidos, 1);
  const nota = await api('GET', `/pocs/${pocId}/notas/${id}`);
  const sub = nota.historico.filter(ibs).find((e: any) => e.situacao === 'substituido');
  assert.equal(sub.tipo, 'E-IBS-05');
  assert.match(sub.motivo, /Substituído pelo envio manual nº \d+/);
  assert.equal(nota.historico.find((e: any) => e.tipo === 'E-IBS-06').situacao, 'planejado', 'a utilização continua no plano');
});

test('collection dos entes emulados e o fim da POC: as notas do cliente saem com ela', async () => {
  const r = await fetch(`${API}/pocs/${pocId}/collection`, { headers: { cookie } });
  const c = await r.json() as any;
  assert.equal(c.item.length, 6);
  assert.equal(c.variable.find((v: any) => v.key === 'clientId').value, credencial.clientId);
  assert.equal(JSON.stringify(c).includes(credencial.clientSecret), false);
  assert.equal(JSON.stringify(c).includes('"event"'), false, 'sem scripts');
  const xml = await fetch(`${API}/pocs/${pocId}/notas/${notas['1001']}/xml`, { headers: { cookie } });
  assert.equal(createHash('sha256').update(await xml.text()).digest('hex'), createHash('sha256').update(ENTRADA.xml).digest('hex'));

  await api('DELETE', `/pocs/${pocId}`);
  assert.equal((await chamar('GET', `${API}/pocs/${pocId}/notas`)).status, 404);
  const trilha = await api<any[]>('GET', '/auditoria?acao=poc.');
  assert.ok(trilha.some((t) => t.acao === 'poc.remover'));
  assert.ok(trilha.some((t) => t.acao === 'poc.envio'));
  assert.equal(JSON.stringify(trilha).includes(credencial.clientSecret), false);
  const depois = await chamar('GET', `${ENTE}/v1/aassist/solicitacao/listar/2026-11-01&2026-11-30&todas`, { cabecalhos: credenciais() });
  assert.equal(depois.status, 401, 'a credencial morre com a POC');
});

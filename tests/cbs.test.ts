// Etapa 2 da v4.3: a CBS de ponta a ponta. Sobe o app e um SplitHub falso, que responde ao HEAD da urlRetorno, recebe o
// aviso da Receita Federal emulada e baixa o link assinado. As mesmas notas percorrem os roteiros nos dois entes; depois,
// o pedido pela janela, o limite, o aviso sem pedido ao fechar o dia, o reenvio, o link vencido e os roteiros só da CBS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROTEIROS } from '../server/emulacao/catalogo.ts';
import { CATALOGO_CBS, DERIVADOS_CBS, ORDEM_CBS, TIPO_CBS, derivadoCbs, numeroCbs } from '../server/emulacao/catalogo-cbs.ts';
import { fotoCredito, montarArquivoCbs, type EventoCbs } from '../server/emulacao/arquivo-cbs.ts';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PORTA_APP = 13937;
const PORTA_SPLITHUB = 13938;
const API = `http://localhost:${PORTA_APP}/api`;
const ENTE = `http://localhost:${PORTA_APP}/entes/cbs`;
const RETORNO = `http://localhost:${PORTA_SPLITHUB}/retorno/cbs`;
const QUEBRADO = `http://localhost:${PORTA_SPLITHUB}/quebrado`;
const ROOT = 'root.poc@empresa.com.br';
const SENHA = 'senha-de-teste-123';
const dados = mkdtempSync(path.join(tmpdir(), 'massgen-cbs-'));
const processos: ChildProcess[] = [];
let splithub: Server;

// ---------------------------------------------------------------- notas de teste (fictícias, valores redondos)

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

function nfe(numero: number, emit: string, dest: string, ibs: number, cbs: number): { chave: string; xml: string } {
  const chave = chaveDe(emit, numero);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00">
<ide><cUF>35</cUF><natOp>Venda</natOp><mod>55</mod><serie>1</serie><nNF>${numero}</nNF><dhEmi>2026-11-01T10:00:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>1</finNFe></ide>
<emit><CNPJ>${emit}</CNPJ><xNome>Emitente ${numero}</xNome></emit><dest><CNPJ>${dest}</CNPJ><xNome>Destinatário ${numero}</xNome></dest>
<total><ICMSTot><vNF>100000.00</vNF></ICMSTot><IBSCBSTot><vBCIBSCBS>100000.00</vBCIBSCBS><gIBS><gIBSUF><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSUF>${(ibs * 0.6).toFixed(2)}</vIBSUF></gIBSUF><gIBSMun><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSMun>${(ibs * 0.4).toFixed(2)}</vIBSMun></gIBSMun><vIBS>${ibs.toFixed(2)}</vIBS></gIBS><gCBS><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vCBS>${cbs.toFixed(2)}</vCBS></gCBS></IBSCBSTot></total></infNFe></NFe>
<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${chave}</chNFe><dhRecbto>2026-11-01T10:00:05-03:00</dhRecbto><nProt>1352600000${numero}</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
  return { chave, xml };
}

const ENTRADA = nfe(1001, FORNECEDOR, CLIENTE, 1000, 500);
const SAIDA = nfe(2001, CLIENTE, COMPRADOR, 2000, 1000);
const ENTRADA_2 = nfe(1003, FORNECEDOR, CLIENTE, 3000, 3000);
const ENTRADA_3 = nfe(1004, FORNECEDOR, CLIENTE, 4000, 4000);
const A7 = nfe(1005, FORNECEDOR, CLIENTE, 4000, 4000);
const A8 = nfe(1006, FORNECEDOR, CLIENTE, 1000, 1000);
const A9 = nfe(1007, FORNECEDOR, CLIENTE, 1000, 1000);
const F8 = nfe(2002, CLIENTE, COMPRADOR, 2000, 2000);

// ---------------------------------------------------------------- unidades

test('catálogo: 26 tipos da CBS, pré-requisitos e roteiros que existem, e a conta de saldo do estudo', () => {
  assert.equal(CATALOGO_CBS.length, 26);
  assert.equal(new Set(ORDEM_CBS).size, 26);
  for (const t of CATALOGO_CBS) for (const alt of t.precisa) for (const x of alt) assert.ok(TIPO_CBS.has(x), `${t.id} precisa de ${x}`);
  for (const r of ROTEIROS) for (const p of r.cbs) assert.ok(TIPO_CBS.has(p.tipo), `${r.id} usa ${p.tipo}`);
  assert.deepEqual(ROTEIROS.filter((r) => !r.ibs.length).map((r) => r.id).sort(), ['RT-A7', 'RT-A8', 'RT-A9', 'RT-F8']);
  assert.equal(numeroCbs('E-CBS-C02'), 'C02');
  assert.equal(numeroCbs('c2'), 'C02');
  assert.equal(numeroCbs('E-CBS-C13'), undefined);
  // O exemplo do estudo: 12.000 apurados, 10.000 apropriados e 7.500 utilizados dão 2.500 de saldo credor.
  const s = { 'C.apurado': 12000, 'C.apropriado': 10000, 'C.utilizado': 7500 };
  assert.equal(derivadoCbs(s, 'saldoCredor'), 2500);
  assert.equal(derivadoCbs(s, 'aApropriar'), 2000);
  assert.equal(DERIVADOS_CBS.length, 3);
  const doc = { chave: ENTRADA.chave, modelo: '55', emissao: '2026-11-01T10:00:00-03:00', finalidade: 'normal' };
  const evs: EventoCbs[] = [
    { tipo: 'C01', valores: { 'C.apurado': 12000 }, dth: '2026-11-01T10:00:00-03:00', dados: null },
    { tipo: 'C02', valores: { 'C.apropriado': 10000 }, dth: '2026-11-02T10:00:00-03:00', dados: null },
    { tipo: 'C07', valores: { 'C.utilizado': 7500 }, dth: '2026-11-03T10:00:00-03:00', dados: null },
  ];
  const f = fotoCredito(doc, evs)!;
  assert.equal(f.registro, '2026-11-01T10:00:00-03:00');
  assert.equal(f.atualizacao, '2026-11-03T10:00:00-03:00');
  assert.equal(f.cbs.utilizacao.naoUtilizado.saldoCredor, 2500);
  const a = montarArquivoCbs('creditos', 't-1', '12345678', '2026-11-04T09:00:00-03:00', [{ doc, eventos: evs }]).conteudo as any;
  assert.deepEqual(Object.keys(a), ['tiqueteSolicitacao', 'ni', 'niConsumidor', 'geradoEm', 'apuracao']);
  assert.equal(a.apuracao[0].pa, '11/2026');
  assert.equal(a.apuracao[0].creditos[0].origem, 0);
});

// ---------------------------------------------------------------- ponta a ponta

interface Chegada { corpo: any }
interface Baixado { tiquete: string; urlAssinada: string; status: number; conteudo: any }
const chegadas: Chegada[] = [];
const baixados: Baixado[] = [];
let modo: 'ok' | 'falha' | 'sem_download' = 'ok';
let cookie = '';
let pocId = '';
let credencial = { clientId: '', clientSecret: '' };
const notas: Record<string, string> = {};

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

async function token(): Promise<string> {
  const r = await chamar('POST', `${ENTE}/token`, { form: { grant_type: 'client_credentials', client_id: credencial.clientId, client_secret: credencial.clientSecret } });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  return r.corpo.access_token;
}

const pedir = async (endpoint: string, url = RETORNO, cnpj = '12345678') =>
  chamar('POST', `${ENTE}/apuracao-cbs/v2/${endpoint}/${cnpj}`, { cabecalhos: { authorization: `Bearer ${await token()}` }, corpo: { urlRetorno: url } });

// O SplitHub falso: 2xx no HEAD da urlRetorno (404 na quebrada), recebe o aviso e baixa o link depois, como um consumidor assíncrono.
function subirSplitHub(): Promise<void> {
  splithub = createServer(async (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(req.url === '/retorno/cbs' ? 200 : 404).end(); return; }
    let texto = '';
    for await (const c of req) texto += c;
    const corpo = JSON.parse(texto);
    chegadas.push({ corpo });
    if (modo === 'falha') { res.writeHead(500, { 'content-type': 'application/json' }).end('{"erro":"fora do ar"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"recebido":true}');
    if (modo === 'sem_download' || !corpo.urlAssinada) return;
    const r = await fetch(corpo.urlAssinada);
    baixados.push({ tiquete: corpo.tiqueteSolicitacao, urlAssinada: corpo.urlAssinada, status: r.status, conteudo: await r.json() });
  });
  return new Promise((r) => splithub.listen(PORTA_SPLITHUB, r));
}

async function esperarBaixados(n: number): Promise<Baixado[]> {
  for (let i = 0; i < 100; i++) {
    if (baixados.length >= n) return baixados;
    await esperar(50);
  }
  throw new Error(`O SplitHub falso baixou ${baixados.length} de ${n} arquivos.`);
}

const doTiquete = (tiquete: string) => baixados.find((b) => b.tiquete === tiquete);
const fotos = (b: Baixado, endpoint: string) => b.conteudo.apuracao.flatMap((g: any) => g[endpoint] ?? []);
const cbs = (x: any) => x.ente === 'cbs';

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

test('POC: as duas credenciais saem juntas e uma vez; o lote entra como no IBS', async () => {
  const r = await api('POST', '/pocs', { nome: 'POC CBS', cnpj: '12.345.678/0001-90', competencia: '2026-11' });
  pocId = r.poc.id;
  credencial = r.credenciais.find((c: any) => c.ente === 'cbs');
  assert.match(credencial.clientId, /^mg-cbs-/);
  assert.equal(r.poc.cbs.url, ENTE);
  assert.equal(JSON.stringify(await api('GET', `/pocs/${pocId}`)).includes(credencial.clientSecret), false, 'o segredo não volta');
  const imp = await api('POST', `/pocs/${pocId}/notas`, {
    arquivos: [ENTRADA, SAIDA, ENTRADA_2, ENTRADA_3, A7, A8, A9, F8].map((n, i) => ({ nome: `nota${i}.xml`, conteudo: n.xml })),
  });
  assert.equal(imp.aceitas, 8);
  for (const n of await api<any[]>('GET', `/pocs/${pocId}/notas`)) notas[n.numero] = n.id;
});

test('token: formulário ou Basic; credencial errada é 401; sem token, APURACAO-401; nada de segredo nas chamadas', async () => {
  const errada = await chamar('POST', `${ENTE}/token`, { form: { grant_type: 'client_credentials', client_id: credencial.clientId, client_secret: 'errado' } });
  assert.equal(errada.status, 401);
  assert.equal(errada.corpo.error, 'invalid_client');
  const grant = await chamar('POST', `${ENTE}/token`, { form: { grant_type: 'password', client_id: credencial.clientId, client_secret: credencial.clientSecret } });
  assert.equal(grant.status, 400);
  const basic = await chamar('POST', `${ENTE}/token`, {
    form: { grant_type: 'client_credentials' }, cabecalhos: { authorization: `Basic ${Buffer.from(`${credencial.clientId}:${credencial.clientSecret}`).toString('base64')}` },
  });
  assert.equal(basic.status, 200);
  assert.equal(basic.corpo.token_type, 'Bearer');
  assert.equal(basic.corpo.expires_in, 3600);
  const sem = await chamar('POST', `${ENTE}/apuracao-cbs/v2/creditos/12345678`, { corpo: { urlRetorno: RETORNO } });
  assert.equal(sem.status, 401);
  assert.equal(sem.corpo.codigoErro, 'APURACAO-401');
  const bar = await api('GET', `/pocs/${pocId}/barramento`);
  const texto = JSON.stringify(bar);
  assert.equal(texto.includes(credencial.clientSecret), false);
  assert.equal(texto.includes(basic.corpo.access_token), false, 'o access_token não fica nas chamadas');
  assert.ok(bar.chamadas.some((c: any) => c.ente === 'cbs' && c.rota === '/entes/cbs/token'));
});

test('pedido recusado: CNPJ base de outro, urlRetorno fora da lista, sem HTTPS ou sem 2xx no HEAD; endpoint desconhecido', async () => {
  const outro = await pedir('creditos', RETORNO, '11222333');
  assert.equal(outro.status, 400);
  assert.equal(outro.corpo.codigoErro, 'APURACAO-001');
  const fora = await pedir('creditos', 'https://splithub.exemplo.com/retorno');
  assert.equal(fora.status, 400);
  assert.match(fora.corpo.mensagemErro, /lista de domínios permitidos/);
  const http = await pedir('creditos', 'http://sandbox.exemplo/retorno');
  assert.match(http.corpo.mensagemErro, /HTTPS/);
  const head = await pedir('creditos', QUEBRADO);
  assert.equal(head.status, 400);
  assert.equal(head.corpo.codigoErro, 'APURACAO-001');
  assert.match(head.corpo.mensagemErro, /HEAD/);
  const nada = await pedir('impostos');
  assert.equal(nada.status, 404);
  assert.equal(chegadas.length, 0, 'nenhum aviso sai de pedido recusado');
});

test('RT-A1 e RT-F1 nos dois entes: mesmos dias; sem urlRetorno, o dia fecha e o pedido coleta pela janela', async () => {
  const a1 = await api('POST', `/pocs/${pocId}/roteiros`, { notaIds: [notas['1001']], roteiro: 'RT-A1' });
  assert.deepEqual(a1.itens.map((i: any) => `${i.id}@${i.dia}`), [
    'E-IBS-01@2026-11-01', 'E-IBS-05@2026-11-02', 'E-IBS-06@2026-11-03', 'E-CBS-C01@2026-11-01', 'E-CBS-C02@2026-11-02', 'E-CBS-C07@2026-11-03',
  ]);
  const f1 = await api('POST', `/pocs/${pocId}/roteiros`, { notaIds: [notas['2001']], roteiro: 'RT-F1' });
  assert.deepEqual(f1.itens.filter(cbs).map((i: any) => `${i.id}@${i.dia}:${i.valor}`), ['E-CBS-D01@2026-11-01:1000', 'E-CBS-P01@2026-11-02:1000', 'E-CBS-D04@2026-11-03:1000']);

  const r = await api('POST', `/pocs/${pocId}/relogio/fechar`, { ate: '2026-11-03' });
  assert.equal(r.dia, '2026-11-04');
  assert.equal(r.processados.length, 3, 'os Deltas do IBS');
  assert.deepEqual(r.cbs.map((c: any) => [c.dia, c.eventos, c.tiquetes.length]), [['2026-11-01', 2, 0], ['2026-11-02', 2, 0], ['2026-11-03', 2, 0]]);
  assert.equal(chegadas.length, 0, 'sem urlRetorno, nada de aviso sem pedido');

  const p = await pedir('creditos');
  assert.equal(p.status, 201, JSON.stringify(p.corpo));
  assert.match(p.corpo.tiqueteSolicitacao, /^[0-9a-f-]{36}$/);
  assert.equal(p.corpo.tEASegundos, '1');
  const s0 = await chamar('GET', `${ENTE}/apuracao-cbs/v2/situacao/${p.corpo.tiqueteSolicitacao}`, { cabecalhos: { authorization: `Bearer ${await token()}` } });
  assert.ok(['PENDENTE', 'EM_PROCESSAMENTO'].includes(s0.corpo.estado), s0.corpo.estado);
  const [b] = await esperarBaixados(1);
  assert.equal(b.status, 200);
  assert.equal(chegadas[0].corpo.tiqueteSolicitacao, p.corpo.tiqueteSolicitacao);
  const s1 = await chamar('GET', `${ENTE}/apuracao-cbs/v2/situacao/${p.corpo.tiqueteSolicitacao}`, { cabecalhos: { authorization: `Bearer ${await token()}` } });
  assert.equal(s1.corpo.estado, 'CONCLUIDA');
  assert.equal(s1.corpo.urlAssinada, b.urlAssinada);
  assert.equal(s1.corpo.urlAssinadaExpiraEm, chegadas[0].corpo.urlAssinadaExpiraEm);

  // A foto do documento 1001, com a janela desde o dia 1 do mês (primeira coleta).
  assert.equal(b.conteudo.ni, '12345678');
  assert.equal(b.conteudo.niConsumidor, '');
  const [foto] = fotos(b, 'creditos');
  assert.equal(foto.chave, ENTRADA.chave);
  assert.equal(foto.registro, '2026-11-01T10:00:00-03:00');
  assert.match(foto.atualizacao, /^2026-11-03T10:0\d:00-03:00$/);
  assert.equal(foto.cbs.apurado, 500);
  assert.equal(foto.cbs.apropriacao.apropriado, 500);
  assert.equal(foto.cbs.apropriacao.aApropriar, 0);
  assert.equal(foto.cbs.utilizacao.utilizado, 500);
  assert.equal(foto.cbs.utilizacao.naoUtilizado.saldoCredor, 0);

  const d = await pedir('debitos');
  const pg = await pedir('pagamentos');
  await esperarBaixados(3);
  const [debito] = fotos(doTiquete(d.corpo.tiqueteSolicitacao)!, 'debitos');
  assert.equal(debito.chave, SAIDA.chave);
  assert.deepEqual(debito.cbs, { apurado: 1000, excedente: 0, inexigivel: 0, suspenso: 0, extinto: 1000, saldoDevedor: 0 });
  const pagamentos = doTiquete(pg.corpo.tiqueteSolicitacao)!.conteudo.apuracao;
  assert.match(pagamentos[0].dataArrecadacao, /^2026-11-02T10:0\d:00-03:00$/);
  const [pag] = pagamentos[0].pagamentos;
  assert.match(pag.numeroDARF, /^07\.17\.26306\.\d{7}-\d$/);
  assert.equal(pag.tipo, 1);
  assert.deepEqual(pag.composicao, [{ pa: '11/2026', principal: 1000, multa: 0, juros: 0, total: 1000 }]);

  // O histórico da nota mostra os dois entes; na CBS, a foto depois de cada evento e o tíquete que a levou.
  await esperar(100);
  const nota = await api('GET', `/pocs/${pocId}/notas/${notas['1001']}`);
  assert.deepEqual(nota.historico.map((e: any) => `${e.ente}:${e.tipo}`), [
    'ibs:E-IBS-01', 'cbs:E-CBS-C01', 'ibs:E-IBS-05', 'cbs:E-CBS-C02', 'ibs:E-IBS-06', 'cbs:E-CBS-C07',
  ]);
  const doCbs = nota.historico.filter(cbs);
  assert.ok(doCbs.every((e: any) => e.situacao === 'recebido'), JSON.stringify(doCbs.map((e: any) => e.situacao)));
  assert.equal(doCbs[0].foto.cbs.apurado, 500);
  assert.equal(doCbs[0].foto.cbs.apropriacao.aApropriar, 500, 'a foto é a de depois do evento, não a de hoje');
  assert.equal(doCbs[2].tiquetes[0].origem, 'pedido');
  assert.equal(doCbs[2].tiquetes[0].downloads, 1);
  const saldos = Object.fromEntries(nota.documentosCbs[0].saldos.map((s: any) => [s.campo, s.noEnte]));
  assert.equal(saldos['C.apurado'], 500);
  assert.equal(saldos.saldoCredor, 0);
});

test('limite: 4 pedidos por dia simulado em cada endpoint, salvo com os limites relaxados', async () => {
  const antes = baixados.length;
  for (let i = 0; i < 3; i++) assert.equal((await pedir('creditos')).status, 201);
  const quinto = await pedir('creditos');
  assert.equal(quinto.status, 429);
  assert.equal(quinto.corpo.codigoErro, 'APURACAO-429');
  assert.equal((await pedir('recolhimentos')).status, 201, 'o limite é por endpoint');
  await api('PUT', `/pocs/${pocId}`, { limitesRelaxados: true });
  const relaxado = await pedir('creditos');
  assert.equal(relaxado.status, 201);
  await api('PUT', `/pocs/${pocId}`, { limitesRelaxados: false });
  await esperarBaixados(antes + 5);
  // Fora da primeira coleta, a janela é de 8 dias: o documento de 03/11 ainda entra.
  assert.equal(fotos(doTiquete(relaxado.corpo.tiqueteSolicitacao)!, 'creditos').length, 1);
});

test('aviso sem pedido (D-MG-03): a urlRetorno passa pelo HEAD; o envio sob demanda fecha o dia e avisa o endpoint que mudou', async () => {
  const ruim = await chamar('PUT', `${API}/pocs/${pocId}/cbs/url-retorno`, { corpo: { urlRetorno: QUEBRADO } });
  assert.equal(ruim.status, 400);
  const ok = await api('PUT', `/pocs/${pocId}/cbs/url-retorno`, { urlRetorno: RETORNO });
  assert.equal(ok.urlRetorno, RETORNO);
  assert.ok(ok.validadaEm);

  // A 1003 não teve evento: a utilização traz o registro e a apropriação antes; débito não cabe numa nota de entrada.
  const previa = await api('POST', `/pocs/${pocId}/envios/previa`, { notaIds: [notas['1003']], tipos: [{ tipo: 'E-CBS-C07', pct: 50 }, 'E-CBS-D01'] });
  assert.deepEqual(previa.itens.map((i: any) => [i.id, i.origem, i.valor]), [['E-CBS-C01', 'pre-requisito', 3000], ['E-CBS-C02', 'pre-requisito', 3000], ['E-CBS-C07', 'escolhido', 1500]]);
  assert.match(previa.bloqueios[0].motivo, /só em nota de saída/);

  const antes = baixados.length;
  const r = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1003']], tipos: [{ tipo: 'E-CBS-C07', pct: 50 }] });
  assert.equal(r.fechamento.dia, '2026-11-05');
  assert.equal(r.fechamento.processados.length, 0, 'nada no IBS');
  const [dia] = r.fechamento.cbs;
  assert.deepEqual(dia.tiquetes.map((t: any) => [t.endpoint, t.documentos]), [['creditos', 1]]);
  assert.equal(dia.avisos[0].resultado, 'ok');
  const [b] = (await esperarBaixados(antes + 1)).slice(antes);
  assert.equal(b.conteudo.geradoEm, '2026-11-04T23:00:00-03:00');
  const [foto] = fotos(b, 'creditos');
  assert.equal(foto.chave, ENTRADA_2.chave, 'só o que mudou no dia');
  assert.equal(foto.cbs.utilizacao.utilizado, 1500);
  assert.equal(foto.cbs.utilizacao.naoUtilizado.saldoCredor, 1500);
  await esperar(100);
  const nota = await api('GET', `/pocs/${pocId}/notas/${notas['1003']}`);
  assert.deepEqual(nota.historico.map((e: any) => `${e.tipo}:${e.situacao}`), ['E-CBS-C01:recebido', 'E-CBS-C02:recebido', 'E-CBS-C07:recebido']);
  assert.equal(nota.historico[2].tiquetes[0].origem, 'sem_pedido');
});

test('aviso sem 2xx: três tentativas e "não recebido"; o reenvio repete o mesmo link, mascarado no app', async () => {
  modo = 'falha';
  const n0 = chegadas.length;
  const r = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1004']], tipos: ['E-CBS-C01'] });
  const aviso = r.fechamento.cbs[0].avisos[0];
  assert.equal(aviso.resultado, 'erro');
  assert.equal(aviso.tentativas, 3);
  const link = chegadas[n0].corpo.urlAssinada;
  let nota = await api('GET', `/pocs/${pocId}/notas/${notas['1004']}`);
  assert.equal(nota.historico[0].situacao, 'nao_recebido');
  const detalhe = await api('GET', `/pocs/${pocId}/avisos/${aviso.id}`);
  assert.equal(detalhe.ente, 'cbs');
  assert.match(detalhe.corpo.urlAssinada, /\/download\/v2\/••••••$/);
  assert.equal(JSON.stringify(detalhe).includes(link), false, 'o link assinado não fica no app');

  modo = 'ok';
  const antes = baixados.length;
  const re = await api('POST', `/pocs/${pocId}/avisos/${aviso.id}/reenviar`);
  assert.equal(re.resultado, 'ok');
  const [b] = (await esperarBaixados(antes + 1)).slice(antes);
  assert.equal(b.urlAssinada, link, 'mesmo link');
  await esperar(100);
  nota = await api('GET', `/pocs/${pocId}/notas/${notas['1004']}`);
  assert.equal(nota.historico[0].situacao, 'recebido');
});

test('link vencido: 48 horas no relógio sem download viram "não recebido" e 410; a coleta seguinte recupera', async () => {
  modo = 'sem_download';
  const n0 = chegadas.length;
  const r = await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1004']], tipos: [{ tipo: 'E-CBS-C03', pct: 50 }] });
  assert.equal(r.fechamento.dia, '2026-11-07');
  const link = chegadas[n0].corpo.urlAssinada;
  assert.equal(chegadas[n0].corpo.urlAssinadaExpiraEm, '2026-11-09T02:00:00Z', '23:00 de 06/11 mais 48 horas');
  let nota = await api('GET', `/pocs/${pocId}/notas/${notas['1004']}`);
  assert.equal(nota.historico.at(-1).situacao, 'avisado');
  await api('POST', `/pocs/${pocId}/relogio/fechar`, { ate: '2026-11-07' });
  assert.equal((await fetch(link)).status, 200, 'ainda vale no dia 08/11');
  // O download acima conta como recebido; um segundo tíquete sem download mostra o vencimento.
  const n1 = chegadas.length;
  await api('POST', `/pocs/${pocId}/envios`, { notaIds: [notas['1004']], tipos: [{ tipo: 'E-CBS-C07', pct: 50 }] });
  const link2 = chegadas[n1].corpo.urlAssinada;
  await api('POST', `/pocs/${pocId}/relogio/fechar`, { ate: '2026-11-10' });
  const vencido = await fetch(link2);
  assert.equal(vencido.status, 410);
  assert.equal(((await vencido.json()) as any).codigoErro, 'APURACAO-410');
  nota = await api('GET', `/pocs/${pocId}/notas/${notas['1004']}`);
  const c07 = nota.historico.find((e: any) => e.tipo === 'E-CBS-C07');
  assert.equal(c07.situacao, 'nao_recebido');
  assert.match(c07.motivo, /expirou sem download/);

  modo = 'ok';
  const antes = baixados.length;
  assert.equal((await pedir('creditos')).status, 201);
  const [b] = (await esperarBaixados(antes + 1)).slice(antes);
  assert.ok(fotos(b, 'creditos').some((f: any) => f.chave === ENTRADA_3.chave));
  await esperar(100);
  nota = await api('GET', `/pocs/${pocId}/notas/${notas['1004']}`);
  assert.equal(nota.historico.find((e: any) => e.tipo === 'E-CBS-C07').situacao, 'recebido', 'a coleta baixada recupera');
});

test('roteiros só da CBS: RT-A7, RT-A8, RT-A9 e RT-F8 andam com o aviso sem pedido; atraso com multa e juros', async () => {
  const planos = await Promise.all([['1005', 'RT-A7'], ['1006', 'RT-A8'], ['1007', 'RT-A9'], ['2002', 'RT-F8']].map(([n, roteiro]) =>
    api('POST', `/pocs/${pocId}/roteiros/previa`, { notaIds: [notas[n]], roteiro })));
  for (const p of planos) {
    assert.equal(p.bloqueios.length, 0, JSON.stringify(p.bloqueios));
    assert.ok(p.itens.length && p.itens.every(cbs), `${p.roteiro} só na CBS`);
  }
  for (const [n, roteiro] of [['1005', 'RT-A7'], ['1006', 'RT-A8'], ['1007', 'RT-A9'], ['2002', 'RT-F8']]) {
    await api('POST', `/pocs/${pocId}/roteiros`, { notaIds: [notas[n]], roteiro });
  }
  // Um dia por comando, como na POC: fechar vários de uma vez passa das 48 horas antes de o SplitHub baixar.
  const antes = baixados.length;
  let n = 0;
  for (const dia of ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']) {
    const r = await api('POST', `/pocs/${pocId}/relogio/fechar`, { ate: dia });
    assert.equal(r.processados.length, 0);
    assert.ok(r.cbs.every((c: any) => c.avisos.every((a: any) => a.resultado === 'ok')));
    n += r.cbs.reduce((s: number, c: any) => s + c.tiquetes.length, 0);
    await esperarBaixados(antes + n);
  }
  const novos = baixados.slice(antes);
  assert.ok(novos.every((b) => b.status === 200), JSON.stringify(novos.filter((b) => b.status !== 200).map((b) => b.conteudo)));

  // Os downloads correm em paralelo: a foto mais nova é a do maior atualizacao.
  const ultima = (endpoint: string, chave: string) => novos.flatMap((b) => fotos(b, endpoint)).filter((f: any) => f.chave === chave)
    .sort((a: any, b: any) => a.atualizacao.localeCompare(b.atualizacao)).at(-1);
  const a7 = ultima('creditos', A7.chave);
  assert.deepEqual(a7.cbs.apropriacao, { inapropriavel: 2000, suspenso: 1000, prescrito: 500, aApropriar: 0, apropriado: 500 });
  assert.deepEqual(a7.cbs.utilizacao, { inutilizavel: 250, utilizado: 0, restabelecido: 250, naoUtilizado: { saldoCredor: 500, pedidoRessarcimento: 0 } });
  const a8 = ultima('creditos', A8.chave);
  assert.equal(a8.cbs.excedente, 1000);
  assert.equal(a8.cbs.utilizacao.naoUtilizado.pedidoRessarcimento, 500);
  assert.equal(a8.cbs.utilizacao.naoUtilizado.saldoCredor, 500);

  // Pagamentos e recolhimentos vêm no mesmo leiaute, com a lista em "pagamentos"; o recolhimento leva a chave do documento.
  const registros = novos.flatMap((b) => b.conteudo.apuracao.flatMap((g: any) => (g.dataArrecadacao ? g.pagamentos : [])));
  const recolhimento = registros.find((p: any) => p.composicao[0].chaveDFE);
  assert.equal(recolhimento.tipo, 2);
  assert.deepEqual(recolhimento.composicao, [{
    sequencial: 1, pa: '11/2026', vencimento: '2026-12-31T23:59:59-03:00', niFornecedor: FORNECEDOR, chaveDFE: A9.chave, principal: 1000, multa: 100, juros: 10, total: 1110,
  }]);
  const atraso = registros.find((p: any) => p.composicao[0].multa && !p.composicao[0].chaveDFE);
  assert.equal(atraso.tipo, 1);
  assert.deepEqual(atraso.composicao, [{ pa: '11/2026', principal: 500, multa: 50, juros: 5, total: 555 }]);
  const debito = ultima('debitos', F8.chave);
  assert.deepEqual(debito.cbs, { apurado: 2000, excedente: 1000, inexigivel: 1000, suspenso: 500, extinto: 0, saldoDevedor: 500 });
});

test('collection da Receita Federal emulada, barramento com os tíquetes e o fim da POC', async () => {
  const r = await fetch(`${API}/pocs/${pocId}/collection?ente=cbs`, { headers: { cookie } });
  const c = await r.json() as any;
  assert.equal(c.info.name, 'MassGen · Receita Federal emulada (CBS)');
  assert.equal(c.item.length, 8);
  assert.equal(c.variable.find((v: any) => v.key === 'clientId').value, credencial.clientId);
  assert.equal(c.variable.find((v: any) => v.key === 'cnpj8').value, '12345678');
  assert.equal(JSON.stringify(c).includes(credencial.clientSecret), false);
  assert.equal(JSON.stringify(c).includes('"event"'), false, 'sem scripts');
  assert.match(c.info.description, /APURACAO-429/);

  const bar = await api('GET', `/pocs/${pocId}/barramento`);
  assert.equal(bar.cbs.urlRetorno, RETORNO);
  assert.ok(bar.tiquetes.some((t: any) => t.origem === 'pedido') && bar.tiquetes.some((t: any) => t.origem === 'sem_pedido'));
  const texto = JSON.stringify(bar);
  for (const b of baixados) assert.equal(texto.includes(b.urlAssinada), false, 'nenhum link assinado no barramento');
  const t = await api('GET', `/pocs/${pocId}/tiquetes/${bar.tiquetes.at(-1).id}`);
  assert.equal(t.conteudo.tiqueteSolicitacao, t.tiquete);
  assert.ok(t.eventosDoTiquete.length > 0);

  const trilha = await api<any[]>('GET', '/auditoria?acao=poc.');
  assert.ok(trilha.some((x) => x.acao === 'poc.cbs_url_retorno'));
  assert.equal(JSON.stringify(trilha).includes(credencial.clientSecret), false);
  await api('DELETE', `/pocs/${pocId}`);
  const depois = await chamar('POST', `${ENTE}/token`, { form: { grant_type: 'client_credentials', client_id: credencial.clientId, client_secret: credencial.clientSecret } });
  assert.equal(depois.status, 401, 'a credencial morre com a POC');
});

// Ponta a ponta: sobe o app e a API falsa, faz o primeiro acesso do root, cadastra o destino, gera e envia C-01 e C-05,
// confere o gabarito e cobre a gestão de usuários (convite, papéis, sessão, desativação e Cloudflare Access).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PORTA_APP = 13917;
const PORTA_MOCK = 18917;
const PORTA_ACCESS = 13918;
const API = `http://localhost:${PORTA_APP}/api`;
const ROOT = 'root.teste@empresa.com.br';
const SENHA = 'senha-de-teste-123';
const dados = mkdtempSync(path.join(tmpdir(), 'massgen-e2e-'));
const dadosAccess = mkdtempSync(path.join(tmpdir(), 'massgen-e2e-access-'));
const processos: ChildProcess[] = [];

interface Processo { saida: () => string }

function subir(arquivo: string, env: Record<string, string>, pronto: RegExp): Promise<Processo> {
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

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// O link de primeiro acesso só aparece no console do servidor.
async function linkDePrimeiroAcesso(p: Processo, email: string): Promise<string> {
  const re = new RegExp(`Primeiro acesso de ${email.replace(/\./g, '\\.')}: (\\S+)`);
  for (let i = 0; i < 50; i++) {
    const m = re.exec(p.saida());
    if (m) return m[1];
    await esperar(100);
  }
  throw new Error(`Sem link de primeiro acesso para ${email}: ${p.saida()}`);
}

const tokenDo = (link: string) => link.split('/convite/')[1];

interface Resposta { status: number; corpo: any; cookie: string | null }

async function chamar(base: string, metodo: string, rota: string, op: { cookie?: string; cabecalhos?: Record<string, string>; corpo?: unknown } = {}): Promise<Resposta> {
  const r = await fetch(base + rota, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(op.cookie ? { cookie: op.cookie } : {}), ...op.cabecalhos },
    body: op.corpo === undefined ? undefined : JSON.stringify(op.corpo),
  });
  const texto = await r.text();
  let corpo: any;
  try { corpo = texto ? JSON.parse(texto) : undefined; } catch { corpo = texto; }
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('massgen_sessao='))?.split(';')[0] ?? null;
  return { status: r.status, corpo, cookie };
}

// Aceita o link (primeiro acesso, convite ou redefinição) e devolve o cookie da sessão aberta.
async function aceitar(base: string, link: string, nome: string, senha = SENHA): Promise<string> {
  const r = await chamar(base, 'POST', `/convites/${tokenDo(link)}`, { corpo: { nome, senha } });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.ok(r.cookie, 'o aceite já abre a sessão');
  return r.cookie!;
}

let cookieRoot = '';
let app: Processo;

async function api<T = any>(metodo: string, rota: string, corpo?: unknown): Promise<T> {
  const r = await chamar(API, metodo, rota, { cookie: cookieRoot, corpo });
  if (r.status >= 400) throw new Error(`${metodo} ${rota} → ${r.status}: ${JSON.stringify(r.corpo)}`);
  return r.corpo as T;
}

async function esperarFim(id: string): Promise<any> {
  for (let i = 0; i < 240; i++) {
    const e = await api('GET', `/execucoes/${id}`);
    if (['concluida', 'cancelada', 'erro', 'interrompida'].includes(e.status)) return e;
    await esperar(250);
  }
  throw new Error('A execução não terminou a tempo.');
}

let destinoId = '';

before(async () => {
  await subir('mock/servidor.ts', { MOCK_PORT: String(PORTA_MOCK) }, /API falsa no ar/);
  app = await subir('server/main.ts', {
    PORT: String(PORTA_APP), MASSGEN_DATA_DIR: dados, ALLOWED_DESTINATION_DOMAINS: 'localhost', MASSGEN_HOST: '', MASSGEN_CONFIAR_CLOUDFLARE_ACCESS: 'false',
    MASSGEN_ROOTS: ROOT, MASSGEN_URL_PUBLICA: `http://localhost:${PORTA_APP}`, MASSGEN_COOKIE_SEGURO: 'false', MASSGEN_SESSAO_HORAS: '12',
  }, /MassGen no ar/);
});

after(() => {
  for (const p of processos) p.kill();
  rmSync(dados, { recursive: true, force: true });
  rmSync(dadosAccess, { recursive: true, force: true });
});

// ---------------------------------------------------------------- acesso

test('sem login, só saúde, sessão e convite respondem; o resto pede para entrar', async () => {
  assert.equal((await chamar(API, 'GET', '/saude')).status, 200);
  assert.deepEqual((await chamar(API, 'GET', '/sessao')).corpo, { usuario: null, cloudflareAccess: false, bloqueio: null });
  for (const [m, r] of [['GET', '/destinos'], ['GET', '/config'], ['POST', '/destinos'], ['GET', '/usuarios'], ['GET', '/auditoria']]) {
    const x = await chamar(API, m, r, { corpo: m === 'POST' ? {} : undefined });
    assert.equal(x.status, 401, `${m} ${r}`);
    assert.equal(x.corpo.erro, 'Entre no MassGen para continuar.');
  }
});

test('primeiro acesso do root: link no console, senha mínima, uso único e login com cookie', async () => {
  const link = await linkDePrimeiroAcesso(app, ROOT);
  assert.ok(link.startsWith(`http://localhost:${PORTA_APP}/convite/`), link);
  const leitura = await chamar(API, 'GET', `/convites/${tokenDo(link)}`);
  assert.equal(leitura.corpo.email, ROOT);
  assert.equal(leitura.corpo.tipo, 'primeiro_acesso');
  const curta = await chamar(API, 'POST', `/convites/${tokenDo(link)}`, { corpo: { nome: 'Root', senha: 'curta' } });
  assert.equal(curta.status, 422);
  cookieRoot = await aceitar(API, link, 'Root Teste');
  const de_novo = await chamar(API, 'POST', `/convites/${tokenDo(link)}`, { corpo: { nome: 'Root', senha: SENHA } });
  assert.equal(de_novo.status, 404, 'o link vale uma vez só');
  const s = await api('GET', '/sessao');
  assert.equal(s.usuario.email, ROOT);
  assert.equal(s.usuario.papel, 'root');
  assert.equal(s.usuario.origem, 'sessao');
  const errada = await chamar(API, 'POST', '/sessao', { corpo: { email: ROOT, senha: 'senha-errada-000' } });
  assert.equal(errada.status, 401);
  assert.equal(errada.corpo.erro, 'E-mail ou senha incorretos.');
  const ok = await chamar(API, 'POST', '/sessao', { corpo: { email: 'Root.Teste@Empresa.com.br', senha: SENHA } });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
  cookieRoot = ok.cookie!;
  assert.equal((await chamar(API, 'GET', '/config', { cookie: cookieRoot })).corpo.usuario.email, ROOT);
});

// ---------------------------------------------------------------- massa de dados

test('a trava recusa domínio fora da lista e o de produção do pacote', async () => {
  await assert.rejects(api('POST', '/destinos', { nome: 'X', tipoAmbiente: 'sandbox', baseUrl: 'https://outro.exemplo.com', pacoteId: 'splithub' }), /não está na lista/);
  await assert.rejects(api('POST', '/destinos', { nome: 'X', tipoAmbiente: 'producao', baseUrl: `http://localhost:${PORTA_MOCK}` }), /Produção não é aceita/);
});

test('destino pelo pacote: operações padrão, segredos no cofre e teste de conexão', async () => {
  const d = await api('POST', '/destinos', {
    nome: 'API falsa', tipoAmbiente: 'desenvolvimento', baseUrl: `http://localhost:${PORTA_MOCK}`, pacoteId: 'splithub',
    variaveis: { buyer_cnpj: '11222333000181', buyer_name: 'Comprador Exemplo S.A.', buyer_state: 'SP' },
  });
  destinoId = d.id;
  const ops = await api('GET', `/destinos/${destinoId}/operacoes`);
  assert.equal(ops.length, 6);
  const sem = await api('GET', `/destinos/${destinoId}`);
  assert.deepEqual(sem.segredosFaltando, ['client_id', 'client_secret']);
  await api('PUT', `/destinos/${destinoId}/segredos`, { chave: 'client_id', valor: 'massgen' });
  const det = await api('PUT', `/destinos/${destinoId}/segredos`, { chave: 'client_secret', valor: 'massgen-segredo' });
  assert.deepEqual(det.segredosFaltando, []);
  assert.ok(!JSON.stringify(det).includes('massgen-segredo'), 'o segredo nunca volta para a tela');
  const t = await api('POST', `/destinos/${destinoId}/testar`);
  assert.ok(t.ok, JSON.stringify(t));
});

test('C-01: o caminho feliz fecha com o gabarito, inclusive a conferência assíncrona', async () => {
  const cen = await api('POST', '/cenarios/do-pacote', { pacoteId: 'splithub', cenarioId: 'c01', destinoId });
  const exe = await api('POST', `/cenarios/${cen.id}/gerar`, { semente: 11 });
  assert.equal(exe.total, 3);
  await api('POST', `/execucoes/${exe.id}/enviar`);
  const fim = await esperarFim(exe.id);
  assert.equal(fim.status, 'concluida', JSON.stringify(fim));
  assert.equal(fim.ok, 3, JSON.stringify(fim));
  const regs = await api('GET', `/execucoes/${exe.id}/registros`);
  const doc = regs.itens.find((r: any) => r.entidade === 'documento');
  assert.equal(doc.status, 'conferido');
  assert.match(doc.idRemoto, /^doc_/);
  const reqs = await api('GET', `/requisicoes?execucao=${exe.id}&limite=50`);
  const envioDoc = reqs.find((r: any) => r.fase === 'envio' && r.entidade === 'documento');
  const det = await api('GET', `/requisicoes/${envioDoc.id}`);
  assert.match(det.requisicao.corpo.contract_id, /^ctr_/, 'o id do contrato no destino entra no envio do documento');
  assert.equal(det.requisicao.cabecalhos.Authorization, 'Bearer ••••••');
  assert.ok(det.requisicao.cabecalhos['Idempotency-Key'].startsWith(`massgen-${fim.codigo}-documento-`));
  const [token] = await api('GET', `/requisicoes?destino=${destinoId}&fase=token&limite=1`);
  const detToken = await api('GET', `/requisicoes/${token.id}`);
  assert.equal(detToken.requisicao.corpo.client_secret, '••••••');
  assert.equal(detToken.resposta.corpo.access_token, '••••••');
});

test('C-05: cada caso de borda recebe a recusa esperada', async () => {
  const cen = await api('POST', '/cenarios/do-pacote', { pacoteId: 'splithub', cenarioId: 'c05', destinoId });
  const exe = await api('POST', `/cenarios/${cen.id}/gerar`, { semente: 5 });
  await api('POST', `/execucoes/${exe.id}/enviar`);
  const fim = await esperarFim(exe.id);
  assert.equal(fim.status, 'concluida');
  const regs = await api('GET', `/execucoes/${exe.id}/registros?tamanho=200`);
  const divergentes = regs.itens.filter((r: any) => r.resultado !== 'ok');
  assert.deepEqual(divergentes.map((r: any) => `${r.entidade}/${r.caso}: ${r.diferencas.join(' ')}`), []);
  const fora = regs.itens.find((r: any) => r.caso === 'destinatario_fora');
  assert.equal(fora.status, 'conferido');
});

test('reenviar com a mesma chave de idempotência devolve a mesma resposta', async () => {
  const execs = await api('GET', '/execucoes');
  const c01 = execs.find((e: any) => e.cenarioNome.startsWith('C-01'));
  const reqs = await api('GET', `/requisicoes?execucao=${c01.id}&fase=envio`);
  const forn = reqs.find((r: any) => r.entidade === 'fornecedor');
  const nova = await api('POST', `/requisicoes/${forn.id}/reenviar`, { novaChave: false });
  assert.equal(nova.status, 201);
  assert.equal(nova.resposta.cabecalhos['idempotent-replayed'], 'true');
  const outra = await api('POST', `/requisicoes/${forn.id}/reenviar`, { novaChave: true });
  assert.equal(outra.status, 409, 'chave nova com o mesmo CNPJ: o destino recusa a duplicidade');
});

test('importação do Postman: liga as requisições às entidades, guarda segredos e acusa divergências', async () => {
  const colecao = JSON.parse(readFileSync(path.join(RAIZ, 'tests', 'fixtures', 'splithub-collection.json'), 'utf8'));
  const ambiente = {
    name: 'local', values: [
      { key: 'base_url', value: `http://localhost:${PORTA_MOCK}`, enabled: true },
      { key: 'client_id', value: 'massgen', enabled: true },
      { key: 'client_secret', value: 'massgen-segredo', type: 'secret', enabled: true },
      { key: 'buyer_cnpj', value: '11222333000181', enabled: true },
      { key: 'buyer_name', value: 'Comprador Exemplo S.A.', enabled: true },
      { key: 'buyer_state', value: 'SP', enabled: true },
      { key: 'access_token', value: '', type: 'secret', enabled: true },
      { key: 'supplier_id', value: '', enabled: true },
    ],
  };
  const previa = await api('POST', '/importacao/postman/previa', { colecao, ambiente, pacoteId: 'splithub' });
  assert.equal(previa.leitura.autenticacao.tipo, 'oauth2_cc');
  assert.equal(previa.leitura.autenticacao.tokenUrl, '/public/oauth/token');
  assert.deepEqual(previa.leitura.segredos.sort(), ['client_id', 'client_secret']);
  assert.ok(previa.leitura.descartadas.includes('access_token'));
  const ligadas = previa.operacoes.filter((o: any) => o.entidade).map((o: any) => `${o.entidade}.${o.acao}`);
  assert.ok(ligadas.includes('fornecedor.criar') && ligadas.includes('documento.consultar'), ligadas.join(', '));
  assert.ok(previa.operacoes.find((o: any) => o.entidade === 'fornecedor' && o.acao === 'consultar').rota.endsWith('{{$id}}'));
  const r = await api('POST', '/importacao/postman/aplicar', { colecao, ambiente, pacoteId: 'splithub', nome: 'Importado', tipoAmbiente: 'sandbox' });
  const d = await api('GET', `/destinos/${r.destinoId}`);
  assert.deepEqual(d.segredosFaltando, []);
  assert.equal(d.variaveis.buyer_cnpj, '11222333000181');
  const doc = r.divergencias.find((x: any) => x.entidade === 'documento');
  assert.ok(doc.foraDoModelo.includes('items[].tax.ibs_cbs.v_bc'), 'a collection ainda manda a base de cálculo, que saiu no docs v1.4.0');
  const t = await api('POST', `/destinos/${r.destinoId}/testar`);
  assert.ok(t.ok, JSON.stringify(t));
});

// ---------------------------------------------------------------- v3.0, etapa 1: ambientes, biblioteca e papel

const ENV_LOCAL = () => ({
  name: 'local', values: [
    { key: 'base_url', value: `http://localhost:${PORTA_MOCK}`, enabled: true },
    { key: 'client_id', value: 'massgen', enabled: true },
    { key: 'client_secret', value: 'massgen-segredo', type: 'secret', enabled: true },
    { key: 'buyer_cnpj', value: '11222333000181', enabled: true },
    { key: 'buyer_name', value: 'Comprador Exemplo S.A.', enabled: true },
    { key: 'buyer_state', value: 'SP', enabled: true },
    { key: 'access_token', value: '', type: 'secret', enabled: true },
    { key: 'supplier_id', value: '', enabled: true },
  ],
});

function requisicoesDa(itens: any[], saida: any[] = []): any[] {
  for (const it of itens) { if (Array.isArray(it.item)) requisicoesDa(it.item, saida); else saida.push(it); }
  return saida;
}

test('ambientes: o destino da v2.0 ganha um ambiente e a integração herda o tipo dele', async () => {
  const d = await api('GET', `/destinos/${destinoId}`);
  assert.ok(d.ambiente, 'toda integração pertence a um ambiente');
  assert.equal(d.papel, 'cliente');
  assert.equal(d.status, 'pronta');
  const amb = await api('GET', `/ambientes/${d.ambiente.id}`);
  assert.equal(amb.nome, 'SplitHub — Desenvolvimento');
  assert.equal(amb.tipo, 'desenvolvimento');
  assert.ok(amb.integracoes.some((i: any) => i.id === destinoId));
  await assert.rejects(api('DELETE', `/ambientes/${amb.id}`), /integração/);
  await assert.rejects(api('POST', '/ambientes', { nome: amb.nome.toUpperCase(), tipo: 'sandbox' }), /Já existe/);
  await assert.rejects(api('POST', '/ambientes', { nome: 'Produção', tipo: 'producao' }), /Produção não é aceita/);
});

test('biblioteca: guarda collection e environment originais, sem segredos, com versão e comparação', async () => {
  const lista = await api('GET', '/biblioteca');
  const col = lista.find((x: any) => x.tipo === 'collection' && x.nome === 'SplitHub API v1 (cliente ERP)');
  const env = lista.find((x: any) => x.tipo === 'environment' && x.nome === 'local');
  assert.ok(col && env, 'a importação do Postman guardou os dois arquivos na biblioteca');
  assert.equal(col.ultima.numero, 1);
  assert.ok(col.integracoes.length >= 1);
  const det = await api('GET', `/biblioteca/${env.id}`);
  const v1 = det.versoes[0];
  assert.deepEqual(v1.resumo.segredos, ['client_id', 'client_secret']);
  assert.equal(v1.resumo.baseUrl, `http://localhost:${PORTA_MOCK}`);
  const baixado = await api('GET', `/biblioteca/versoes/${v1.id}/arquivo`);
  assert.ok(!JSON.stringify(baixado).includes('massgen-segredo'), 'o environment guardado não tem o valor do segredo');
  assert.equal(baixado.values.find((v: any) => v.key === 'client_secret').value, '');
  assert.ok(!JSON.stringify(det).includes('massgen-segredo'));

  const mesmo = await api('POST', '/biblioteca', { conteudo: ENV_LOCAL(), nomeArquivo: 'local.postman_environment.json' });
  assert.equal(mesmo.nova, false, 'arquivo igual não vira versão nova');
  assert.equal(mesmo.versao.numero, 1);
  const outroNome = ENV_LOCAL();
  outroNome.values.find((v) => v.key === 'buyer_name')!.value = 'Comprador Dois S.A.';
  const v2 = await api('POST', '/biblioteca', { conteudo: outroNome });
  assert.equal(v2.nova, true);
  assert.equal(v2.versao.numero, 2);
  const outroSegredo = structuredClone(outroNome);
  outroSegredo.values.find((v) => v.key === 'client_secret')!.value = 'segredo-trocado';
  const v3 = await api('POST', '/biblioteca', { conteudo: outroSegredo });
  assert.equal(v3.versao.numero, 3, 'segredo trocado também vira versão, sem aparecer no arquivo');
  const cmpEnv = await api('GET', `/biblioteca/comparar?de=${v1.id}&para=${v3.versao.id}`);
  assert.deepEqual(cmpEnv.alteradas.map((a: any) => `${a.chave}:${a.segredo}`).sort(), ['buyer_name:false', 'client_secret:true']);
  assert.ok(!JSON.stringify(cmpEnv).includes('segredo-trocado') && !JSON.stringify(cmpEnv).includes('massgen-segredo'));

  const colecao = JSON.parse(readFileSync(path.join(RAIZ, 'tests', 'fixtures', 'splithub-collection.json'), 'utf8'));
  const col2 = structuredClone(colecao);
  const pastaDocs = col2.item.find((p: any) => p.name.startsWith('03'));
  pastaDocs.item = pastaDocs.item.filter((r: any) => r.name !== '03.15 Consultar documento removido');
  const reqs = requisicoesDa(col2.item);
  const listar = reqs.find((r: any) => r.name === '01.2 Listar fornecedores');
  listar.request.url.raw = `${listar.request.url.raw}${listar.request.url.raw.includes('?') ? '&' : '?'}status=active`;
  const consultar = reqs.find((r: any) => r.name === '01.3 Consultar fornecedor');
  const nova = structuredClone(consultar);
  nova.name = '01.8 Histórico do fornecedor';
  nova.request.url.raw = '{{base_url}}/v1/suppliers/{{supplier_id}}/history';
  col2.item.find((p: any) => p.name.startsWith('01')).item.push(nova);
  const c2 = await api('POST', '/biblioteca', { conteudo: col2, nomeArquivo: 'splithub-v2.postman_collection.json' });
  assert.equal(c2.versao.numero, 2);
  const colDet = await api('GET', `/biblioteca/${col.id}`);
  const diff = await api('GET', `/biblioteca/comparar?de=${colDet.versoes.at(-1).id}&para=${c2.versao.id}`);
  assert.deepEqual(diff.novas.map((x: any) => x.nome), ['01.8 Histórico do fornecedor']);
  assert.deepEqual(diff.removidas.map((x: any) => x.nome), ['03.15 Consultar documento removido']);
  assert.deepEqual(diff.alteradas.map((x: any) => `${x.nome}:${x.mudou.join('+')}`), ['01.2 Listar fornecedores:rota']);
  await assert.rejects(api('POST', '/biblioteca', { conteudo: { qualquer: 1 } }), /nem um environment/);
});

test('integração pela biblioteca: cliente herda o ambiente; ente emulado aguarda rota e não recebe cenário', async () => {
  const amb = await api('POST', '/ambientes', { nome: 'SplitHub — Sandbox do teste', tipo: 'sandbox', pacoteId: 'splithub', sistema: 'SplitHub' });
  const lista = await api('GET', '/biblioteca');
  const col = await api('GET', `/biblioteca/${lista.find((x: any) => x.tipo === 'collection').id}`);
  const env = await api('GET', `/biblioteca/${lista.find((x: any) => x.tipo === 'environment' && x.nome === 'local').id}`);
  const colV1 = col.versoes.find((v: any) => v.numero === 1).id;
  const colV2 = col.versoes.find((v: any) => v.numero === 2).id;
  const envV1 = env.versoes.find((v: any) => v.numero === 1).id;

  const cli = await api('POST', `/ambientes/${amb.id}/integracoes`, { nome: 'SplitHub API v1', papel: 'cliente', colecaoVersaoId: colV1, environmentVersaoId: envV1 });
  assert.equal(cli.destino.ambiente.id, amb.id);
  assert.equal(cli.destino.tipoAmbiente, 'sandbox');
  assert.equal(cli.destino.pacoteId, 'splithub', 'sem pacote informado, vale o do ambiente');
  assert.deepEqual(cli.destino.segredosFaltando, [], 'os segredos do environment vão do cofre da biblioteca para o da integração');
  assert.equal(cli.destino.colecao.numero, 1);
  assert.equal(cli.destino.colecao.desatualizada, true, 'a collection já tem a versão 2');
  assert.equal(cli.destino.environment.numero, 1);

  await assert.rejects(api('POST', '/destinos', { nome: 'Sem ente', papel: 'emulador', ambienteId: amb.id, baseUrl: `http://localhost:${PORTA_MOCK}` }), /qual ente/);
  const emu = await api('POST', '/destinos', { nome: 'CBS — apuração assistida', papel: 'emulador', ente: 'Receita Federal', ambienteId: amb.id, baseUrl: `http://localhost:${PORTA_MOCK}` });
  const emuDet = await api('GET', `/destinos/${emu.id}`);
  assert.equal(emuDet.status, 'aguardando_rota');
  assert.equal(emuDet.ente, 'Receita Federal');
  assert.equal((await api('GET', `/destinos/${emu.id}/operacoes`)).length, 0, 'ente emulado não recebe as operações de cliente do pacote');
  const cen = await api('POST', '/cenarios/do-pacote', { pacoteId: 'splithub', cenarioId: 'c01', destinoId: emu.id });
  await assert.rejects(api('POST', `/cenarios/${cen.id}/gerar`, { semente: 1 }), /ente emulado/);

  const tv = await api('PUT', `/destinos/${cli.destinoId}/versoes`, { colecaoVersaoId: colV2 });
  assert.equal(tv.destino.colecao.numero, 2);
  assert.equal(tv.destino.colecao.desatualizada, false);
  const ops = await api('GET', `/destinos/${cli.destinoId}/operacoes`);
  assert.ok(ops.some((o: any) => o.nome === '01.8 Histórico do fornecedor'));
  assert.ok(!ops.some((o: any) => o.nome === '03.15 Consultar documento removido'));
  const colDepois = await api('GET', `/biblioteca/${col.id}`);
  assert.ok(colDepois.versoes.find((v: any) => v.numero === 2).integracoes.some((i: any) => i.id === cli.destinoId));
  await assert.rejects(api('DELETE', `/biblioteca/${col.id}`), /integrações usando/);

  const ambDet = await api('GET', `/ambientes/${amb.id}`);
  assert.deepEqual(ambDet.integracoes.map((i: any) => `${i.nome}:${i.papel}`).sort(), ['CBS — apuração assistida:emulador', 'SplitHub API v1:cliente']);
  const painel = await api('GET', '/painel');
  assert.ok(painel.ambientes.some((a: any) => a.id === amb.id));
  const trilha = await api('GET', '/auditoria?acao=biblioteca.importar&limite=20');
  assert.ok(trilha.itens?.length ?? trilha.length, 'a importação para a biblioteca entra na trilha');
});

test('rastreabilidade: o e-mail de quem entrou na trilha, código de rastreio por chamada e pacote de evidências', async () => {
  const execs = await api('GET', '/execucoes');
  const c01 = execs.find((e: any) => e.cenarioNome.startsWith('C-01'));
  assert.equal(c01.criadoPor, ROOT);
  assert.equal(c01.enviadoPor, ROOT);
  assert.equal(c01.pacoteVersao, '1.0.0');
  assert.equal(c01.destinoRetrato.baseUrl, `http://localhost:${PORTA_MOCK}`);
  assert.ok(!JSON.stringify(c01.destinoRetrato).includes('massgen-segredo'));
  const [envio] = await api('GET', `/requisicoes?execucao=${c01.id}&fase=envio&entidade=documento&limite=1`);
  const det = await api('GET', `/requisicoes/${envio.id}`);
  assert.equal(det.requisicao.cabecalhos['X-MassGen-Rastreio'], `MG-${c01.codigo}-documento-1-envio-1`);
  const trilha = await api('GET', `/execucoes/${c01.id}/trilha`);
  const acoes = trilha.map((t: any) => t.acao);
  for (const a of ['execucao.gerar', 'execucao.enviar', 'execucao.concluir']) assert.ok(acoes.includes(a), acoes.join(', '));
  assert.ok(trilha.filter((t: any) => ['execucao.gerar', 'execucao.enviar'].includes(t.acao)).every((t: any) => t.usuario === ROOT));
  const ev = await api('GET', `/execucoes/${c01.id}/rastreabilidade`);
  assert.equal(ev.execucao.codigo, c01.codigo);
  assert.equal(ev.geradoPor, ROOT);
  assert.ok(ev.registros.every((x: any) => x.rastreios.length > 0));
  assert.ok(ev.requisicoes.every((x: any) => x.hash && x.rastreio));
  assert.ok(ev.integridade.requisicoes.ok && ev.integridade.auditoria.ok);
  const segredos = await api('GET', '/auditoria?acao=destino.segredo');
  assert.ok(segredos.length >= 2 && !JSON.stringify(segredos).includes('massgen-segredo'), 'a trilha registra o segredo sem o valor');
});

// ---------------------------------------------------------------- usuários

const OPERADOR = 'opera.dora@empresa.com.br';
const LEITOR = 'lei.tor@empresa.com.br';
let cookieOperador = '';
let cookieLeitor = '';

test('convite: o root pré-cadastra, o link vale uma vez e abre a sessão com o papel definido', async () => {
  const r = await api('POST', '/usuarios', { email: ' Opera.Dora@Empresa.com.br ', nome: 'Opera Dora', papel: 'operador' });
  assert.equal(r.usuario.email, OPERADOR);
  assert.equal(r.usuario.status, 'convidado');
  const dias = (Date.parse(r.expiraEm) - Date.now()) / 86400000;
  assert.ok(dias > 6.9 && dias <= 7, `convite vale 7 dias: ${dias}`);
  assert.ok(!JSON.stringify(await api('GET', '/usuarios')).includes(tokenDo(r.link)), 'a lista nunca mostra o token');
  await assert.rejects(api('POST', '/usuarios', { email: OPERADOR, papel: 'leitor' }), /já está cadastrado/);
  await assert.rejects(api('POST', '/usuarios', { email: 'sem-arroba', papel: 'leitor' }), /e-mail válido/);
  await assert.rejects(api('POST', '/usuarios', { email: 'x@empresa.com.br', papel: 'deus' }), /Papel inválido/);
  // Antes do aceite, o convidado não entra com senha nenhuma.
  assert.equal((await chamar(API, 'POST', '/sessao', { corpo: { email: OPERADOR, senha: SENHA } })).status, 401);
  const aberto = await chamar(API, 'GET', `/convites/${tokenDo(r.link)}`);
  assert.deepEqual([aberto.corpo.email, aberto.corpo.nome, aberto.corpo.tipo], [OPERADOR, 'Opera Dora', 'convite']);
  assert.equal((await chamar(API, 'POST', `/convites/${tokenDo(r.link)}`, { corpo: { senha: OPERADOR } })).status, 422, 'a senha não pode ser o e-mail');
  cookieOperador = await aceitar(API, r.link, 'Opera Dora');
  const eu = (await chamar(API, 'GET', '/sessao', { cookie: cookieOperador })).corpo.usuario;
  assert.deepEqual([eu.email, eu.papel, eu.status], [OPERADOR, 'operador', 'ativo']);
  assert.equal((await chamar(API, 'GET', `/convites/${tokenDo(r.link)}`)).status, 404);
  // Gerar outro link invalida o anterior.
  const conv = await api('POST', '/usuarios', { email: LEITOR, papel: 'leitor' });
  const novo = await api('POST', `/usuarios/${conv.usuario.id}/link`);
  assert.equal(novo.tipo, 'convite');
  assert.equal((await chamar(API, 'GET', `/convites/${tokenDo(conv.link)}`)).status, 404);
  cookieLeitor = await aceitar(API, novo.link, 'Lei Tor');
});

test('papéis: leitor só consulta, operador não gerencia usuários, root faz tudo', async () => {
  assert.equal((await chamar(API, 'GET', '/destinos', { cookie: cookieLeitor })).status, 200);
  const escrita = await chamar(API, 'POST', '/destinos', { cookie: cookieLeitor, corpo: { nome: 'X', tipoAmbiente: 'sandbox', baseUrl: `http://localhost:${PORTA_MOCK}` } });
  assert.equal(escrita.status, 403);
  assert.match(escrita.corpo.erro, /leitor/);
  assert.equal((await chamar(API, 'POST', `/execucoes/qualquer/enviar`, { cookie: cookieLeitor })).status, 403);
  assert.equal((await chamar(API, 'GET', '/usuarios', { cookie: cookieLeitor })).status, 403);
  assert.equal((await chamar(API, 'GET', '/usuarios', { cookie: cookieOperador })).status, 403);
  assert.equal((await chamar(API, 'POST', '/usuarios', { cookie: cookieOperador, corpo: { email: 'novo@empresa.com.br', papel: 'root' } })).status, 403);
  const d = await chamar(API, 'POST', '/destinos', { cookie: cookieOperador, corpo: { nome: 'Do operador', tipoAmbiente: 'desenvolvimento', baseUrl: `http://localhost:${PORTA_MOCK}` } });
  assert.equal(d.status, 201, JSON.stringify(d.corpo));
  const [linha] = await api('GET', `/auditoria?acao=destino.criar&alvo=${d.corpo.id}`);
  assert.equal(linha.usuario, OPERADOR);
  // O leitor troca a própria senha (a troca encerra as outras sessões e devolve uma nova).
  const troca = await chamar(API, 'POST', '/sessao/senha', { cookie: cookieLeitor, corpo: { atual: SENHA, nova: 'outra-senha-456' } });
  assert.equal(troca.status, 200, JSON.stringify(troca.corpo));
  assert.equal((await chamar(API, 'GET', '/destinos', { cookie: cookieLeitor })).status, 401, 'a sessão antiga caiu');
  cookieLeitor = troca.cookie!;
  assert.equal((await chamar(API, 'GET', '/destinos', { cookie: cookieLeitor })).status, 200);
});

test('o último root ativo não perde o papel nem é desativado; ninguém desativa a si mesmo', async () => {
  const lista = await api('GET', '/usuarios');
  const root = lista.find((u: any) => u.email === ROOT);
  await assert.rejects(api('PATCH', `/usuarios/${root.id}`, { papel: 'operador' }), /último root/);
  await assert.rejects(api('PATCH', `/usuarios/${root.id}`, { status: 'desativado' }), /próprio acesso/);
});

test('sessão expirada e acesso desativado derrubam a sessão na hora', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dados, 'massgen.db'));
  const op = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(OPERADOR) as { id: string };
  db.prepare("UPDATE sessoes SET expira_em = '2000-01-01T00:00:00.000Z' WHERE usuario_id = ?").run(op.id);
  db.close();
  assert.equal((await chamar(API, 'GET', '/destinos', { cookie: cookieOperador })).status, 401, 'sessão vencida');
  const login = await chamar(API, 'POST', '/sessao', { corpo: { email: OPERADOR, senha: SENHA } });
  cookieOperador = login.cookie!;
  assert.equal((await chamar(API, 'GET', '/destinos', { cookie: cookieOperador })).status, 200);
  await api('PATCH', `/usuarios/${op.id}`, { status: 'desativado' });
  assert.equal((await chamar(API, 'GET', '/destinos', { cookie: cookieOperador })).status, 401, 'desativar encerra a sessão aberta');
  assert.equal((await chamar(API, 'POST', '/sessao', { corpo: { email: OPERADOR, senha: SENHA } })).status, 401);
  await assert.rejects(api('POST', `/usuarios/${op.id}/link`), /Reative/);
  const volta = await api('PATCH', `/usuarios/${op.id}`, { status: 'ativo' });
  assert.equal(volta.status, 'ativo', 'quem já tinha senha volta ativo');
  assert.equal((await chamar(API, 'POST', '/sessao', { corpo: { email: OPERADOR, senha: SENHA } })).status, 200);
  // Redefinição de senha pelo link do root.
  const link = await api('POST', `/usuarios/${op.id}/link`);
  assert.equal(link.tipo, 'redefinicao');
  await aceitar(API, link.link, 'Opera Dora', 'senha-nova-789');
  assert.equal((await chamar(API, 'POST', '/sessao', { corpo: { email: OPERADOR, senha: SENHA } })).status, 401);
  assert.equal((await chamar(API, 'POST', '/sessao', { corpo: { email: OPERADOR, senha: 'senha-nova-789' } })).status, 200);
});

test('login: cinco erros seguidos bloqueiam o e-mail por 15 minutos', async () => {
  const email = 'tenta.muito@empresa.com.br';
  for (let i = 0; i < 5; i++) assert.equal((await chamar(API, 'POST', '/sessao', { corpo: { email, senha: `errada-${i}-123456` } })).status, 401);
  const sexta = await chamar(API, 'POST', '/sessao', { corpo: { email, senha: 'qualquer-123456' } });
  assert.equal(sexta.status, 429);
  assert.match(sexta.corpo.erro, /15 minutos/);
});

test('a trilha registra a gestão de usuários com o e-mail de quem fez, sem senha nem token', async () => {
  const linhas = await api('GET', '/auditoria?acao=usuario.&limite=200');
  const acoes = new Set(linhas.map((l: any) => l.acao));
  for (const a of ['usuario.criar', 'usuario.primeiro_acesso', 'usuario.aceitar_convite', 'usuario.convidar', 'usuario.login', 'usuario.login_falhou',
    'usuario.login_bloqueado', 'usuario.trocar_senha', 'usuario.desativar', 'usuario.reativar', 'usuario.redefinicao', 'usuario.redefinir_senha']) {
    assert.ok(acoes.has(a), `${a} fora da trilha: ${[...acoes].join(', ')}`);
  }
  const convite = linhas.find((l: any) => l.acao === 'usuario.convidar' && l.alvoId);
  assert.equal(convite.usuario, ROOT);
  const texto = JSON.stringify(linhas);
  for (const s of [SENHA, 'outra-senha-456', 'senha-nova-789']) assert.ok(!texto.includes(s), 'senha nunca entra na trilha');
  const integridade = await api('GET', '/auditoria/integridade');
  assert.ok(integridade.auditoria.ok, JSON.stringify(integridade));
});

test('integridade: alterar uma requisição gravada é detectado', async () => {
  const antes = await api('GET', '/auditoria/integridade');
  assert.ok(antes.requisicoes.ok && antes.auditoria.ok, JSON.stringify(antes));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dados, 'massgen.db'));
  const alvo = db.prepare("SELECT id FROM requisicoes WHERE fase = 'envio' ORDER BY id LIMIT 1").get() as { id: number };
  db.prepare('UPDATE requisicoes SET status = 200 WHERE id = ?').run(alvo.id);
  db.close();
  const depois = await api('GET', '/auditoria/integridade');
  assert.equal(depois.requisicoes.ok, false);
  assert.equal(depois.requisicoes.primeiraFalha.id, alvo.id);
});

// ---------------------------------------------------------------- Cloudflare Access

const destinoSimples = { nome: 'Destino do Access', tipoAmbiente: 'desenvolvimento', baseUrl: `http://localhost:${PORTA_MOCK}` };

test('Cloudflare Access desligado: o cabeçalho do e-mail é ignorado, porque poderia ser forjado', async () => {
  const forjado = { 'cf-access-authenticated-user-email': ROOT };
  assert.equal((await chamar(API, 'GET', '/config', { cabecalhos: forjado })).status, 401);
  assert.equal((await chamar(API, 'GET', '/sessao', { cabecalhos: forjado })).corpo.usuario, null);
  // Com cookie, vale o cookie: o cabeçalho não troca a identidade.
  const r = await chamar(API, 'POST', '/destinos', { cookie: cookieLeitor, cabecalhos: forjado, corpo: destinoSimples });
  assert.equal(r.status, 403, 'segue sendo o leitor, não o root do cabeçalho');
});

test('Cloudflare Access ligado: e-mail cadastrado entra sem senha, não cadastrado recebe 403, e o app escuta só no MASSGEN_HOST', async () => {
  const ana = 'ana.teste@empresa.com.br';
  await subir('server/main.ts', {
    PORT: String(PORTA_ACCESS), MASSGEN_HOST: '127.0.0.1', MASSGEN_DATA_DIR: dadosAccess, ALLOWED_DESTINATION_DOMAINS: 'localhost',
    MASSGEN_CONFIAR_CLOUDFLARE_ACCESS: 'true', MASSGEN_ROOTS: ana, MASSGEN_URL_PUBLICA: `http://127.0.0.1:${PORTA_ACCESS}`, MASSGEN_COOKIE_SEGURO: 'false',
  }, /MassGen no ar: http:\/\/127\.0\.0\.1:/);
  const base = `http://127.0.0.1:${PORTA_ACCESS}/api`;
  const cab = { 'cf-access-authenticated-user-email': 'Ana.Teste@Empresa.com.br' };
  // Root convidado pelo MASSGEN_ROOTS: o primeiro acesso pelo Access aceita o convite.
  const s = (await chamar(base, 'GET', '/sessao', { cabecalhos: cab })).corpo;
  assert.deepEqual([s.usuario.email, s.usuario.papel, s.usuario.status, s.usuario.origem, s.cloudflareAccess], [ana, 'root', 'ativo', 'cloudflare-access', true]);
  const d = await chamar(base, 'POST', '/destinos', { cabecalhos: cab, corpo: destinoSimples });
  assert.equal(d.status, 201, JSON.stringify(d.corpo));
  const [linha] = (await chamar(base, 'GET', `/auditoria?acao=destino.criar&alvo=${d.corpo.id}`, { cabecalhos: cab })).corpo;
  assert.equal(linha.usuario, ana);
  // Convidado pelo root e autenticado pelo Access: entra direto, com o papel do convite.
  const conv = await chamar(base, 'POST', '/usuarios', { cabecalhos: cab, corpo: { email: 'beto@empresa.com.br', papel: 'leitor' } });
  assert.equal(conv.status, 201);
  const beto = (await chamar(base, 'GET', '/sessao', { cabecalhos: { 'cf-access-authenticated-user-email': 'beto@empresa.com.br' } })).corpo.usuario;
  assert.deepEqual([beto.papel, beto.status], ['leitor', 'ativo']);
  // E-mail autenticado pelo Access, mas sem cadastro: 403 com o motivo, e a tela mostra o bloqueio.
  const intruso = { 'cf-access-authenticated-user-email': 'intruso@exemplo.com' };
  const negado = await chamar(base, 'GET', '/destinos', { cabecalhos: intruso });
  assert.equal(negado.status, 403);
  assert.match(negado.corpo.erro, /não está cadastrado/);
  const sessao = (await chamar(base, 'GET', '/sessao', { cabecalhos: intruso })).corpo;
  assert.equal(sessao.usuario, null);
  assert.match(sessao.bloqueio, /não está cadastrado/);
  // Valor que não é e-mail não é aceito como identidade: cai no login normal.
  assert.equal((await chamar(base, 'GET', '/config', { cabecalhos: { 'cf-access-authenticated-user-email': 'ana.teste sem arroba' } })).status, 401);
  const [inicio] = (await chamar(base, 'GET', '/auditoria?acao=app.iniciar', { cabecalhos: cab })).corpo;
  assert.deepEqual([inicio.detalhes.host, inicio.detalhes.confiarCloudflareAccess], ['127.0.0.1', true]);
  await assert.rejects(fetch(`http://[::1]:${PORTA_ACCESS}/api/saude`), 'escutando só em 127.0.0.1, o app não responde em outro endereço');
});

// Ponta a ponta: sobe o app e a API falsa, cadastra o destino, gera e envia C-01 e C-05 e confere o gabarito.
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
const dados = mkdtempSync(path.join(tmpdir(), 'massgen-e2e-'));
const dadosAccess = mkdtempSync(path.join(tmpdir(), 'massgen-e2e-access-'));
const processos: ChildProcess[] = [];

function subir(arquivo: string, env: Record<string, string>, pronto: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [arquivo], { cwd: RAIZ, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    processos.push(p);
    let saida = '';
    const ok = (b: Buffer) => { saida += b; if (pronto.test(saida)) resolve(); };
    p.stdout!.on('data', ok);
    p.stderr!.on('data', (b) => { saida += b; });
    p.on('exit', (c) => reject(new Error(`${arquivo} saiu com ${c}: ${saida}`)));
    setTimeout(() => reject(new Error(`${arquivo} não subiu: ${saida}`)), 15000);
  });
}

async function api<T = any>(metodo: string, rota: string, corpo?: unknown): Promise<T> {
  const r = await fetch(API + rota, { method: metodo, headers: { 'content-type': 'application/json', 'x-massgen-usuario': encodeURIComponent('Ana Teste') }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  const j = texto ? JSON.parse(texto) : undefined;
  if (!r.ok) throw new Error(`${metodo} ${rota} → ${r.status}: ${texto}`);
  return j as T;
}

async function esperarFim(id: string): Promise<any> {
  for (let i = 0; i < 240; i++) {
    const e = await api('GET', `/execucoes/${id}`);
    if (['concluida', 'cancelada', 'erro', 'interrompida'].includes(e.status)) return e;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('A execução não terminou a tempo.');
}

let destinoId = '';

before(async () => {
  await subir('mock/servidor.ts', { MOCK_PORT: String(PORTA_MOCK) }, /API falsa no ar/);
  await subir('server/main.ts', {
    PORT: String(PORTA_APP), MASSGEN_DATA_DIR: dados, ALLOWED_DESTINATION_DOMAINS: 'localhost', MASSGEN_HOST: '', MASSGEN_CONFIAR_CLOUDFLARE_ACCESS: 'false',
  }, /MassGen no ar/);
});

after(() => {
  for (const p of processos) p.kill();
  rmSync(dados, { recursive: true, force: true });
  rmSync(dadosAccess, { recursive: true, force: true });
});

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

test('rastreabilidade: código de rastreio por chamada, trilha da execução e pacote de evidências', async () => {
  const execs = await api('GET', '/execucoes');
  const c01 = execs.find((e: any) => e.cenarioNome.startsWith('C-01'));
  assert.match(c01.criadoPor, /^Ana Teste · /);
  assert.match(c01.enviadoPor, /^Ana Teste · /);
  assert.equal(c01.pacoteVersao, '1.0.0');
  assert.equal(c01.destinoRetrato.baseUrl, `http://localhost:${PORTA_MOCK}`);
  assert.ok(!JSON.stringify(c01.destinoRetrato).includes('massgen-segredo'));
  const [envio] = await api('GET', `/requisicoes?execucao=${c01.id}&fase=envio&entidade=documento&limite=1`);
  const det = await api('GET', `/requisicoes/${envio.id}`);
  assert.equal(det.requisicao.cabecalhos['X-MassGen-Rastreio'], `MG-${c01.codigo}-documento-1-envio-1`);
  const trilha = await api('GET', `/execucoes/${c01.id}/trilha`);
  const acoes = trilha.map((t: any) => t.acao);
  for (const a of ['execucao.gerar', 'execucao.enviar', 'execucao.concluir']) assert.ok(acoes.includes(a), acoes.join(', '));
  const r = await fetch(`${API}/execucoes/${c01.id}/rastreabilidade`);
  const ev = await r.json();
  assert.equal(ev.execucao.codigo, c01.codigo);
  assert.ok(ev.registros.every((x: any) => x.rastreios.length > 0));
  assert.ok(ev.requisicoes.every((x: any) => x.hash && x.rastreio));
  assert.ok(ev.integridade.requisicoes.ok && ev.integridade.auditoria.ok);
  const segredos = await api('GET', '/auditoria?acao=destino.segredo');
  assert.ok(segredos.length >= 2 && !JSON.stringify(segredos).includes('massgen-segredo'), 'a trilha registra o segredo sem o valor');
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

async function chamar(base: string, metodo: string, rota: string, cabecalhos: Record<string, string>, corpo?: unknown): Promise<any> {
  const r = await fetch(base + rota, { method: metodo, headers: { 'content-type': 'application/json', ...cabecalhos }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${rota} → ${r.status}: ${texto}`);
  return texto ? JSON.parse(texto) : undefined;
}

const destinoSimples = { nome: 'Destino do Access', tipoAmbiente: 'desenvolvimento', baseUrl: `http://localhost:${PORTA_MOCK}` };

test('Cloudflare Access desligado: o cabeçalho do e-mail é ignorado, porque poderia ser forjado', async () => {
  const cab = { 'cf-access-authenticated-user-email': 'intruso@exemplo.com', 'x-massgen-usuario': encodeURIComponent('Ana Teste') };
  const cfg = await chamar(API, 'GET', '/config', cab);
  assert.equal(cfg.usuario.origem, 'interface');
  assert.match(cfg.usuario.usuario, /^Ana Teste · /);
  const d = await chamar(API, 'POST', '/destinos', cab, destinoSimples);
  const [linha] = await api('GET', `/auditoria?acao=destino.criar&alvo=${d.id}`);
  assert.match(linha.usuario, /^Ana Teste · /);
  assert.deepEqual(await api('GET', '/auditoria?usuario=intruso'), []);
  const soEmail = await chamar(API, 'GET', '/config', { 'cf-access-authenticated-user-email': 'intruso@exemplo.com' });
  assert.ok(!soEmail.usuario.usuario.includes('intruso'), soEmail.usuario.usuario);
});

test('Cloudflare Access ligado: o e-mail autenticado vira o usuário da trilha, e o app escuta só no MASSGEN_HOST', async () => {
  await subir('server/main.ts', {
    PORT: String(PORTA_ACCESS), MASSGEN_HOST: '127.0.0.1', MASSGEN_DATA_DIR: dadosAccess, ALLOWED_DESTINATION_DOMAINS: 'localhost',
    MASSGEN_CONFIAR_CLOUDFLARE_ACCESS: 'true',
  }, /MassGen no ar: http:\/\/127\.0\.0\.1:/);
  const base = `http://127.0.0.1:${PORTA_ACCESS}/api`;
  const cab = { 'cf-access-authenticated-user-email': 'Ana.Teste@Empresa.com.br', 'x-massgen-usuario': encodeURIComponent('Outro Nome') };
  const cfg = await chamar(base, 'GET', '/config', cab);
  assert.deepEqual(cfg.usuario, { usuario: 'ana.teste@empresa.com.br', maquina: cfg.usuario.maquina, origem: 'cloudflare-access' });
  const d = await chamar(base, 'POST', '/destinos', cab, destinoSimples);
  const [linha] = await chamar(base, 'GET', `/auditoria?acao=destino.criar&alvo=${d.id}`, {});
  assert.equal(linha.usuario, 'ana.teste@empresa.com.br', 'o nome digitado não substitui o e-mail do Access');
  // Sem o cabeçalho (acesso direto pela própria VM), vale o nome informado na interface.
  const direto = await chamar(base, 'GET', '/config', { 'x-massgen-usuario': encodeURIComponent('Admin') });
  assert.equal(direto.usuario.origem, 'interface');
  assert.match(direto.usuario.usuario, /^Admin · /);
  // Valor que não é e-mail não é aceito como identidade.
  const torto = await chamar(base, 'GET', '/config', { 'cf-access-authenticated-user-email': 'ana.teste sem arroba' });
  assert.equal(torto.usuario.origem, 'interface');
  const [inicio] = await chamar(base, 'GET', '/auditoria?acao=app.iniciar', {});
  assert.deepEqual([inicio.detalhes.host, inicio.detalhes.confiarCloudflareAccess], ['127.0.0.1', true]);
  await assert.rejects(fetch(`http://[::1]:${PORTA_ACCESS}/api/saude`), 'escutando só em 127.0.0.1, o app não responde em outro endereço');
});

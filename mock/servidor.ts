// API falsa no estilo do SplitHub, para testar o MassGen sem sandbox: npm run mock (porta 8089).
// Credenciais: MOCK_CLIENT_ID / MOCK_CLIENT_SECRET (padrão massgen / massgen-segredo).
// Compradores cadastrados: MOCK_BUYERS (padrão 11222333000181).
// Falhas de teste: MOCK_FALHA_429 e MOCK_FALHA_500, probabilidades de 0 a 1.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chaveValida, cnpjValido } from '../server/core/br.ts';

const PORTA = Number(process.env.MOCK_PORT || 8089);
const CLIENT_ID = process.env.MOCK_CLIENT_ID || 'massgen';
const CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || 'massgen-segredo';
const COMPRADORES = new Set((process.env.MOCK_BUYERS || '11222333000181').split(',').map((s) => s.trim()));
const FALHA_429 = Number(process.env.MOCK_FALHA_429 || 0);
const FALHA_500 = Number(process.env.MOCK_FALHA_500 || 0);

const tokens = new Map<string, number>();
const fornecedores = new Map<string, Record<string, any>>();
const contratos = new Map<string, Record<string, any>>();
const documentos = new Map<string, Record<string, any> & { leituras: number }>();
const idempotencia = new Map<string, { hash: string; status: number; corpo: unknown }>();
let restantes = 1000;
setInterval(() => { restantes = 1000; }, 60000).unref();

const id = (p: string) => `${p}_${randomBytes(4).toString('hex')}`;
const erro = (status: number, codigo: string, mensagem: string) => ({ status, corpo: { error: codigo, message: mensagem } });

async function ler(req: IncomingMessage): Promise<{ texto: string; json: any }> {
  const partes: Buffer[] = [];
  for await (const p of req) partes.push(p as Buffer);
  const texto = Buffer.concat(partes).toString('utf8');
  let json: any;
  try { json = texto ? JSON.parse(texto) : undefined; } catch { json = undefined; }
  if (json === undefined && texto.includes('=')) json = Object.fromEntries(new URLSearchParams(texto));
  return { texto, json };
}

function responder(res: ServerResponse, status: number, corpo: unknown, extra: Record<string, string> = {}): void {
  restantes = Math.max(0, restantes - 1);
  res.writeHead(status, { 'content-type': 'application/json', 'ratelimit-limit': '1000', 'ratelimit-remaining': String(restantes), 'ratelimit-reset': '60', ...extra });
  res.end(corpo === undefined ? '' : JSON.stringify(corpo));
}

const OBRIGATORIOS_CONTRATO = ['external_contract_id', 'description', 'buyer_cnpj', 'supplier_cnpj', 'start_date', 'end_date', 'total_value', 'payment_conditions', 'payment_method', 'payment_term_days', 'autorenew', 'rad_eligible'];

function rotear(metodo: string, partes: string[], q: URLSearchParams, b: any): { status: number; corpo: unknown } {
  const [v1, recurso, rid, sub] = partes;
  if (v1 !== 'v1') return erro(404, 'not_found', 'Rota não encontrada.');

  if (recurso === 'suppliers') {
    if (metodo === 'POST' && !rid) {
      if (!b?.cnpj || !b?.legal_name) return erro(422, 'validation_error', 'cnpj e legal_name são obrigatórios.');
      if (!cnpjValido(String(b.cnpj))) return erro(422, 'invalid_cnpj', 'CNPJ inválido.');
      if ([...fornecedores.values()].some((f) => f.cnpj === b.cnpj)) return erro(409, 'supplier_already_exists', 'Já existe fornecedor com este CNPJ.');
      const f = { ...b, id: id('forn'), status: 'active', created_at: new Date().toISOString() };
      fornecedores.set(f.id, f);
      return { status: 201, corpo: { id: f.id, cnpj: f.cnpj, legal_name: f.legal_name, status: f.status, created_at: f.created_at } };
    }
    if (metodo === 'GET' && !rid) {
      const tamanho = Number(q.get('page_size') || 20);
      const dados = [...fornecedores.values()].slice(0, tamanho);
      return { status: 200, corpo: { data: dados, pagination: { page: Number(q.get('page') || 1), page_size: tamanho, total: fornecedores.size } } };
    }
    const f = fornecedores.get(rid);
    if (!f) return erro(404, 'not_found', 'Fornecedor não encontrado.');
    if (metodo === 'GET') return { status: 200, corpo: f };
    if (metodo === 'PATCH' && sub === 'status') { f.status = b?.status ?? f.status; return { status: 200, corpo: { id: f.id, status: f.status } }; }
  }

  if (recurso === 'contracts') {
    if (metodo === 'POST' && !rid) {
      const faltando = OBRIGATORIOS_CONTRATO.filter((k) => b?.[k] === undefined || b?.[k] === '');
      if (faltando.length) return erro(422, 'validation_error', `Campos obrigatórios: ${faltando.join(', ')}.`);
      const f = [...fornecedores.values()].find((x) => x.cnpj === b.supplier_cnpj);
      if (!f) return erro(422, 'supplier_not_found', 'Fornecedor não cadastrado.');
      if (f.status !== 'active') return erro(409, 'supplier_inactive', 'Fornecedor inativo.');
      if (!COMPRADORES.has(String(b.buyer_cnpj))) return erro(422, 'buyer_not_found', 'Comprador fora da organização.');
      if (!(String(b.end_date) > String(b.start_date))) return erro(422, 'invalid_period', 'O fim da vigência precisa ser depois do início.');
      if ([...contratos.values()].some((c) => c.external_contract_id === b.external_contract_id)) return erro(409, 'contract_already_exists', 'external_contract_id repetido.');
      const c = { ...b, id: id('ctr'), status: 'active', term_status: 'in_force', created_at: new Date().toISOString() };
      contratos.set(c.id, c);
      return { status: 201, corpo: { id: c.id, external_contract_id: c.external_contract_id, status: c.status, term_status: c.term_status, created_at: c.created_at } };
    }
    const c = contratos.get(rid);
    if (!c) return erro(404, 'not_found', 'Contrato não encontrado.');
    if (metodo === 'GET') return { status: 200, corpo: c };
  }

  if (recurso === 'fiscal-documents') {
    if (metodo === 'POST' && !rid) {
      if (!b?.type || !b?.model || !b?.access_key) return erro(422, 'validation_error', 'type, model e access_key são obrigatórios.');
      if (!chaveValida(String(b.access_key))) return erro(422, 'invalid_access_key', 'Chave de acesso inválida.');
      if (!Array.isArray(b.items) || !b.items.length) return erro(422, 'validation_error', 'O documento precisa de itens.');
      if ([...documentos.values()].some((d) => d.access_key === b.access_key)) return erro(409, 'duplicate_access_key', 'Chave de acesso já enviada.');
      if (b.contract_id && !contratos.has(b.contract_id)) return erro(422, 'contract_not_found', 'Contrato inexistente ou fora de vigência.');
      if (b.override_contract_params && (!b.payment_method || !b.payment_term_days)) return erro(422, 'validation_error', 'Com override_contract_params, payment_method e payment_term_days são obrigatórios.');
      const d = { ...b, id: id('doc'), status: 'pending', leituras: 0, received_at: new Date().toISOString() };
      documentos.set(d.id, d);
      return { status: 202, corpo: { id: d.id, access_key: d.access_key, status: 'pending', received_at: d.received_at } };
    }
    const d = documentos.get(rid);
    if (!d) return erro(404, 'not_found', 'Documento não encontrado.');
    if (metodo === 'GET') {
      d.leituras++;
      if (d.leituras >= 2 && d.status === 'pending') {
        if (COMPRADORES.has(String(d.destination?.cnpj_cpf))) d.status = 'completed';
        else { d.status = 'error'; d.failure = { code: 'recipient_not_registered', message: 'Destinatário fora da organização.' }; }
      }
      const { leituras: _l, ...visivel } = d;
      return { status: 200, corpo: { ...visivel, status: d.leituras < 2 ? 'processing' : d.status } };
    }
  }
  return erro(404, 'not_found', 'Rota não encontrada.');
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { texto, json } = await ler(req);
  const metodo = req.method ?? 'GET';

  if (url.pathname === '/public/oauth/token' && metodo === 'POST') {
    let cid = json?.client_id;
    let sec = json?.client_secret;
    const basic = req.headers.authorization?.match(/^Basic (.+)$/);
    if (basic) [cid, sec] = Buffer.from(basic[1], 'base64').toString().split(':');
    if (json?.grant_type !== 'client_credentials') return responder(res, 400, { error: 'unsupported_grant_type', message: 'Use client_credentials.' });
    if (cid !== CLIENT_ID || sec !== CLIENT_SECRET) return responder(res, 401, { error: 'invalid_client', message: 'Credencial inválida.' });
    const t = randomBytes(24).toString('base64url');
    tokens.set(t, Date.now() + 720_000);
    return responder(res, 200, { access_token: t, token_type: 'Bearer', expires_in: 720, scope: ['suppliers:read', 'suppliers:write', 'contracts:read', 'contracts:write', 'dfs:read', 'dfs:write'] });
  }

  const tok = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!tok || !tokens.has(tok)) return responder(res, 401, { error: 'unauthorized', message: 'Token ausente ou inválido.' });
  if (tokens.get(tok)! < Date.now()) return responder(res, 401, { error: 'token_expired', message: 'Access token has expired.' });
  if (Math.random() < FALHA_429) return responder(res, 429, { error: 'rate_limited', message: 'Limite atingido.' }, { 'retry-after': '1' });
  if (Math.random() < FALHA_500) return responder(res, 500, { error: 'internal_error', message: 'Falha simulada.' });

  const chave = req.headers['idempotency-key'];
  const hash = createHash('sha256').update(texto).digest('hex');
  if (typeof chave === 'string' && metodo !== 'GET') {
    const anterior = idempotencia.get(chave);
    if (anterior) {
      if (anterior.hash !== hash) return responder(res, 409, { error: 'idempotency_key_reused', message: 'Mesma chave com corpo diferente.' });
      return responder(res, anterior.status, anterior.corpo, { 'idempotent-replayed': 'true' });
    }
  }
  const r = rotear(metodo, url.pathname.split('/').filter(Boolean), url.searchParams, json);
  if (typeof chave === 'string' && metodo !== 'GET' && r.status < 500) idempotencia.set(chave, { hash, status: r.status, corpo: r.corpo });
  responder(res, r.status, r.corpo);
}).listen(PORTA, () => {
  console.log(`API falsa no ar: http://localhost:${PORTA} · client_id ${CLIENT_ID} · compradores ${[...COMPRADORES].join(', ')}`);
});

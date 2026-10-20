// Leitura de collection (Postman v2.1) e environment do Postman.
// Scripts nunca são executados: são lidos só para descobrir variáveis de execução e o endpoint de token.

export interface Autenticacao {
  tipo: 'nenhuma' | 'chave_api' | 'basic' | 'bearer' | 'oauth2_cc';
  cabecalho?: string;
  usuario?: string;
  tokenUrl?: string;
  formato?: 'json' | 'form';
  escopo?: string;
}

export interface OperacaoImportada {
  nome: string;
  pasta: string;
  metodo: string;
  rota: string;
  cabecalhos: Record<string, string>;
  corpo?: string;
  descricao?: string;
  eToken: boolean;
}

export interface ResultadoLeitura {
  nomeColecao: string;
  baseUrl?: string;
  variavelBase?: string;
  variaveis: Record<string, string>;
  segredos: Record<string, string>;
  segredosVazios: string[];
  descartadas: string[];
  autenticacao?: Autenticacao;
  operacoes: OperacaoImportada[];
  avisos: string[];
}

const RE_SET = /(?:\.set|\bset|\blocal)\(\s*["'`]([A-Za-z_][\w.-]*)["'`]/g;
const RE_TOKEN_URL = /["'`](\/[^"'`\s]*token[^"'`\s]*)["'`]/i;
const NOMES_BASE = /^(base_?url|url_?base|baseurl|host|api_?url)$/i;
const NOMES_SEGREDO = /(secret|password|senha|passwd|api[_-]?key|apikey|client_id|clientid|private)/i;
const NOMES_EXECUCAO = /^(access_token|token|token_expires_at|refresh_token|id_token)$/i;

type Qualquer = any;

// Como o app trata uma variável de environment. A mesma regra vale para a importação e para a biblioteca de APIs.
export function classificarVariavel(chave: string, tipo?: string): 'base' | 'execucao' | 'segredo' | 'comum' {
  if (NOMES_BASE.test(chave)) return 'base';
  if (NOMES_EXECUCAO.test(chave)) return 'execucao';
  if (tipo === 'secret' || NOMES_SEGREDO.test(chave)) return 'segredo';
  return 'comum';
}

function scriptsDe(item: Qualquer): string[] {
  return (item?.event ?? []).map((e: Qualquer) => (Array.isArray(e?.script?.exec) ? e.script.exec.join('\n') : String(e?.script?.exec ?? '')));
}

function percorrer(itens: Qualquer[], pasta: string[], saida: { req: Qualquer; pasta: string[] }[], scripts: string[]): void {
  for (const it of itens ?? []) {
    scripts.push(...scriptsDe(it));
    if (Array.isArray(it.item)) percorrer(it.item, [...pasta, it.name ?? ''], saida, scripts);
    else if (it.request) saida.push({ req: it, pasta });
  }
}

function urlCrua(url: Qualquer): string {
  if (typeof url === 'string') return url;
  if (url?.raw) return String(url.raw);
  const host = Array.isArray(url?.host) ? url.host.join('.') : url?.host ?? '';
  const caminho = Array.isArray(url?.path) ? '/' + url.path.join('/') : '';
  return `${host}${caminho}`;
}

function inferirAuth(auth: Qualquer, tokenUrl: string | undefined): Autenticacao | undefined {
  if (!auth?.type) return undefined;
  const valor = (k: string) => (auth[auth.type] ?? []).find((x: Qualquer) => x.key === k)?.value;
  if (auth.type === 'noauth') return { tipo: 'nenhuma' };
  if (auth.type === 'bearer') return tokenUrl ? { tipo: 'oauth2_cc', tokenUrl, formato: 'json' } : { tipo: 'bearer' };
  if (auth.type === 'apikey') return { tipo: 'chave_api', cabecalho: String(valor('key') ?? 'X-API-Key') };
  if (auth.type === 'basic') return { tipo: 'basic', usuario: String(valor('username') ?? '') };
  if (auth.type === 'oauth2') {
    const url = valor('accessTokenUrl');
    return { tipo: 'oauth2_cc', tokenUrl: url ? String(url) : tokenUrl, formato: 'form' };
  }
  return undefined;
}

export function lerPostman(colecao: Qualquer, ambiente?: Qualquer): ResultadoLeitura {
  if (!colecao?.info || !Array.isArray(colecao.item)) {
    throw new Error('O arquivo não parece uma collection do Postman (v2.1): faltam "info" e "item".');
  }
  const schema = String(colecao.info.schema ?? '');
  const avisos: string[] = [];
  if (schema && !schema.includes('v2.1') && !schema.includes('v2.0')) avisos.push(`Formato da collection: ${schema}. O app lê o v2.1.`);

  const brutas: { chave: string; valor: string; tipo?: string }[] = [];
  for (const v of colecao.variable ?? []) brutas.push({ chave: v.key, valor: String(v.value ?? ''), tipo: v.type });
  if (ambiente) {
    if (!Array.isArray(ambiente.values)) throw new Error('O environment não tem a lista "values" do Postman.');
    for (const v of ambiente.values) {
      if (v.enabled === false) continue;
      const i = brutas.findIndex((b) => b.chave === v.key);
      const item = { chave: v.key, valor: String(v.value ?? ''), tipo: v.type };
      if (i >= 0) brutas[i] = item; else brutas.push(item);
    }
  }

  const reqs: { req: Qualquer; pasta: string[] }[] = [];
  const scripts: string[] = [...scriptsDe(colecao)];
  percorrer(colecao.item, [], reqs, scripts);
  const textoScripts = scripts.join('\n');
  const setPorScript = new Set([...textoScripts.matchAll(RE_SET)].map((m) => m[1]));
  const tokenNoScript = /client_credentials/.test(textoScripts) ? textoScripts.match(RE_TOKEN_URL)?.[1] : undefined;

  const variaveis: Record<string, string> = {};
  const segredos: Record<string, string> = {};
  const segredosVazios: string[] = [];
  const descartadas: string[] = [];
  let baseUrl: string | undefined;
  let variavelBase: string | undefined;
  for (const b of brutas) {
    if (NOMES_BASE.test(b.chave) && !variavelBase) { variavelBase = b.chave; baseUrl = b.valor || undefined; continue; }
    if (NOMES_EXECUCAO.test(b.chave)) { descartadas.push(b.chave); continue; }
    if (b.tipo === 'secret' || NOMES_SEGREDO.test(b.chave)) {
      if (b.valor) segredos[b.chave] = b.valor; else segredosVazios.push(b.chave);
      continue;
    }
    if (setPorScript.has(b.chave) || !b.valor) { descartadas.push(b.chave); continue; }
    variaveis[b.chave] = b.valor;
  }
  if (Object.keys(segredos).length) avisos.push(`O environment trouxe ${Object.keys(segredos).length} segredo(s) preenchido(s): vão para o cofre, e o environment guardado na biblioteca fica sem os valores.`);

  let tokenUrl = tokenNoScript;
  const operacoes: OperacaoImportada[] = [];
  for (const { req: it, pasta } of reqs) {
    const r = it.request;
    let rota = urlCrua(r.url).trim();
    const base = variavelBase ? `{{${variavelBase}}}` : undefined;
    if (base && rota.startsWith(base)) rota = rota.slice(base.length);
    else if (/^https?:\/\//i.test(rota)) {
      try {
        const u = new URL(rota);
        if (baseUrl && rota.startsWith(baseUrl)) rota = rota.slice(baseUrl.replace(/\/$/, '').length);
        else { avisos.push(`${it.name}: endereço absoluto ${u.origin}, fora do endereço base; a operação foi mantida com a URL completa.`); }
      } catch { /* mantém */ }
    }
    if (!rota.startsWith('/') && !/^https?:/i.test(rota)) rota = '/' + rota;
    const cabecalhos: Record<string, string> = {};
    for (const h of r.header ?? []) {
      if (h.disabled || !h.key) continue;
      if (/^authorization$/i.test(h.key) || /idempotency/i.test(h.key)) continue;
      cabecalhos[h.key] = String(h.value ?? '');
    }
    let corpo: string | undefined;
    if (r.body?.mode === 'raw' && r.body.raw) corpo = String(r.body.raw);
    else if (r.body?.mode === 'urlencoded') corpo = JSON.stringify(Object.fromEntries((r.body.urlencoded ?? []).map((x: Qualquer) => [x.key, x.value])), null, 2);
    else if (r.body?.mode === 'formdata') avisos.push(`${it.name}: corpo multipart (formdata) não é usado pelo app; envie arquivos pelo canal de arquivo.`);
    const eToken = /client_credentials/.test(corpo ?? '') || /grant_type/.test(corpo ?? '');
    if (eToken && !tokenUrl) tokenUrl = rota;
    const desc = typeof r.description === 'string' ? r.description : r.description?.content;
    operacoes.push({ nome: String(it.name ?? `${r.method} ${rota}`), pasta: pasta.filter(Boolean).join(' / '), metodo: String(r.method ?? 'GET').toUpperCase(), rota, cabecalhos, corpo, descricao: desc, eToken });
  }

  let autenticacao = inferirAuth(colecao.auth, tokenUrl);
  if (!autenticacao && tokenUrl) autenticacao = { tipo: 'oauth2_cc', tokenUrl, formato: 'json' };
  if (autenticacao?.tipo === 'oauth2_cc' && tokenUrl) {
    const op = operacoes.find((o) => o.rota === tokenUrl);
    autenticacao.formato = op?.corpo?.trim().startsWith('{') === false ? 'form' : 'json';
  }
  if (setPorScript.size) avisos.push('Os scripts da collection não são executados. O app gera os valores e encadeia os ids pela própria execução.');
  return { nomeColecao: String(colecao.info.name ?? 'Collection'), baseUrl, variavelBase, variaveis, segredos, segredosVazios, descartadas, autenticacao, operacoes, avisos };
}

// Rota sem parâmetros e sem query, para comparar operações: /v1/suppliers/{{x}} -> /v1/suppliers/{}
export function normalizarRota(rota: string): string {
  return rota.split('?')[0]
    .split('/')
    .map((s) => (/^\{\{.+\}\}$/.test(s) || s.startsWith(':') ? '{}' : s))
    .join('/')
    .replace(/\/$/, '');
}

// Corpo modelo do Postman para JSON comparável: placeholders soltos viram null.
export function corpoComoJson(corpo: string | undefined | null): unknown {
  if (!corpo) return undefined;
  try {
    return JSON.parse(corpo.replace(/(?<!")\{\{[^}]+\}\}(?!")/g, 'null'));
  } catch {
    return undefined;
  }
}

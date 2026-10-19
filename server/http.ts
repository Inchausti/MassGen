// Roteador HTTP mínimo sobre node:http: rotas com parâmetros, corpo JSON e erros padronizados.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAQUINA, contexto, type ContextoUso, type Papel } from './auditoria.ts';

export class ErroHttp extends Error {
  status: number;
  detalhes?: unknown;
  constructor(status: number, mensagem: string, detalhes?: unknown) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  corpo: any;
  quem: ContextoUso | null;
}

export interface Resposta {
  __resposta: true;
  status: number;
  cabecalhos?: Record<string, string>;
  corpo: string | Buffer;
}

export function arquivo(corpo: string | Buffer, tipo: string, nome: string): Resposta {
  return {
    __resposta: true,
    status: 200,
    corpo,
    cabecalhos: { 'content-type': tipo, 'content-disposition': `attachment; filename="${nome}"` },
  };
}

export function criado(corpo: unknown): Resposta {
  return { __resposta: true, status: 201, corpo: JSON.stringify(corpo), cabecalhos: { 'content-type': 'application/json; charset=utf-8' } };
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

// publico: dispensa login. papeis: só esses papéis usam a rota. leitorPode: leitor usa a rota mesmo não sendo GET.
export interface OpcoesRota { publico?: boolean; papeis?: Papel[]; leitorPode?: boolean }
interface Rota { metodo: string; partes: string[]; handler: Handler; opcoes: OpcoesRota }

export class Roteador {
  rotas: Rota[] = [];
  // Quem fez a requisição (sessão ou Cloudflare Access). Definido por quem monta as rotas.
  identificar?: (req: IncomingMessage) => ContextoUso | null;

  add(metodo: string, padrao: string, handler: Handler, opcoes: OpcoesRota = {}): void {
    this.rotas.push({ metodo, partes: padrao.split('/').filter(Boolean), handler, opcoes });
  }
  get(p: string, h: Handler, o?: OpcoesRota) { this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: OpcoesRota) { this.add('POST', p, h, o); }
  put(p: string, h: Handler, o?: OpcoesRota) { this.add('PUT', p, h, o); }
  patch(p: string, h: Handler, o?: OpcoesRota) { this.add('PATCH', p, h, o); }
  delete(p: string, h: Handler, o?: OpcoesRota) { this.add('DELETE', p, h, o); }

  encontrar(metodo: string, caminho: string): { handler: Handler; params: Record<string, string>; opcoes: OpcoesRota } | undefined {
    const partes = caminho.split('/').filter(Boolean).map(decodeURIComponent);
    for (const r of this.rotas) {
      if (r.metodo !== metodo || r.partes.length !== partes.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < partes.length; i++) {
        if (r.partes[i].startsWith(':')) params[r.partes[i].slice(1)] = partes[i];
        else if (r.partes[i] !== partes[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params, opcoes: r.opcoes };
    }
    return undefined;
  }
}

export async function lerCorpo(req: IncomingMessage, limite = 25 * 1024 * 1024): Promise<any> {
  const pedacos: Buffer[] = [];
  let tamanho = 0;
  for await (const p of req) {
    tamanho += p.length;
    if (tamanho > limite) throw new ErroHttp(413, 'Corpo maior que o limite de 25 MB.');
    pedacos.push(p as Buffer);
  }
  if (!tamanho) return undefined;
  const texto = Buffer.concat(pedacos).toString('utf8');
  try {
    return JSON.parse(texto);
  } catch {
    throw new ErroHttp(400, 'O corpo da requisição não é um JSON válido.');
  }
}

export function responderJson(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(corpo === undefined ? '' : JSON.stringify(corpo));
}

export async function despachar(rot: Roteador, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const achado = rot.encontrar(req.method ?? 'GET', url.pathname);
  if (!achado) return false;
  let quem: ContextoUso | null = null;
  try {
    quem = rot.identificar ? rot.identificar(req) : null;
  } catch (e) {
    if (!achado.opcoes.publico) {
      const err = e instanceof ErroHttp ? e : new ErroHttp(500, (e as Error).message);
      responderJson(res, err.status, { erro: err.message });
      return true;
    }
  }
  if (!achado.opcoes.publico) {
    if (!quem) { responderJson(res, 401, { erro: 'Entre no MassGen para continuar.' }); return true; }
    if (achado.opcoes.papeis && !achado.opcoes.papeis.includes(quem.papel!)) {
      responderJson(res, 403, { erro: `Só ${achado.opcoes.papeis.join(' ou ')} pode fazer isto.` });
      return true;
    }
    if (quem.papel === 'leitor' && !['GET', 'HEAD'].includes(req.method ?? 'GET') && !achado.opcoes.leitorPode) {
      responderJson(res, 403, { erro: 'Seu papel é leitor: você pode consultar, mas não alterar.' });
      return true;
    }
  }
  // Cada requisição roda com quem está agindo; envios disparados aqui herdam o contexto (e a trilha registra o e-mail).
  const ctx: ContextoUso = quem ?? { usuario: 'anônimo', maquina: MAQUINA, origem: 'anonimo' };
  await contexto.run(ctx, () => executarRota(achado, req, res, url, quem));
  return true;
}

async function executarRota(achado: { handler: Handler; params: Record<string, string> }, req: IncomingMessage, res: ServerResponse, url: URL, quem: ContextoUso | null): Promise<void> {
  try {
    const corpo = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? await lerCorpo(req) : undefined;
    const r = await achado.handler({ req, res, params: achado.params, query: url.searchParams, corpo, quem });
    if (res.writableEnded) return;
    if (r && typeof r === 'object' && (r as Resposta).__resposta) {
      const rr = r as Resposta;
      res.writeHead(rr.status, { 'cache-control': 'no-store', ...rr.cabecalhos });
      res.end(rr.corpo);
    } else if (r === undefined) {
      res.writeHead(204).end();
    } else {
      responderJson(res, 200, r);
    }
  } catch (e) {
    if (e instanceof ErroHttp) {
      responderJson(res, e.status, { erro: e.message, detalhes: e.detalhes });
    } else {
      console.error(e);
      responderJson(res, 500, { erro: 'Erro interno no app.', detalhes: (e as Error).message });
    }
  }
}

export function exigir<T>(valor: T | undefined | null, mensagem = 'Não encontrado.'): T {
  if (valor === undefined || valor === null) throw new ErroHttp(404, mensagem);
  return valor;
}

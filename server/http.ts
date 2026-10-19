// Roteador HTTP mínimo sobre node:http: rotas com parâmetros, corpo JSON e erros padronizados.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { contexto, contextoDaRequisicao } from './auditoria.ts';

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
interface Rota { metodo: string; partes: string[]; handler: Handler }

export class Roteador {
  rotas: Rota[] = [];

  add(metodo: string, padrao: string, handler: Handler): void {
    this.rotas.push({ metodo, partes: padrao.split('/').filter(Boolean), handler });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  put(p: string, h: Handler) { this.add('PUT', p, h); }
  patch(p: string, h: Handler) { this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { this.add('DELETE', p, h); }

  encontrar(metodo: string, caminho: string): { handler: Handler; params: Record<string, string> } | undefined {
    const partes = caminho.split('/').filter(Boolean).map(decodeURIComponent);
    for (const r of this.rotas) {
      if (r.metodo !== metodo || r.partes.length !== partes.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < partes.length; i++) {
        if (r.partes[i].startsWith(':')) params[r.partes[i].slice(1)] = partes[i];
        else if (r.partes[i] !== partes[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
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
  // Cada requisição da interface roda com quem está agindo; envios disparados aqui herdam o contexto.
  await contexto.run(contextoDaRequisicao(req.headers['x-massgen-usuario']), () => executarRota(achado, req, res, url));
  return true;
}

async function executarRota(achado: { handler: Handler; params: Record<string, string> }, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const corpo = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? await lerCorpo(req) : undefined;
    const r = await achado.handler({ req, res, params: achado.params, query: url.searchParams, corpo });
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

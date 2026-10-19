// Cliente HTTP do app: autenticação por destino, limite de taxa, registro mascarado de cada chamada.
import { conferirDominio } from '../config.ts';
import { agora } from '../db.ts';
import { gravarRequisicao, sha256, usuarioAtual } from '../auditoria.ts';
import { dominiosProducaoDo, segredo, type Destino } from '../servicos/destinos.ts';

export interface Requisicao {
  metodo: string;
  url: string;
  cabecalhos: Record<string, string>;
  corpo?: string;
}

export interface Resposta {
  status?: number;
  cabecalhos: Record<string, string>;
  corpoTexto: string;
  corpo: unknown;
  duracaoMs: number;
  erro?: string;
}

export class ErroEnvio extends Error {}

export function montarUrl(destino: Destino, rota: string): string {
  if (/^https?:\/\//i.test(rota)) return rota;
  return destino.baseUrl.replace(/\/$/, '') + (rota.startsWith('/') ? rota : `/${rota}`);
}

// ---------------------------------------------------------------- limite de taxa por destino

const proximoHorario = new Map<string, number>();

export async function aguardarVez(destino: Destino): Promise<void> {
  const porMinuto = Math.max(1, Number(destino.limites.porMinuto) || 600);
  const intervalo = 60000 / porMinuto;
  const agoraMs = Date.now();
  const vez = Math.max(agoraMs, proximoHorario.get(destino.id) ?? 0);
  proximoHorario.set(destino.id, vez + intervalo);
  if (vez > agoraMs) await new Promise((r) => setTimeout(r, vez - agoraMs));
}

// ---------------------------------------------------------------- máscaras

const CAB_SENSIVEIS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const CORPO_SENSIVEL = /("(?:client_secret|password|senha|access_token|refresh_token|id_token|api_key|token)"\s*:\s*")[^"]*(")/gi;

export function mascararCabecalhos(c: Record<string, string>, extra: string[] = []): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (CAB_SENSIVEIS.test(k) || extra.some((e) => e.toLowerCase() === k.toLowerCase())) {
      const [esquema] = String(v).split(' ');
      saida[k] = /^(bearer|basic)$/i.test(esquema) ? `${esquema} ••••••` : '••••••';
    } else saida[k] = v;
  }
  return saida;
}

export function mascararCorpo(texto: string | undefined): string | undefined {
  if (!texto) return texto;
  return texto.replace(CORPO_SENSIVEL, '$1••••••$2').replace(/(client_secret=)[^&]*/gi, '$1••••••');
}

// ---------------------------------------------------------------- registro de requisições

export interface DadosRegistro {
  execucaoId?: string;
  destinoId: string;
  registroId?: string;
  operacaoId?: string;
  fase: 'token' | 'envio' | 'conferencia' | 'teste' | 'reenvio';
  entidade?: string;
  tentativa?: number;
  chaveIdempotencia?: string;
  resultado?: 'ok' | 'divergente' | 'erro';
  codigoErro?: string;
  rastreio?: string;
}

const LIMITE_CORPO = 256 * 1024;
const cortar = (s: string | undefined) => (s && s.length > LIMITE_CORPO ? s.slice(0, LIMITE_CORPO) + '\n…(cortado)' : s);

// Cada tentativa vira uma linha encadeada por hash, com quem disparou, o código de rastreio e o hash do corpo enviado.
export function registrar(d: DadosRegistro, req: Requisicao, res: Resposta, cabecalhoChaveApi?: string): number {
  return gravarRequisicao({
    execucao_id: d.execucaoId ?? null, destino_id: d.destinoId, registro_id: d.registroId ?? null, operacao_id: d.operacaoId ?? null,
    fase: d.fase, entidade: d.entidade ?? null, metodo: req.metodo, url: req.url, status: res.status ?? null, duracao_ms: res.duracaoMs,
    tentativa: d.tentativa ?? 1, chave_idempotencia: d.chaveIdempotencia ?? null,
    req_cabecalhos: JSON.stringify(mascararCabecalhos(req.cabecalhos, cabecalhoChaveApi ? [cabecalhoChaveApi] : [])),
    req_corpo: cortar(mascararCorpo(req.corpo)) ?? null, res_cabecalhos: JSON.stringify(mascararCabecalhos(res.cabecalhos)),
    res_corpo: cortar(mascararCorpo(res.corpoTexto)) ?? null, erro: res.erro ?? null, codigo_erro: d.codigoErro ?? null,
    resultado: d.resultado ?? null, criado_em: agora(), usuario: usuarioAtual().usuario, rastreio: d.rastreio ?? null,
    corpo_hash: req.corpo ? sha256(req.corpo) : null,
  });
}

// ---------------------------------------------------------------- HTTP

export async function enviarHttp(req: Requisicao, timeoutMs = 30000): Promise<Resposta> {
  const inicio = performance.now();
  try {
    const r = await fetch(req.url, {
      method: req.metodo,
      headers: req.cabecalhos,
      body: ['GET', 'HEAD'].includes(req.metodo) ? undefined : req.corpo,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const corpoTexto = await r.text();
    let corpo: unknown = corpoTexto;
    try { corpo = corpoTexto ? JSON.parse(corpoTexto) : undefined; } catch { /* texto puro */ }
    return { status: r.status, cabecalhos: Object.fromEntries(r.headers.entries()), corpoTexto, corpo, duracaoMs: Math.round(performance.now() - inicio) };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const motivo = err.name === 'TimeoutError' ? `Sem resposta em ${timeoutMs / 1000} s.` : err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;
    return { cabecalhos: {}, corpoTexto: '', corpo: undefined, duracaoMs: Math.round(performance.now() - inicio), erro: motivo };
  }
}

// ---------------------------------------------------------------- autenticação

const tokens = new Map<string, { token: string; expiraEm: number; escopos?: unknown }>();

export function esquecerToken(destinoId: string): void {
  tokens.delete(destinoId);
}

export async function obterToken(destino: Destino, ctx: { execucaoId?: string; forcar?: boolean } = {}): Promise<{ token: string; escopos?: unknown; novo: boolean }> {
  const cache = tokens.get(destino.id);
  if (!ctx.forcar && cache && Date.now() < cache.expiraEm - 120000) return { token: cache.token, escopos: cache.escopos, novo: false };
  const a = destino.autenticacao;
  const id = segredo(destino.id, 'client_id');
  const sec = segredo(destino.id, 'client_secret');
  if (!id || !sec) throw new ErroEnvio('Faltam client_id e client_secret no cofre do destino.');
  const url = montarUrl(destino, a.tokenUrl ?? '/oauth/token');
  const dom = conferirDominio(url, dominiosProducaoDo(destino));
  if (!dom.ok) throw new ErroEnvio(dom.motivo);
  const form = a.formato === 'form';
  const corpoObj: Record<string, string> = { grant_type: 'client_credentials', client_id: id, client_secret: sec };
  if (a.escopo) corpoObj.scope = a.escopo;
  const req: Requisicao = {
    metodo: 'POST',
    url,
    cabecalhos: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', Accept: 'application/json' },
    corpo: form ? new URLSearchParams(corpoObj).toString() : JSON.stringify(corpoObj),
  };
  const res = await enviarHttp(req, destino.limites.timeoutMs ?? 30000);
  const corpo = res.corpo as { access_token?: string; expires_in?: number; scope?: unknown } | undefined;
  const ok = res.status === 200 && !!corpo?.access_token;
  registrar({ execucaoId: ctx.execucaoId, destinoId: destino.id, fase: 'token', resultado: ok ? 'ok' : 'erro', codigoErro: ok ? undefined : (corpo as { error?: string })?.error }, req, res);
  if (!ok) {
    throw new ErroEnvio(res.erro ? `Falha ao obter o token: ${res.erro}` : `Falha ao obter o token: ${res.status} ${(corpo as { error?: string })?.error ?? ''}`.trim());
  }
  const expiraEm = Date.now() + (Number(corpo!.expires_in) || 600) * 1000;
  tokens.set(destino.id, { token: corpo!.access_token!, expiraEm, escopos: corpo!.scope });
  return { token: corpo!.access_token!, escopos: corpo!.scope, novo: true };
}

export async function cabecalhosDeAutenticacao(destino: Destino, ctx: { execucaoId?: string } = {}): Promise<Record<string, string>> {
  const a = destino.autenticacao;
  switch (a.tipo) {
    case 'chave_api': {
      const v = segredo(destino.id, 'api_key');
      if (!v) throw new ErroEnvio('Falta a chave de API (api_key) no cofre do destino.');
      return { [a.cabecalho ?? 'X-API-Key']: v };
    }
    case 'basic': {
      const s = segredo(destino.id, 'senha');
      if (!s) throw new ErroEnvio('Falta a senha no cofre do destino.');
      return { Authorization: `Basic ${Buffer.from(`${a.usuario ?? ''}:${s}`).toString('base64')}` };
    }
    case 'bearer': {
      const t = segredo(destino.id, 'token');
      if (!t) throw new ErroEnvio('Falta o token no cofre do destino.');
      return { Authorization: `Bearer ${t}` };
    }
    case 'oauth2_cc':
      return { Authorization: `Bearer ${(await obterToken(destino, ctx)).token}` };
    default:
      return {};
  }
}

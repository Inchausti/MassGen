// Cliente da API do app. Toda chamada leva o nome do operador, que entra na trilha de auditoria.

export class ErroApi extends Error {
  status: number;
  detalhes?: unknown;
  constructor(status: number, mensagem: string, detalhes?: unknown) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

const CHAVE_USUARIO = 'massgen.usuario';

export function usuarioLocal(): string {
  try { return localStorage.getItem(CHAVE_USUARIO) ?? ''; } catch { return ''; }
}

export function definirUsuarioLocal(nome: string): void {
  try { localStorage.setItem(CHAVE_USUARIO, nome.trim()); } catch { /* sem armazenamento: segue sem nome */ }
}

function cabecalhos(extra: Record<string, string> = {}): Record<string, string> {
  const u = usuarioLocal();
  return { ...(u ? { 'x-massgen-usuario': encodeURIComponent(u) } : {}), ...extra };
}

export async function api<T = any>(metodo: string, rota: string, corpo?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api${rota}`, {
      method: metodo,
      headers: cabecalhos(corpo === undefined ? {} : { 'content-type': 'application/json' }),
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  } catch {
    throw new ErroApi(0, 'Sem conexão com o servidor do MassGen. Ele está rodando?');
  }
  const texto = await r.text();
  let j: any;
  try { j = texto ? JSON.parse(texto) : undefined; } catch { j = texto; }
  if (!r.ok) throw new ErroApi(r.status, j?.erro ?? `Erro ${r.status}`, j?.detalhes);
  return j as T;
}

export const get = <T = any>(rota: string) => api<T>('GET', rota);
export const post = <T = any>(rota: string, corpo?: unknown) => api<T>('POST', rota, corpo ?? {});
export const put = <T = any>(rota: string, corpo?: unknown) => api<T>('PUT', rota, corpo ?? {});
export const patch = <T = any>(rota: string, corpo?: unknown) => api<T>('PATCH', rota, corpo ?? {});
export const del = <T = any>(rota: string) => api<T>('DELETE', rota);

// Download pela API (com o cabeçalho do operador, para a trilha registrar quem baixou).
export async function baixar(rota: string): Promise<void> {
  const r = await fetch(`/api${rota}`, { headers: cabecalhos() });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new ErroApi(r.status, j.erro ?? `Erro ${r.status}`, j.detalhes);
  }
  const nome = r.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'massgen.json';
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function lerArquivoJson(arquivo: File): Promise<unknown> {
  const texto = await arquivo.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw new ErroApi(400, `${arquivo.name} não é um JSON válido.`);
  }
}

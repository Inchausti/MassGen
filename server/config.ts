import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const RAIZ = path.resolve(import.meta.dirname, '..');

// Lê o .env da raiz (CHAVE=valor). Variáveis já definidas no ambiente têm precedência.
function carregarEnv(): void {
  const arquivo = path.join(RAIZ, '.env');
  if (!existsSync(arquivo)) return;
  for (const linha of readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || linha.trim().startsWith('#')) continue;
    const valor = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = valor;
  }
}
carregarEnv();

const lista = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

export const config = {
  porta: Number(process.env.PORT || 3000),
  dirDados: path.resolve(RAIZ, process.env.MASSGEN_DATA_DIR || 'data'),
  dirWeb: path.join(RAIZ, 'web', 'dist'),
  dirPacotes: path.join(RAIZ, 'packs'),
  dominiosPermitidos: lista(process.env.ALLOWED_DESTINATION_DOMAINS || 'localhost,127.0.0.1'),
  dominiosBloqueados: lista(process.env.BLOCKED_DESTINATION_DOMAINS),
  chaveMestra: process.env.MASSGEN_MASTER_KEY || '',
};

function casa(host: string, regra: string): boolean {
  if (regra.startsWith('*.')) return host === regra.slice(2) || host.endsWith(regra.slice(1));
  return host === regra;
}

export interface ResultadoDominio { ok: boolean; motivo?: string }

// Trava de produção: o endereço precisa estar na lista permitida e fora das bloqueadas
// (as do .env e as que o pacote do destino declara como produção).
export function conferirDominio(url: string, bloqueadosDoPacote: string[] = []): ResultadoDominio {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, motivo: 'Endereço inválido. Use a URL completa, como https://sandbox.exemplo.com.' };
  }
  const bloqueados = [...config.dominiosBloqueados, ...bloqueadosDoPacote.map((d) => d.toLowerCase())];
  if (bloqueados.some((r) => casa(host, r))) {
    return { ok: false, motivo: `${host} está bloqueado: é um endereço de produção.` };
  }
  if (!config.dominiosPermitidos.some((r) => casa(host, r))) {
    return {
      ok: false,
      motivo: `${host} não está na lista de domínios permitidos. Inclua-o em ALLOWED_DESTINATION_DOMAINS, no .env, e reinicie o app.`,
    };
  }
  return { ok: true };
}

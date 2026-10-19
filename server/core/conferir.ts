// Compara o que o destino respondeu com o gabarito do registro.
import type { Esperado } from './tipos.ts';
import { obter } from './caminhos.ts';

export interface Comparacao {
  ok: boolean;
  diferencas: string[];
  codigo?: string;
}

const CAMINHOS_CODIGO = ['error', 'code', 'erro', 'error.code', 'failure.code', 'codigo'];

export function codigoDeErro(corpo: unknown, caminho?: string): string | undefined {
  if (!corpo || typeof corpo !== 'object') return undefined;
  for (const c of caminho ? [caminho] : CAMINHOS_CODIGO) {
    const v = obter(corpo, c);
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function igual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

export function descreverStatus(s: Esperado['status']): string {
  if (s === undefined) return '2xx';
  return Array.isArray(s) ? (s[0] === 200 && s[1] === 299 ? '2xx' : `${s[0]} a ${s[1]}`) : String(s);
}

export function conferir(esperado: Esperado, status: number | undefined, corpo: unknown): Comparacao {
  const diferencas: string[] = [];
  const faixa = esperado.status ?? [200, 299];
  if (status === undefined) {
    diferencas.push('Sem resposta do destino.');
  } else if (Array.isArray(faixa) ? status < faixa[0] || status > faixa[1] : status !== faixa) {
    diferencas.push(`Status ${status}; esperado ${descreverStatus(faixa)}.`);
  }
  const codigo = codigoDeErro(corpo, esperado.caminhoCodigo);
  if (esperado.codigo && codigo !== esperado.codigo) {
    diferencas.push(`Código ${codigo ?? 'ausente'}; esperado ${esperado.codigo}.`);
  }
  for (const a of esperado.assercoes ?? []) {
    const v = obter(corpo, a.caminho);
    if (a.existe !== undefined && (v !== undefined) !== a.existe) {
      diferencas.push(`${a.caminho} ${a.existe ? 'ausente' : 'presente'}; esperado ${a.existe ? 'presente' : 'ausente'}.`);
    }
    if ('igual' in a && !igual(v, a.igual)) {
      diferencas.push(`${a.caminho} = ${JSON.stringify(v)}; esperado ${JSON.stringify(a.igual)}.`);
    }
    if (a.em && !a.em.some((x) => igual(v, x))) {
      diferencas.push(`${a.caminho} = ${JSON.stringify(v)}; esperado um de ${JSON.stringify(a.em)}.`);
    }
  }
  return { ok: diferencas.length === 0, diferencas, codigo };
}

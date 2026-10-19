// Documentos brasileiros: CNPJ, CPF, CEP e chave de acesso de documento fiscal eletrônico.
import type { Rng } from './rng.ts';
import { UF_POR_SIGLA, UFS } from './dados-br.ts';

function dvModulo11(base: string, pesos: number[]): number {
  const soma = base.split('').reduce((s, d, i) => s + Number(d) * pesos[i], 0);
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

export function dvCnpj(base12: string): string {
  const d1 = dvModulo11(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dvModulo11(base12 + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${d1}${d2}`;
}

export function cnpjValido(cnpj: string): boolean {
  const s = cnpj.replace(/\D/g, '');
  return s.length === 14 && !/^(\d)\1+$/.test(s) && dvCnpj(s.slice(0, 12)) === s.slice(12);
}

// Raiz de 8 dígitos (aleatória, ou começando pelo prefixo) e a ordem da filial (0001 é a matriz).
export function gerarCnpj(rng: Rng, opcoes: { prefixo?: string; raiz?: string; filial?: number } = {}): string {
  let raiz = opcoes.raiz?.replace(/\D/g, '').slice(0, 8);
  if (!raiz || raiz.length !== 8) {
    const prefixo = (opcoes.prefixo ?? '').replace(/\D/g, '').slice(0, 7);
    raiz = prefixo + rng.digitos(8 - prefixo.length);
  }
  const base = raiz + String(opcoes.filial ?? 1).padStart(4, '0');
  return base + dvCnpj(base);
}

export function dvCpf(base9: string): string {
  const d1 = dvModulo11(base9, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dvModulo11(base9 + d1, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${d1}${d2}`;
}

export function cpfValido(cpf: string): boolean {
  const s = cpf.replace(/\D/g, '');
  return s.length === 11 && !/^(\d)\1+$/.test(s) && dvCpf(s.slice(0, 9)) === s.slice(9);
}

export function gerarCpf(rng: Rng): string {
  let base = rng.digitos(9);
  while (/^(\d)\1+$/.test(base)) base = rng.digitos(9);
  return base + dvCpf(base);
}

export function gerarCep(rng: Rng, uf?: string): string {
  const u = (uf && UF_POR_SIGLA.get(uf.toUpperCase())) || rng.escolher(UFS);
  const [ini, fim] = rng.escolher(u.ceps);
  return String(rng.inteiro(ini, fim)).padStart(5, '0') + rng.digitos(3);
}

// Dígito da chave de acesso: módulo 11 com pesos de 2 a 9, da direita para a esquerda.
export function dvChave(base43: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    soma += Number(base43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

export function chaveValida(chave: string): boolean {
  return /^\d{44}$/.test(chave) && dvChave(chave.slice(0, 43)) === Number(chave[43]);
}

export interface PartesChave {
  uf: string;          // sigla ou código IBGE
  data: string;        // data de emissão (ISO): dá o ano e o mês
  cnpj: string;
  modelo: string;
  serie: string | number;
  numero: string | number;
  tipoEmissao?: string | number;
  codigo?: string;     // código numérico de 8 dígitos
}

export function montarChave(p: PartesChave, rng: Rng, dvInvalido = false): string {
  const cuf = /^\d{2}$/.test(p.uf) ? p.uf : UF_POR_SIGLA.get(String(p.uf).toUpperCase())?.codigo ?? '35';
  const d = String(p.data);
  const aamm = d.slice(2, 4) + d.slice(5, 7);
  const base =
    cuf +
    aamm +
    String(p.cnpj).replace(/\D/g, '').padStart(14, '0').slice(-14) +
    String(p.modelo).padStart(2, '0').slice(-2) +
    String(p.serie).padStart(3, '0').slice(-3) +
    String(p.numero).padStart(9, '0').slice(-9) +
    String(p.tipoEmissao ?? 1).slice(0, 1) +
    (p.codigo ?? rng.digitos(8)).padStart(8, '0').slice(-8);
  let dv = dvChave(base);
  if (dvInvalido) dv = (dv + 1) % 10;
  return base + dv;
}

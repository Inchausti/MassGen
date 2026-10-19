// Expressões e modelos de texto com JSONata: linguagem segura, sem acesso a rede nem a arquivo.
// Modelo de texto: "Contrato {{ $exec.codigo }}-{{ $pad($indice, 4) }}". Um placeholder sozinho mantém o tipo do valor.
import jsonata from 'jsonata';
import { chaveValida, cnpjValido, cpfValido } from './br.ts';

type Expressao = ReturnType<typeof jsonata>;
const cache = new Map<string, Expressao>();

export function dinheiro(v: unknown): string {
  const n = num(v);
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function num(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function somaDias(data: string, dias: number): string {
  const d = String(data);
  const base = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))));
  base.setUTCDate(base.getUTCDate() + Math.trunc(num(dias)));
  return base.toISOString().slice(0, 10) + d.slice(10);
}

function lista(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function compilar(texto: string): Expressao {
  let e = cache.get(texto);
  if (e) return e;
  try {
    e = jsonata(texto);
  } catch (err) {
    throw new Error(`Expressão inválida "${texto}": ${(err as Error).message}`);
  }
  e.registerFunction('dinheiro', (v: unknown) => dinheiro(v));
  e.registerFunction('num', (v: unknown) => num(v));
  e.registerFunction('somaDias', (d: string, n: number) => somaDias(d, n));
  e.registerFunction('data', (d: unknown) => String(d ?? '').slice(0, 10));
  e.registerFunction('pad', (v: unknown, n: number) => String(v ?? '').padStart(num(n), '0'));
  e.registerFunction('digitos', (v: unknown) => String(v ?? '').replace(/\D/g, ''));
  e.registerFunction('somaDinheiro', (v: unknown) => dinheiro(lista(v).reduce((s: number, x) => s + num(x), 0)));
  e.registerFunction('cnpjValido', (v: unknown) => cnpjValido(String(v ?? '')));
  e.registerFunction('cpfValido', (v: unknown) => cpfValido(String(v ?? '')));
  e.registerFunction('chaveValida', (v: unknown) => chaveValida(String(v ?? '')));
  cache.set(texto, e);
  return e;
}

export async function avaliar(texto: string, entrada: unknown, vars: Record<string, unknown> = {}): Promise<unknown> {
  try {
    const r = await compilar(texto).evaluate(entrada, vars);
    return normalizar(r);
  } catch (err) {
    throw new Error(`Falha ao avaliar "${texto}": ${(err as Error).message}`);
  }
}

// O JSONata devolve listas com propriedades extras; aqui viram valores comuns.
function normalizar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizar);
  return v;
}

const PLACEHOLDER = /\{\{\s*([\s\S]+?)\s*\}\}/g;
const UNICO = /^\{\{\s*([\s\S]+?)\s*\}\}$/;

export function temModelo(v: unknown): v is string {
  return typeof v === 'string' && v.includes('{{');
}

export async function renderizar(modelo: string, entrada: unknown, vars: Record<string, unknown> = {}): Promise<unknown> {
  const u = modelo.match(UNICO);
  if (u) return avaliar(u[1], entrada, vars);
  const partes = [...modelo.matchAll(PLACEHOLDER)];
  if (!partes.length) return modelo;
  const valores = await Promise.all(partes.map((p) => avaliar(p[1], entrada, vars)));
  let i = 0;
  return modelo.replace(PLACEHOLDER, () => {
    const v = valores[i++];
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

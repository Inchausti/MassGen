// Gerador pseudoaleatório com semente (mulberry32). Mesma semente, mesma sequência.

export function hashSemente(...partes: (string | number)[]): number {
  let h = 2166136261 >>> 0; // FNV-1a 32 bits
  for (const ch of partes.join('|')) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private estado: number;

  constructor(semente: number) {
    this.estado = semente >>> 0;
  }

  proximo(): number {
    let t = (this.estado = (this.estado + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  inteiro(min: number, max: number): number {
    return Math.floor(this.proximo() * (max - min + 1)) + min;
  }

  escolher<T>(lista: readonly T[]): T {
    return lista[Math.floor(this.proximo() * lista.length)];
  }

  booleano(probabilidade = 0.5): boolean {
    return this.proximo() < probabilidade;
  }

  ponderado<T>(itens: readonly { valor: T; peso: number }[]): T {
    const total = itens.reduce((s, i) => s + Math.max(0, i.peso), 0);
    let alvo = this.proximo() * total;
    for (const i of itens) {
      alvo -= Math.max(0, i.peso);
      if (alvo < 0) return i.valor;
    }
    return itens[itens.length - 1].valor;
  }

  embaralhar<T>(lista: T[]): T[] {
    for (let i = lista.length - 1; i > 0; i--) {
      const j = Math.floor(this.proximo() * (i + 1));
      [lista[i], lista[j]] = [lista[j], lista[i]];
    }
    return lista;
  }

  digitos(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String(Math.floor(this.proximo() * 10));
    return s;
  }
}

// Divide n itens entre pesos, com contagens exatas (maior resto), e devolve a lista embaralhada.
export function distribuir<T>(rng: Rng, n: number, pesos: { valor: T; peso: number }[]): T[] {
  const validos = pesos.filter((p) => p.peso > 0);
  if (!validos.length || n <= 0) return [];
  const total = validos.reduce((s, p) => s + p.peso, 0);
  const cotas = validos.map((p) => ({ valor: p.valor, exato: (n * p.peso) / total }));
  const base = cotas.map((c) => ({ valor: c.valor, n: Math.floor(c.exato), resto: c.exato - Math.floor(c.exato) }));
  let falta = n - base.reduce((s, b) => s + b.n, 0);
  for (const b of [...base].sort((a, b) => b.resto - a.resto)) {
    if (falta <= 0) break;
    b.n++;
    falta--;
  }
  const saida: T[] = [];
  for (const b of base) for (let i = 0; i < b.n; i++) saida.push(b.valor);
  return rng.embaralhar(saida);
}

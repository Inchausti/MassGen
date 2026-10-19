// Ler e escrever valores por caminho com pontos (address.state, items.0.code ou items[0].code).

function partes(caminho: string): string[] {
  return caminho.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

export function obter(obj: unknown, caminho: string): unknown {
  let atual: any = obj;
  for (const p of partes(caminho)) {
    if (atual === null || atual === undefined) return undefined;
    atual = atual[p];
  }
  return atual;
}

export function definir(obj: Record<string, unknown>, caminho: string, valor: unknown): void {
  const ps = partes(caminho);
  let atual: any = obj;
  for (let i = 0; i < ps.length - 1; i++) {
    if (atual[ps[i]] === null || typeof atual[ps[i]] !== 'object') atual[ps[i]] = /^\d+$/.test(ps[i + 1]) ? [] : {};
    atual = atual[ps[i]];
  }
  atual[ps[ps.length - 1]] = valor;
}

export function remover(obj: Record<string, unknown>, caminho: string): void {
  const ps = partes(caminho);
  let atual: any = obj;
  for (let i = 0; i < ps.length - 1; i++) {
    atual = atual?.[ps[i]];
    if (atual === null || typeof atual !== 'object') return;
  }
  delete atual[ps[ps.length - 1]];
}

// Caminhos das folhas de um objeto. Listas aparecem como nome[] e os itens são unidos.
export function caminhosFolha(obj: unknown, prefixo = ''): string[] {
  if (Array.isArray(obj)) {
    const s = new Set<string>();
    for (const item of obj) for (const c of caminhosFolha(item, `${prefixo}[]`)) s.add(c);
    return s.size ? [...s] : [`${prefixo}[]`];
  }
  if (obj && typeof obj === 'object') {
    const saida: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      saida.push(...caminhosFolha(v, prefixo ? `${prefixo}.${k}` : k));
    }
    return saida;
  }
  return prefixo ? [prefixo] : [];
}

// Para CSV: objeto aninhado vira colunas com pontos; listas vão como JSON.
export function achatar(obj: Record<string, unknown>, prefixo = '', saida: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const chave = prefixo ? `${prefixo}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) achatar(v as Record<string, unknown>, chave, saida);
    else saida[chave] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return saida;
}

export function clonar<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

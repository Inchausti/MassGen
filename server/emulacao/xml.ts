// Leitura das notas do cliente. O MassGen tira de cada XML só o que monta os eventos (proposta v4.3, seção 04):
// chave, modelo, datas, emitente, destinatário, totais de IBS e CBS, finalidade, nota referenciada e o cancelamento.

export interface No { nome: string; attrs: Record<string, string>; filhos: No[]; texto: string }

const ENTIDADES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodificar = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTIDADES[e] ?? m;
});
const semPrefixo = (n: string) => n.slice(n.indexOf(':') + 1);

// Analisador mínimo: elementos, atributos, texto, CDATA. Comentários, instruções e DOCTYPE são ignorados.
export function lerXml(entrada: string): No {
  const s = entrada.replace(/^﻿/, '');
  const raiz: No = { nome: '#documento', attrs: {}, filhos: [], texto: '' };
  const pilha: No[] = [raiz];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) pilha[pilha.length - 1].texto += decodificar(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { i = fimDe(s, '-->', lt); continue; }
    if (s.startsWith('<![CDATA[', lt)) {
      const f = s.indexOf(']]>', lt);
      if (f < 0) throw new Error('CDATA sem fim.');
      pilha[pilha.length - 1].texto += s.slice(lt + 9, f);
      i = f + 3;
      continue;
    }
    if (s.startsWith('<?', lt)) { i = fimDe(s, '?>', lt); continue; }
    if (s.startsWith('<!', lt)) { i = fimDe(s, '>', lt); continue; }
    const gt = s.indexOf('>', lt);
    if (gt < 0) throw new Error('Marcação sem fim.');
    const corpo = s.slice(lt + 1, gt);
    i = gt + 1;
    if (corpo.startsWith('/')) {
      const nome = semPrefixo(corpo.slice(1).trim());
      const topo = pilha.pop();
      if (!topo || topo.nome !== nome) throw new Error(`Fechamento </${nome}> fora de ordem.`);
      continue;
    }
    const auto = corpo.endsWith('/');
    const m = /^([^\s/]+)([\s\S]*?)\/?$/.exec(corpo);
    if (!m) throw new Error('Marcação inválida.');
    const no: No = { nome: semPrefixo(m[1]), attrs: {}, filhos: [], texto: '' };
    for (const a of m[2].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) no.attrs[semPrefixo(a[1])] = decodificar(a[3] ?? a[4] ?? '');
    pilha[pilha.length - 1].filhos.push(no);
    if (!auto) pilha.push(no);
  }
  if (pilha.length !== 1) throw new Error(`Faltou fechar <${pilha[pilha.length - 1].nome}>.`);
  if (!raiz.filhos.length) throw new Error('Não há elementos no XML.');
  return raiz.filhos[0];
}

function fimDe(s: string, marca: string, de: number): number {
  const f = s.indexOf(marca, de);
  if (f < 0) throw new Error('Marcação sem fim.');
  return f + marca.length;
}

// Primeiro descendente com o nome (busca em profundidade, incluindo o próprio nó).
export function achar(no: No | undefined, nome: string): No | undefined {
  if (!no) return undefined;
  if (no.nome === nome) return no;
  for (const f of no.filhos) {
    const r = achar(f, nome);
    if (r) return r;
  }
  return undefined;
}

// Caminho de filhos diretos: "ide/nNF".
export function em(no: No | undefined, caminho: string): No | undefined {
  let atual = no;
  for (const p of caminho.split('/')) {
    atual = atual?.filhos.find((f) => f.nome === p);
    if (!atual) return undefined;
  }
  return atual;
}

const txt = (no: No | undefined, caminho: string): string | undefined => {
  const t = em(no, caminho)?.texto.trim();
  return t ? t : undefined;
};
const num = (no: No | undefined, caminho: string): number => {
  const t = txt(no, caminho);
  return t ? Number(t) || 0 : 0;
};

// ---------------------------------------------------------------- documentos

export type Finalidade = 'normal' | 'complementar' | 'ajuste' | 'devolucao' | 'outra';
const FINALIDADES: Record<string, Finalidade> = { '1': 'normal', '2': 'complementar', '3': 'ajuste', '4': 'devolucao' };

export interface NotaLida {
  chave: string;
  modelo: string;
  serie?: string;
  numero?: string;
  emissao?: string;
  autorizacao?: string;
  protocolo?: string;
  situacaoSefaz?: string;
  ambiente: 'producao' | 'homologacao';
  finalidade: Finalidade;
  refChaves: string[];
  emitCnpj?: string;
  emitNome?: string;
  destDoc?: string;
  destNome?: string;
  grupoIbsCbs: boolean;
  vIbs: number;
  vIbsUf: number;
  vIbsMun: number;
  vCbs: number;
}

export interface CancelamentoLido { chave: string; quando?: string; protocolo?: string; autorizado: boolean; situacaoSefaz?: string }

export type Documento =
  | { tipo: 'nfe'; nota: NotaLida }
  | { tipo: 'cancelamento'; cancelamento: CancelamentoLido }
  | { tipo: 'outro'; motivo: string };

const CHAVE = /^\d{44}$/;

export function lerDocumento(texto: string): Documento {
  let raiz: No;
  try {
    raiz = lerXml(texto);
  } catch (e) {
    return { tipo: 'outro', motivo: `XML inválido: ${(e as Error).message}` };
  }
  const evento = achar(raiz, 'infEvento');
  if (!achar(raiz, 'infNFe') && evento) return lerEvento(raiz);
  const inf = achar(raiz, 'infNFe');
  if (!inf) {
    if (achar(raiz, 'infCte') || achar(raiz, 'infNFSe') || achar(raiz, 'infDPS')) return { tipo: 'outro', motivo: 'CT-e e NFS-e entram na etapa seguinte; por ora, só NF-e (D-MG-10).' };
    return { tipo: 'outro', motivo: 'O arquivo não é uma NF-e nem um evento de NF-e.' };
  }
  const prot = achar(raiz, 'infProt');
  const idChave = (inf.attrs.Id ?? '').replace(/^NFe/, '');
  const chave = CHAVE.test(idChave) ? idChave : txt(prot, 'chNFe') ?? '';
  if (!CHAVE.test(chave)) return { tipo: 'outro', motivo: 'A NF-e não tem chave de acesso de 44 dígitos.' };
  const ide = em(inf, 'ide');
  const emit = em(inf, 'emit');
  const dest = em(inf, 'dest');
  const tot = em(inf, 'total/IBSCBSTot');
  const refs = (ide?.filhos ?? []).filter((f) => f.nome === 'NFref').map((r) => txt(r, 'refNFe')).filter((c): c is string => !!c && CHAVE.test(c));
  return {
    tipo: 'nfe',
    nota: {
      chave,
      modelo: txt(ide, 'mod') ?? chave.slice(20, 22),
      serie: txt(ide, 'serie'),
      numero: txt(ide, 'nNF'),
      emissao: txt(ide, 'dhEmi') ?? txt(ide, 'dEmi'),
      autorizacao: txt(prot, 'dhRecbto'),
      protocolo: txt(prot, 'nProt'),
      situacaoSefaz: txt(prot, 'cStat'),
      ambiente: txt(ide, 'tpAmb') === '2' ? 'homologacao' : 'producao',
      finalidade: FINALIDADES[txt(ide, 'finNFe') ?? '1'] ?? 'outra',
      refChaves: refs,
      emitCnpj: (txt(emit, 'CNPJ') ?? txt(emit, 'CPF'))?.toUpperCase(),
      emitNome: txt(emit, 'xNome'),
      destDoc: (txt(dest, 'CNPJ') ?? txt(dest, 'CPF') ?? txt(dest, 'idEstrangeiro'))?.toUpperCase(),
      destNome: txt(dest, 'xNome'),
      grupoIbsCbs: !!tot,
      vIbs: num(tot, 'gIBS/vIBS'),
      vIbsUf: num(tot, 'gIBS/gIBSUF/vIBSUF'),
      vIbsMun: num(tot, 'gIBS/gIBSMun/vIBSMun'),
      vCbs: num(tot, 'gCBS/vCBS'),
    },
  };
}

// procEventoNFe: só o cancelamento (110111) interessa. Autorizado quando o retorno traz 135 ou 155.
function lerEvento(raiz: No): Documento {
  const inf = achar(raiz, 'infEvento')!;
  const tipo = txt(inf, 'tpEvento');
  if (tipo !== '110111') return { tipo: 'outro', motivo: `Evento ${tipo ?? 'sem tipo'} da NF-e: só o cancelamento (110111) gera eventos na POC.` };
  const chave = txt(inf, 'chNFe') ?? '';
  if (!CHAVE.test(chave)) return { tipo: 'outro', motivo: 'O evento de cancelamento não tem a chave da NF-e.' };
  const ret = achar(achar(raiz, 'retEvento'), 'infEvento');
  const cStat = txt(ret, 'cStat');
  return {
    tipo: 'cancelamento',
    cancelamento: {
      chave, quando: txt(inf, 'dhEvento'), protocolo: txt(ret, 'nProt') ?? txt(em(inf, 'detEvento'), 'nProt'),
      autorizado: cStat === '135' || cStat === '155', situacaoSefaz: cStat,
    },
  };
}

// ---------------------------------------------------------------- formatos do MOC

// "2026-11-04T10:15:00-03:00" → "2026-11-04 10:15:00.000 -03:00" (Anexo I, DTH_EMISSAO e DTH_AUTORIZACAO).
export function dataHoraMoc(iso: string | undefined): string {
  const m = iso && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso);
  if (!m) return iso ?? '';
  const ms = (m[3] ?? '').padEnd(3, '0').slice(0, 3);
  const fuso = !m[4] || m[4] === 'Z' ? '+00:00' : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  return `${m[1]} ${m[2]}.${ms} ${fuso}`;
}

// Data local do documento (a parte AAAA-MM-DD, no fuso em que foi emitido).
export const diaDe = (iso: string | undefined): string | undefined => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);

// CNPJ8 do Anexo I. CNPJ alfanumérico conta igual: os 8 primeiros caracteres.
export const raizCnpj = (doc: string | undefined | null): string | undefined => (doc && doc.length === 14 ? doc.slice(0, 8).toUpperCase() : undefined);

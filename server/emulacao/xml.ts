// Leitura dos documentos do cliente. O MassGen tira de cada XML só o que monta os eventos (proposta v4.3, seção 04):
// chave, modelo, datas, emitente, adquirente, totais de IBS e CBS, finalidade, documento referenciado e o cancelamento.
// Entram NF-e e NFC-e (NT 2025.002, grupo IBSCBSTot), CT-e (NT 2025.001, grupo imp/IBSCBS) e a NFS-e do padrão nacional
// (grupo IBSCBS que a Sefin Nacional calcula na geração). O resto fica de fora com o motivo.

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

// ---------------------------------------------------------------- modelos

// Os modelos que entram na POC. O código é o da tabela de documentos da CBS (A.9), que vai no campo `documento` da foto;
// nos documentos das Sefaz ele é o próprio modelo do leiaute. A NFS-e não tem modelo no leiaute: o MassGen usa o 91 da
// tabela (decisão provisória; o 92 é a NFS-e Via). No IBS, o arquivo não traz o modelo (Anexo I).
export interface Modelo { sigla: string; genero: 'a' | 'o'; adquirente: string; fornecedor: string; autorizada: string[] }
export const MODELOS: Record<string, Modelo> = {
  '55': { sigla: 'NF-e', genero: 'a', adquirente: 'destinatário', fornecedor: 'emitente', autorizada: ['100', '150'] },
  '65': { sigla: 'NFC-e', genero: 'a', adquirente: 'destinatário', fornecedor: 'emitente', autorizada: ['100', '150'] },
  '57': { sigla: 'CT-e', genero: 'o', adquirente: 'tomador', fornecedor: 'emitente', autorizada: ['100', '150'] },
  // cStat da NFS-e: 100 gerada, 102 de decisão judicial, 103 avulsa. A 101 (de substituição) fica de fora antes.
  '91': { sigla: 'NFS-e', genero: 'a', adquirente: 'tomador', fornecedor: 'prestador', autorizada: ['100', '102', '103'] },
};
// Chave numérica sai em ordem de número num objeto: a ordem de apresentação fica aqui.
export const ORDEM_MODELOS = ['55', '65', '57', '91'];
export const SIGLAS_ACEITAS = ORDEM_MODELOS.map((m) => MODELOS[m].sigla);
// "NF-e, NFC-e, CT-e ou NFS-e"
export const listaSiglas = (conjuncao: 'e' | 'ou' | 'nem') => SIGLAS_ACEITAS.join(', ').replace(/, ([^,]*)$/, ` ${conjuncao} $1`);
const OUTROS: Record<string, string> = { '67': 'CT-e OS', '62': 'NFCom', '63': 'BP-e', '66': 'NF3-e' };
export const siglaModelo = (modelo: string | null | undefined): string =>
  (modelo && (MODELOS[modelo]?.sigla ?? OUTROS[modelo])) || `modelo ${modelo ?? '?'}`;
// "a NF-e", "o CT-e"; "na NF-e", "no CT-e".
export const oDoc = (modelo: string | null | undefined) => `${MODELOS[modelo ?? '']?.genero ?? 'o'} ${siglaModelo(modelo)}`;
export const noDoc = (modelo: string | null | undefined) => `n${oDoc(modelo)}`;

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
  destDoc?: string; // o adquirente: o destinatário na NF-e e na NFC-e, o tomador no CT-e e na NFS-e
  destNome?: string;
  grupoIbsCbs: boolean;
  vIbs: number;
  vIbsUf: number;
  vIbsMun: number;
  vCbs: number;
  restricao?: string; // o que o leiaute permite mas os entes ainda não dizem como entra: o documento fica de fora
}

export interface CancelamentoLido { chave: string; quando?: string; protocolo?: string; autorizado: boolean; situacaoSefaz?: string; recusa?: string }

export type Documento =
  | { tipo: 'nota'; nota: NotaLida }
  | { tipo: 'cancelamento'; cancelamento: CancelamentoLido }
  | { tipo: 'outro'; motivo: string };

const CHAVE = /^\d{44}$/;
const CHAVE_NFSE = /^\d{50}$/;
const outro = (motivo: string): Documento => ({ tipo: 'outro', motivo });
const doc = (n: No | undefined): string | undefined => (txt(n, 'CNPJ') ?? txt(n, 'CPF') ?? txt(n, 'idEstrangeiro') ?? txt(n, 'NIF'))?.toUpperCase();

// Os totais de IBS e CBS do grupo do documento. Os nomes são os mesmos nos três leiautes (vIBSUF, vIBSMun, vCBS); o total
// do IBS é o vIBS (NF-e, CT-e) ou o vIBSTot (NFS-e), e, se faltar, a soma da UF com o município.
function totais(g: No | undefined): Pick<NotaLida, 'grupoIbsCbs' | 'vIbs' | 'vIbsUf' | 'vIbsMun' | 'vCbs'> {
  const v = (nome: string) => Number(achar(g, nome)?.texto.trim() || 0) || 0;
  const vIbsUf = v('vIBSUF');
  const vIbsMun = v('vIBSMun');
  const total = achar(g, 'vIBS') ?? achar(g, 'vIBSTot');
  return { grupoIbsCbs: !!g, vIbs: total ? Number(total.texto.trim()) || 0 : Math.round((vIbsUf + vIbsMun) * 100) / 100, vIbsUf, vIbsMun, vCbs: v('vCBS') };
}

export function lerDocumento(texto: string): Documento {
  let raiz: No;
  try {
    raiz = lerXml(texto);
  } catch (e) {
    return outro(`XML inválido: ${(e as Error).message}`);
  }
  // O CT-e leva as NF-e transportadas em infDoc/infNFe: ele vem antes da NF-e.
  const cte = achar(raiz, 'infCte');
  if (cte) return lerCte(raiz, cte);
  const nfse = achar(raiz, 'infNFSe');
  if (nfse) return lerNfse(nfse);
  const nfe = achar(raiz, 'infNFe');
  if (nfe) return lerNfe(raiz, nfe);
  if (achar(raiz, 'infEvento') || achar(raiz, 'infPedReg')) return lerEvento(raiz);
  if (achar(raiz, 'infDPS')) return outro('DPS sem a NFS-e: importe o XML da NFS-e gerada, que traz a chave e o IBS e a CBS calculados pela Sefin Nacional.');
  return outro(`O arquivo não é ${listaSiglas('nem')}, nem o cancelamento de um deles.`);
}

// NF-e e NFC-e: o mesmo leiaute, com o modelo em ide/mod.
function lerNfe(raiz: No, inf: No): Documento {
  const prot = achar(raiz, 'infProt');
  const idChave = (inf.attrs.Id ?? '').replace(/^NFe/, '');
  const chave = CHAVE.test(idChave) ? idChave : txt(prot, 'chNFe') ?? '';
  const ide = em(inf, 'ide');
  const modelo = txt(ide, 'mod') ?? (CHAVE.test(chave) ? chave.slice(20, 22) : '55');
  if (!CHAVE.test(chave)) return outro(`${oDoc(modelo)} não tem chave de acesso de 44 dígitos.`.replace(/^./, (c) => c.toUpperCase()));
  const emit = em(inf, 'emit');
  const dest = em(inf, 'dest');
  const refs = (ide?.filhos ?? []).filter((f) => f.nome === 'NFref').map((r) => txt(r, 'refNFe')).filter((c): c is string => !!c && CHAVE.test(c));
  return {
    tipo: 'nota',
    nota: {
      chave, modelo,
      serie: txt(ide, 'serie'),
      numero: txt(ide, 'nNF'),
      emissao: txt(ide, 'dhEmi') ?? txt(ide, 'dEmi'),
      autorizacao: txt(prot, 'dhRecbto'),
      protocolo: txt(prot, 'nProt'),
      situacaoSefaz: txt(prot, 'cStat'),
      ambiente: txt(ide, 'tpAmb') === '2' ? 'homologacao' : 'producao',
      finalidade: FINALIDADES[txt(ide, 'finNFe') ?? '1'] ?? 'outra',
      refChaves: refs,
      emitCnpj: doc(emit), emitNome: txt(emit, 'xNome'),
      destDoc: doc(dest), destNome: txt(dest, 'xNome'),
      ...totais(em(inf, 'total/IBSCBSTot')),
    },
  };
}

// CT-e 4.00: o adquirente é o tomador do serviço (ide/toma3 aponta o remetente, o expedidor, o recebedor ou o
// destinatário; ide/toma4 traz outro). O complemento de valores (tpCTe 1) referencia o CT-e original em infCteComp.
const TOMADOR: Record<string, string> = { '0': 'rem', '1': 'exped', '2': 'receb', '3': 'dest' };
const TIPO_CTE: Record<string, string> = {
  '3': 'CT-e de substituição (tpCTe 3): os entes ainda não dizem como a substituição entra na apuração; fica de fora (decisão provisória)',
  '5': 'CT-e Simplificado (tpCTe 5): fica para depois; por ora, só o CT-e comum e o de complemento',
  '6': 'substituição do CT-e Simplificado (tpCTe 6): fica para depois; por ora, só o CT-e comum e o de complemento',
};

function lerCte(raiz: No, inf: No): Documento {
  const prot = achar(raiz, 'infProt');
  const idChave = (inf.attrs.Id ?? '').replace(/^CTe/, '');
  const chave = CHAVE.test(idChave) ? idChave : txt(prot, 'chCTe') ?? '';
  if (!CHAVE.test(chave)) return outro('O CT-e não tem chave de acesso de 44 dígitos.');
  const ide = em(inf, 'ide');
  const emit = em(inf, 'emit');
  const t3 = em(ide, 'toma3') ?? em(ide, 'toma03');
  const tomador = t3 ? em(inf, TOMADOR[txt(t3, 'toma') ?? ''] ?? '-') : em(ide, 'toma4') ?? em(ide, 'toma04') ?? em(inf, 'toma');
  const tp = txt(ide, 'tpCTe') ?? '0';
  const refs = inf.filhos.filter((f) => f.nome === 'infCteComp').map((c) => txt(c, 'chCTe') ?? txt(c, 'chave')).filter((c): c is string => !!c && CHAVE.test(c));
  return {
    tipo: 'nota',
    nota: {
      chave,
      modelo: txt(ide, 'mod') ?? chave.slice(20, 22),
      serie: txt(ide, 'serie'),
      numero: txt(ide, 'nCT'),
      emissao: txt(ide, 'dhEmi'),
      autorizacao: txt(prot, 'dhRecbto'),
      protocolo: txt(prot, 'nProt'),
      situacaoSefaz: txt(prot, 'cStat'),
      ambiente: txt(ide, 'tpAmb') === '2' ? 'homologacao' : 'producao',
      finalidade: tp === '0' ? 'normal' : tp === '1' ? 'complementar' : 'outra',
      refChaves: refs,
      emitCnpj: doc(emit), emitNome: txt(emit, 'xNome'),
      destDoc: doc(tomador), destNome: txt(tomador, 'xNome'),
      ...totais(em(inf, 'imp/IBSCBS')),
      restricao: tp === '0' || tp === '1' ? undefined : TIPO_CTE[tp] ?? `tipo ${tp} do CT-e (tpCTe): os entes ainda não dizem como ele entra; fica de fora`,
    },
  };
}

// NFS-e do padrão nacional: o XML gerado (NFSe/infNFSe) traz a chave de 50 dígitos no Id, a data de processamento e o
// grupo IBSCBS calculado; a DPS que a originou vem dentro, com a emissão, o ambiente e o tomador.
function lerNfse(inf: No): Documento {
  const chave = (inf.attrs.Id ?? '').replace(/^NFS/, '');
  if (!CHAVE_NFSE.test(chave)) return outro('A NFS-e não tem chave de acesso de 50 dígitos.');
  const dps = achar(inf, 'infDPS');
  const emit = em(inf, 'emit') ?? em(dps, 'prest');
  const toma = em(dps, 'toma');
  const cStat = txt(inf, 'cStat');
  const substituida = txt(em(dps, 'subst'), 'chSubstda');
  const fin = txt(em(dps, 'IBSCBS'), 'finNFSe');
  return {
    tipo: 'nota',
    nota: {
      chave,
      modelo: '91',
      serie: txt(dps, 'serie'),
      numero: txt(inf, 'nNFSe'),
      emissao: txt(dps, 'dhEmi'),
      autorizacao: txt(inf, 'dhProc'),
      protocolo: txt(inf, 'nDFSe'),
      situacaoSefaz: cStat,
      ambiente: txt(dps, 'tpAmb') === '2' ? 'homologacao' : 'producao',
      finalidade: 'normal',
      refChaves: substituida && CHAVE_NFSE.test(substituida) ? [substituida] : [],
      emitCnpj: doc(emit), emitNome: txt(emit, 'xNome'),
      destDoc: doc(toma), destNome: txt(toma, 'xNome'),
      ...totais(em(inf, 'IBSCBS')),
      restricao: substituida || cStat === '101'
        ? 'NFS-e de substituição: os entes ainda não dizem como a substituta se liga à substituída; fica de fora (decisão provisória)'
        : fin && fin !== '0' ? `finalidade ${fin} da NFS-e (finNFSe): os entes ainda não dizem como ela entra; fica de fora` : undefined,
    },
  };
}

// Cancelamento. NF-e, NFC-e e CT-e: o procEvento com o tpEvento 110111, autorizado quando o retorno traz 135 ou 155.
// NFS-e: o evento e101101, que só existe registrado (infEvento em volta do pedido); o pedido solto não vale.
function lerEvento(raiz: No): Documento {
  const ped = achar(raiz, 'infPedReg');
  if (ped) return lerEventoNfse(raiz, ped);
  const inf = achar(raiz, 'infEvento')!;
  const tipo = txt(inf, 'tpEvento');
  const chave = txt(inf, 'chNFe') ?? txt(inf, 'chCTe') ?? '';
  const modelo = CHAVE.test(chave) ? chave.slice(20, 22) : txt(inf, 'chCTe') ? '57' : '55';
  if (tipo !== '110111') return outro(`Evento ${tipo ?? 'sem tipo'} d${oDoc(modelo)}: só o cancelamento (110111) gera eventos na POC.`);
  if (!CHAVE.test(chave)) return outro(`O evento de cancelamento não tem a chave d${oDoc(modelo)}.`);
  const ret = achar(achar(raiz, 'retEvento') ?? achar(raiz, 'retEventoCTe'), 'infEvento');
  const cStat = txt(ret, 'cStat');
  return {
    tipo: 'cancelamento',
    cancelamento: {
      chave, quando: txt(inf, 'dhEvento'), protocolo: txt(ret, 'nProt') ?? achar(em(inf, 'detEvento'), 'nProt')?.texto.trim(),
      autorizado: cStat === '135' || cStat === '155', situacaoSefaz: cStat,
    },
  };
}

const CANCELA_NFSE = 'e101101';

function lerEventoNfse(raiz: No, ped: No): Documento {
  const chave = txt(ped, 'chNFSe') ?? '';
  if (!CHAVE_NFSE.test(chave)) return outro('O evento da NFS-e não tem a chave de 50 dígitos.');
  const codigo = ped.filhos.find((f) => /^e\d{6}$/.test(f.nome))?.nome;
  if (codigo === 'e105102') return outro('Cancelamento da NFS-e por substituição: a substituta fica de fora (decisão provisória), então este evento também.');
  if (codigo !== CANCELA_NFSE) return outro(`Evento ${codigo ?? 'sem código'} da NFS-e: só o cancelamento (${CANCELA_NFSE}) gera eventos na POC.`);
  const registro = achar(raiz, 'infEvento');
  return {
    tipo: 'cancelamento',
    cancelamento: {
      chave, quando: txt(ped, 'dhEvento'), protocolo: txt(registro, 'nDFe'), autorizado: !!registro,
      recusa: registro ? undefined : 'pedido de cancelamento da NFS-e sem o registro da Sefin Nacional (importe o XML do evento registrado)',
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

// Arquivo Diferencial (Delta) do IBS emulado: o JSON do Anexo I do MOC v1.10, compactado como os nomes do webhook indicam.
// Fatiamento (Anexo I, 3.3): a operação que não cabe num arquivo segue no próximo, com o mesmo cabeçalho, só a fatia da
// lista e o hash acumulado até o último lançamento da fatia.
import { createHash } from 'node:crypto';
import { CAMPOS, TIPO_IBS, type Campo } from './catalogo.ts';
import { dataHoraMoc, raizCnpj } from './xml.ts';
import { criarZip } from './zip.ts';

export function linhaMoc(id: number, dthLancto: string, tipo: string, valores: Record<Campo, number>): Record<string, unknown> {
  const l: Record<string, unknown> = { ID: id, DTH_LANCTO: dthLancto, MOV: TIPO_IBS.get(tipo)!.mov };
  for (const c of CAMPOS) l[c.nome] = valores[c.campo] ?? 0;
  return l;
}

// O MOC ainda não definiu o algoritmo do hash (Pendência 1). Provisório, declarado na collection:
// SHA-1 do hash anterior concatenado ao JSON da linha, lançamento a lançamento, na ordem do extrato.
export const hashExtrato = (anterior: string | null, linha: unknown): string =>
  createHash('sha1').update(`${anterior ?? ''}${JSON.stringify(linha)}`).digest('hex');

export interface DadosOperacao { operacao_id: number; chave: string; emissao: string | null; autorizacao: string | null; emit_cnpj: string | null; dest_doc: string | null }

export function cabecalhoOperacao(n: DadosOperacao): Record<string, unknown> {
  const h: Record<string, unknown> = {
    ID: n.operacao_id, CHAVE_ACESSO: n.chave, DTH_EMISSAO: dataHoraMoc(n.emissao ?? undefined),
    DTH_AUTORIZACAO: dataHoraMoc((n.autorizacao ?? n.emissao) ?? undefined), CNPJ_FORNECEDOR: raizCnpj(n.emit_cnpj) ?? '',
  };
  const adq = raizCnpj(n.dest_doc);
  if (adq) h.CNPJ_ADQUIRENTE = adq;
  return h;
}

export interface OperacaoDoDia { cabecalho: Record<string, unknown>; linhas: { linha: Record<string, unknown>; hash: string; eventoId: string }[] }
export interface Fatia { operacoes: { cabecalho: Record<string, unknown>; lista: Record<string, unknown>[]; hash: string; eventos: string[] }[]; lancamentos: number }

// quebraApos: o lançamento depois do qual a operação continua no arquivo seguinte, mesmo cabendo (caso T05).
export function fatiar(ops: OperacaoDoDia[], limite: number, quebraApos?: string): Fatia[] {
  const max = Math.max(1, limite);
  const fatias: Fatia[] = [];
  let atual: Fatia = { operacoes: [], lancamentos: 0 };
  for (const op of ops) {
    let i = 0;
    const q = quebraApos ? op.linhas.findIndex((l) => l.eventoId === quebraApos) : -1;
    while (i < op.linhas.length) {
      if (atual.lancamentos >= max) { fatias.push(atual); atual = { operacoes: [], lancamentos: 0 }; }
      let fim = i + (max - atual.lancamentos);
      if (q >= i && q + 1 < fim) fim = q + 1;
      const parte = op.linhas.slice(i, fim);
      atual.operacoes.push({ cabecalho: op.cabecalho, lista: parte.map((p) => p.linha), hash: parte[parte.length - 1].hash, eventos: parte.map((p) => p.eventoId) });
      atual.lancamentos += parte.length;
      i += parte.length;
      if (q === i - 1 && i < op.linhas.length) { fatias.push(atual); atual = { operacoes: [], lancamentos: 0 }; }
    }
  }
  if (atual.operacoes.length) fatias.push(atual);
  return fatias;
}

export function montarArquivo(nomeJson: string, tipo: 'diferencial(delta)' | 'solicitação manual', geradoEm: string, inicial: string, final: string, f: Fatia) {
  return {
    header: {
      nomearquivo: nomeJson,
      tiposolicitacao: tipo,
      datageracao: geradoEm,
      parametrosgeracao: { datainicial: inicial, datafinal: final, qtdoperacoes: f.operacoes.length },
      operacoes: f.operacoes.map((o) => ({ ...o.cabecalho, extrato_cc: { hash: o.hash, lista: o.lista } })),
    },
  };
}

// aassist_2026-11_14_detalhada_1001_parte001: o padrão do exemplo do webhook no MOC.
export function nomeBase(dia: string, idArq: number, parte: number): string {
  return `aassist_${dia.slice(0, 7)}_${dia.slice(8, 10)}_detalhada_${idArq}_parte${String(parte).padStart(3, '0')}`;
}

export function zipDoArquivo(nome: string, conteudo: string, geradoEm: string): Buffer {
  return criarZip([{ nome: nome.replace(/\.zip$/, '.json'), dados: Buffer.from(conteudo, 'utf8') }], geradoEm);
}

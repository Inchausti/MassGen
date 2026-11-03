// Arquivo da Receita Federal emulada (APIs de Apuração da CBS v2, A.6 a A.8). Débitos e créditos trazem a foto atual de
// cada documento, com o atualizacao do último evento que a mudou; pagamentos e recolhimentos trazem um registro por
// evento, agrupado pela data de arrecadação. É o mesmo leiaute nos quatro endpoints: tíquete, ni, geradoEm e apuracao.
import { TIPO_CBS, derivadoCbs, type Endpoint } from './catalogo-cbs.ts';

export interface DocumentoCbs { chave: string; modelo: string | null; emissao: string | null; finalidade: string | null }

// O que o evento leva além do valor: a origem do ajuste ou o registro do pagamento.
export interface DadosCbs {
  via?: string; origem?: number;
  numeroDARF?: string; tipo?: number; pa?: string; principal?: number; multa?: number; juros?: number; total?: number;
  niAdquirente?: string; niFornecedor?: string; chaveDFE?: string; vencimento?: string;
}

export interface EventoCbs { tipo: string; valores: Record<string, number>; dth: string; dados: DadosCbs | null }

const r2 = (v: number) => Math.round(v * 100) / 100;

// "11/2026": o período de apuração é o mês da emissão.
export const paDe = (emissao: string | null | undefined) => (emissao && /^\d{4}-\d{2}/.test(emissao) ? `${emissao.slice(5, 7)}/${emissao.slice(0, 4)}` : '');
const pelaData = (pa: string) => `${pa.slice(3)}-${pa.slice(0, 2)}`;

export function saldosCbs(eventos: { valores: Record<string, number> }[]): Record<string, number> {
  const s: Record<string, number> = {};
  for (const e of eventos) for (const [k, x] of Object.entries(e.valores)) s[k] = r2((s[k] ?? 0) + (x ?? 0));
  return s;
}

const doEndpoint = (eventos: EventoCbs[], endpoint: Endpoint) => eventos.filter((e) => TIPO_CBS.get(e.tipo)?.endpoint === endpoint);

// Cabeçalho comum da foto. A origem segue a A.9: a do último ajuste que a definiu; documento de devolução é 22.
function identificacao(doc: DocumentoCbs, eventos: EventoCbs[], origemPadrao: number) {
  const origem = [...eventos].reverse().find((e) => e.dados?.origem !== undefined)?.dados?.origem ?? origemPadrao;
  return {
    origem, documento: Number(doc.modelo) || 55, chave: doc.chave, emissao: doc.emissao ?? '',
    registro: eventos[0].dth, atualizacao: eventos[eventos.length - 1].dth,
  };
}

const origemDoDocumento = (doc: DocumentoCbs) => (doc.finalidade === 'devolucao' ? 22 : 0);

export function fotoDebito(doc: DocumentoCbs, todos: EventoCbs[]) {
  const eventos = doEndpoint(todos, 'debitos');
  if (!eventos.length) return undefined;
  const s = saldosCbs(eventos);
  const x = (c: string) => s[c] ?? 0;
  return {
    ...identificacao(doc, eventos, origemDoDocumento(doc)),
    cbs: { apurado: x('D.apurado'), excedente: x('D.excedente'), inexigivel: x('D.inexigivel'), suspenso: x('D.suspenso'), extinto: x('D.extinto'), saldoDevedor: derivadoCbs(s, 'saldoDevedor')! },
  };
}

export function fotoCredito(doc: DocumentoCbs, todos: EventoCbs[]) {
  const eventos = doEndpoint(todos, 'creditos');
  if (!eventos.length) return undefined;
  const s = saldosCbs(eventos);
  const x = (c: string) => s[c] ?? 0;
  return {
    ...identificacao(doc, eventos, origemDoDocumento(doc)),
    cbs: {
      apurado: x('C.apurado'), excedente: x('C.excedente'),
      apropriacao: { inapropriavel: x('C.inapropriavel'), suspenso: x('C.suspenso'), prescrito: x('C.prescrito'), aApropriar: derivadoCbs(s, 'aApropriar')!, apropriado: x('C.apropriado') },
      utilizacao: {
        inutilizavel: x('C.inutilizavel'), utilizado: x('C.utilizado'), restabelecido: x('C.restabelecido'),
        naoUtilizado: { saldoCredor: derivadoCbs(s, 'saldoCredor')!, pedidoRessarcimento: x('C.pedidoRessarcimento') },
      },
    },
  };
}

export function registroPagamento(endpoint: 'pagamentos' | 'recolhimentos', d: DadosCbs) {
  const valores = { principal: d.principal ?? 0, multa: d.multa ?? 0, juros: d.juros ?? 0, total: d.total ?? 0 };
  if (endpoint === 'pagamentos') return { numeroDARF: d.numeroDARF ?? '', tipo: d.tipo, niAdquirente: d.niAdquirente ?? '', composicao: [{ pa: d.pa, ...valores }] };
  return {
    numeroDARF: d.numeroDARF ?? '', tipo: d.tipo,
    composicao: [{ sequencial: 1, pa: d.pa, vencimento: d.vencimento, niFornecedor: d.niFornecedor ?? '', chaveDFE: d.chaveDFE ?? '', ...valores }],
  };
}

export interface ItemArquivo { doc: DocumentoCbs; eventos: EventoCbs[] }

// Os itens já vêm escolhidos (pela janela ou pelo que mudou desde o último aviso); aqui só se monta o leiaute.
export function montarArquivoCbs(endpoint: Endpoint, tiquete: string, ni: string, geradoEm: string, itens: ItemArquivo[]): { conteudo: Record<string, unknown>; registros: number } {
  const grupos = new Map<string, unknown[]>();
  const juntar = (chave: string, r: unknown) => grupos.set(chave, [...(grupos.get(chave) ?? []), r]);
  let registros = 0;
  if (endpoint === 'debitos' || endpoint === 'creditos') {
    const fotos = itens.map((i) => ({ i, f: endpoint === 'debitos' ? fotoDebito(i.doc, i.eventos) : fotoCredito(i.doc, i.eventos) }))
      .filter((x) => x.f).sort((a, b) => a.f!.atualizacao.localeCompare(b.f!.atualizacao));
    for (const { i, f } of fotos) { juntar(paDe(i.doc.emissao), f); registros++; }
    const apuracao = [...grupos].sort(([a], [b]) => pelaData(a).localeCompare(pelaData(b))).map(([pa, lista]) => ({ pa, [endpoint]: lista }));
    return { conteudo: { tiqueteSolicitacao: tiquete, ni, niConsumidor: '', geradoEm, apuracao }, registros };
  }
  for (const i of itens) {
    for (const e of doEndpoint(i.eventos, endpoint)) { juntar(e.dth, registroPagamento(endpoint, e.dados ?? {})); registros++; }
  }
  const apuracao = [...grupos].sort(([a], [b]) => a.localeCompare(b)).map(([dataArrecadacao, pagamentos]) => ({ dataArrecadacao, pagamentos }));
  return { conteudo: { tiqueteSolicitacao: tiquete, ni, niConsumidor: '', geradoEm, apuracao }, registros };
}

// Catálogo dos eventos da CBS (proposta v4.3, seção 05; APIs de Apuração da CBS v2, A.6 a A.9).
// Na CBS, evento é a foto nova de um documento num dos quatro endpoints: o tipo diz que campo da foto muda e por quanto.
// Como no IBS, é dado; o motor (execucao.ts) só o interpreta. A ordem dos pré-requisitos é a da seção 09.
import type { Base, Lado, TipoEvento, Variante } from './catalogo.ts';

export type Endpoint = 'debitos' | 'creditos' | 'pagamentos' | 'recolhimentos';
export const ENDPOINTS: Endpoint[] = ['debitos', 'creditos', 'pagamentos', 'recolhimentos'];

// Os campos de valor da foto (A.6 e A.7). D. é o débito; C., o crédito.
export const CAMPOS_CBS: { campo: string; nome: string; rotulo: string }[] = [
  { campo: 'D.apurado', nome: 'debitos[].cbs.apurado', rotulo: 'Débito apurado' },
  { campo: 'D.excedente', nome: 'debitos[].cbs.excedente', rotulo: 'Débito excedente' },
  { campo: 'D.inexigivel', nome: 'debitos[].cbs.inexigivel', rotulo: 'Débito inexigível' },
  { campo: 'D.suspenso', nome: 'debitos[].cbs.suspenso', rotulo: 'Débito suspenso' },
  { campo: 'D.extinto', nome: 'debitos[].cbs.extinto', rotulo: 'Débito extinto' },
  { campo: 'C.apurado', nome: 'creditos[].cbs.apurado', rotulo: 'Crédito apurado' },
  { campo: 'C.excedente', nome: 'creditos[].cbs.excedente', rotulo: 'Crédito excedente' },
  { campo: 'C.inapropriavel', nome: 'creditos[].cbs.apropriacao.inapropriavel', rotulo: 'Inapropriável' },
  { campo: 'C.suspenso', nome: 'creditos[].cbs.apropriacao.suspenso', rotulo: 'Apropriação suspensa' },
  { campo: 'C.prescrito', nome: 'creditos[].cbs.apropriacao.prescrito', rotulo: 'Prescrito' },
  { campo: 'C.apropriado', nome: 'creditos[].cbs.apropriacao.apropriado', rotulo: 'Apropriado' },
  { campo: 'C.inutilizavel', nome: 'creditos[].cbs.utilizacao.inutilizavel', rotulo: 'Inutilizável' },
  { campo: 'C.utilizado', nome: 'creditos[].cbs.utilizacao.utilizado', rotulo: 'Utilizado' },
  { campo: 'C.restabelecido', nome: 'creditos[].cbs.utilizacao.restabelecido', rotulo: 'Restabelecido' },
  { campo: 'C.pedidoRessarcimento', nome: 'creditos[].cbs.utilizacao.naoUtilizado.pedidoRessarcimento', rotulo: 'Pedido de ressarcimento' },
];

const r2 = (v: number) => Math.round(v * 100) / 100;
type Saldos = Record<string, number>;
const v = (s: Saldos, c: string) => s[c] ?? 0;

// Os saldos que a foto traz calculados. Conferem com o exemplo do estudo: 12.000 apurados, 10.000 apropriados,
// 7.500 utilizados e 2.500 de saldo credor.
export const DERIVADOS_CBS: { campo: string; nome: string; rotulo: string; calcular: (s: Saldos) => number }[] = [
  { campo: 'saldoDevedor', nome: 'debitos[].cbs.saldoDevedor', rotulo: 'Saldo devedor', calcular: (s) => r2(v(s, 'D.apurado') - v(s, 'D.inexigivel') - v(s, 'D.suspenso') - v(s, 'D.extinto')) },
  {
    campo: 'aApropriar', nome: 'creditos[].cbs.apropriacao.aApropriar', rotulo: 'A apropriar',
    calcular: (s) => r2(v(s, 'C.apurado') - v(s, 'C.inapropriavel') - v(s, 'C.suspenso') - v(s, 'C.prescrito') - v(s, 'C.apropriado')),
  },
  {
    campo: 'saldoCredor', nome: 'creditos[].cbs.utilizacao.naoUtilizado.saldoCredor', rotulo: 'Saldo credor',
    calcular: (s) => r2(v(s, 'C.apropriado') - v(s, 'C.utilizado') - v(s, 'C.inutilizavel') + v(s, 'C.restabelecido') - v(s, 'C.pedidoRessarcimento')),
  },
];

export const derivadoCbs = (s: Saldos, campo: string): number | undefined => DERIVADOS_CBS.find((d) => d.campo === campo)?.calcular(s);

// Pagamentos e recolhimentos não mudam a foto do documento: viram um registro no arquivo do endpoint (A.8).
// A enumeração do tipo não foi publicada; 1 PCONT, 2 RAD e 3 split são provisórios, declarados na collection.
export interface Pagamento { tipo: 1 | 2 | 3; niAdquirente?: boolean; atraso?: boolean }

export interface TipoCbs extends TipoEvento {
  ente: 'cbs';
  endpoint: Endpoint;
  pagamento?: Pagamento;
}

const SALDO = (campo: string): Base => ({ de: 'saldo', campo });
const APROPRIADO = [['C02'], ['C03']];

const T = (n: string, mov: string, grupo: string, lado: Lado, endpoint: Endpoint, efeito: TipoCbs['efeito'], base: Base, precisa: string[][], extra: Partial<TipoCbs> = {}): TipoCbs =>
  ({ ente: 'cbs', n, id: `E-CBS-${n}`, mov, grupo, lado, endpoint, efeito, base, precisa, ...extra });

// E-CBS-D07 conforme o lado e a nota que o origina. Leitura nossa: a documentação não diz como a foto muda.
const AJUSTE: Record<string, Variante> = {
  'fornecedor:complementar': { efeito: { 'D.apurado': 1 }, base: { de: 'relacionada' } },
  'fornecedor:devolucao': { efeito: { 'D.apurado': -1 }, base: { de: 'menor', bases: [SALDO('saldoDevedor'), { de: 'relacionada' }] } },
  'fornecedor:cancelamento': { efeito: { 'D.apurado': -1 }, base: SALDO('saldoDevedor') },
  'adquirente:cancelamento': { efeito: { 'D.apurado': 1 }, base: SALDO('C.utilizado'), origem: 30 },
  'adquirente:devolucao': { efeito: { 'D.apurado': 1 }, base: { de: 'relacionada' }, origem: 22 },
};

export const CATALOGO_CBS: TipoCbs[] = [
  T('D01', 'Débito registrado', 'Débitos', 'fornecedor', 'debitos', { 'D.apurado': 1 }, { de: 'nota' }, [], { unico: 'operacao' }),
  T('D02', 'Débito excedente', 'Débitos', 'fornecedor', 'debitos', { 'D.excedente': 1 }, { de: 'nota' }, [], { parcial: true }),
  T('D03', 'Extinção parcial', 'Débitos', 'fornecedor', 'debitos', { 'D.extinto': 1 }, SALDO('saldoDevedor'), [['D01']], { parcial: true, pctPadrao: 50 }),
  T('D04', 'Extinção total', 'Débitos', 'fornecedor', 'debitos', { 'D.extinto': 1 }, SALDO('saldoDevedor'), [['D01']]),
  T('D05', 'Débito inexigível', 'Débitos', 'fornecedor', 'debitos', { 'D.inexigivel': 1 }, SALDO('saldoDevedor'), [['D01']], { parcial: true }),
  T('D06', 'Débito suspenso', 'Débitos', 'fornecedor', 'debitos', { 'D.suspenso': 1 }, SALDO('saldoDevedor'), [['D01']], { parcial: true }),
  T('D07', 'Débito ajustado', 'Débitos', 'ambos', 'debitos', {}, { de: 'zero' }, [['D01'], ['C01']], {
    relacionada: 'ajuste', variantes: AJUSTE,
    nota: 'Leitura nossa: no fornecedor, o apurado sobe com a complementar, desce com a devolução e zera o saldo no cancelamento; no adquirente, abre um débito do documento com o crédito já utilizado (cancelamento, origem 30) ou com o valor da devolução (origem 22).',
  }),
  T('C01', 'Crédito registrado', 'Créditos', 'adquirente', 'creditos', { 'C.apurado': 1 }, { de: 'nota' }, [], { unico: 'operacao' }),
  T('C02', 'Apropriação total', 'Créditos', 'adquirente', 'creditos', { 'C.apropriado': 1 }, SALDO('aApropriar'), [['C01']]),
  T('C03', 'Apropriação parcial', 'Créditos', 'adquirente', 'creditos', { 'C.apropriado': 1 }, SALDO('aApropriar'), [['C01']], { parcial: true, pctPadrao: 50 }),
  T('C04', 'Crédito inapropriável', 'Créditos', 'adquirente', 'creditos', { 'C.inapropriavel': 1 }, SALDO('aApropriar'), [['C01']], { parcial: true }),
  T('C05', 'Apropriação suspensa', 'Créditos', 'adquirente', 'creditos', { 'C.suspenso': 1 }, SALDO('aApropriar'), [['C01']], { parcial: true }),
  T('C06', 'Crédito prescrito', 'Créditos', 'adquirente', 'creditos', { 'C.prescrito': 1 }, SALDO('aApropriar'), [['C01']], { parcial: true }),
  T('C07', 'Utilização', 'Créditos', 'adquirente', 'creditos', { 'C.utilizado': 1 }, SALDO('saldoCredor'), APROPRIADO, { parcial: true }),
  T('C08', 'Crédito inutilizável', 'Créditos', 'adquirente', 'creditos', { 'C.inutilizavel': 1 }, SALDO('saldoCredor'), APROPRIADO, { parcial: true }),
  T('C09', 'Crédito restabelecido', 'Créditos', 'adquirente', 'creditos', { 'C.restabelecido': 1 }, { de: 'acumulado', tipos: ['C08'], menos: ['C09'] }, [['C08']], { parcial: true }),
  T('C10', 'Saldo credor', 'Créditos', 'adquirente', 'creditos', {}, SALDO('saldoCredor'), APROPRIADO, {
    nota: 'Leitura nossa: republica a foto do documento com o saldo credor, sem mudar valor; só o atualizacao muda.',
  }),
  T('C11', 'Pedido de ressarcimento', 'Créditos', 'adquirente', 'creditos', { 'C.pedidoRessarcimento': 1 }, SALDO('saldoCredor'), APROPRIADO, { parcial: true }),
  T('C12', 'Crédito excedente', 'Créditos', 'adquirente', 'creditos', { 'C.excedente': 1 }, { de: 'nota' }, []),
  T('P01', 'Pagamento próprio (PCONT)', 'Pagamentos', 'fornecedor', 'pagamentos', {}, SALDO('saldoDevedor'), [['D01']], { parcial: true, pagamento: { tipo: 1 } }),
  T('P02', 'RAD recebido de um adquirente', 'Pagamentos', 'fornecedor', 'pagamentos', {}, SALDO('saldoDevedor'), [['D01']], { parcial: true, pagamento: { tipo: 2, niAdquirente: true } }),
  T('P03', 'Split', 'Pagamentos', 'fornecedor', 'pagamentos', {}, SALDO('saldoDevedor'), [['D01']], { parcial: true, pagamento: { tipo: 3 } }),
  T('P04', 'Pagamento em atraso', 'Pagamentos', 'fornecedor', 'pagamentos', {}, SALDO('saldoDevedor'), [['D01']], { parcial: true, pagamento: { tipo: 1, atraso: true } }),
  T('R01', 'RAD recolhido pelo cliente', 'Recolhimentos', 'adquirente', 'recolhimentos', {}, SALDO('C.apurado'), [['C01']], { parcial: true, pagamento: { tipo: 2 } }),
  T('R02', 'Split no pagamento do cliente', 'Recolhimentos', 'adquirente', 'recolhimentos', {}, SALDO('C.apurado'), [['C01']], { parcial: true, pagamento: { tipo: 3 } }),
  T('R03', 'Recolhimento em atraso', 'Recolhimentos', 'adquirente', 'recolhimentos', {}, SALDO('C.apurado'), [['C01']], { parcial: true, pagamento: { tipo: 2, atraso: true } }),
];

export const TIPO_CBS = new Map(CATALOGO_CBS.map((t) => [t.n, t]));

// Ordem em que os tipos escolhidos juntos entram (seção 09): o que só soma vem antes, o que leva o saldo inteiro vem
// depois do que leva parte dele, e o ajuste por último.
export const ORDEM_CBS = ['D01', 'D02', 'C01', 'C12', 'C03', 'C04', 'C05', 'C06', 'C02', 'C08', 'C09', 'C11', 'C07', 'C10',
  'D03', 'D05', 'D06', 'P01', 'P02', 'P03', 'P04', 'D04', 'R01', 'R02', 'R03', 'D07'];

// Aceita "E-CBS-C02", "CBS-C02", "C02" ou "c2".
export function numeroCbs(id: unknown): string | undefined {
  const m = /^(?:E-)?(?:CBS-)?([DCPR])0*(\d{1,2})$/i.exec(String(id ?? '').trim());
  if (!m) return undefined;
  const n = `${m[1].toUpperCase()}${m[2].padStart(2, '0')}`;
  return TIPO_CBS.has(n) ? n : undefined;
}

// Multa e juros ilustrativos do pagamento em atraso, redondos: 10% e 1% do principal, arredondados ao real.
export const multaJuros = (principal: number) => ({ multa: Math.round(principal * 0.1), juros: Math.round(principal * 0.01) });

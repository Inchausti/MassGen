// Catálogo dos eventos do IBS (proposta v4.3, seção 06; MOC v1.10, passo 7 e Anexo II).
// É dado, não código: quando a tabela de códigos do MOV sair, troca-se o texto aqui e o motor não muda.
// O valor de cada tipo sai de uma "base" declarada; o motor (execucao.ts) só a interpreta.

export type Campo = 'RFDT' | 'RFAT' | 'CAP' | 'CNU' | 'CU' | 'DEA' | 'DEX';

// Na ordem do Anexo I.
export const CAMPOS: { campo: Campo; nome: string; rotulo: string }[] = [
  { campo: 'RFDT', nome: 'RECURSO_FINANCEIRO_DISPONIVEL_PARA_TRANSFERENCIA', rotulo: 'Disponível para transferência' },
  { campo: 'RFAT', nome: 'RECURSO_FINANCEIRO_A_TRANSFERIR', rotulo: 'A transferir' },
  { campo: 'CAP', nome: 'CREDITO_A_PROPRIAR', rotulo: 'Crédito a apropriar' },
  { campo: 'CNU', nome: 'CREDITO_NAO_UTILIZADO', rotulo: 'Crédito não utilizado' },
  { campo: 'CU', nome: 'CREDITO_UTILIZADO', rotulo: 'Crédito utilizado' },
  { campo: 'DEA', nome: 'DEBITO_EM_ABERTO', rotulo: 'Débito em aberto' },
  { campo: 'DEX', nome: 'DEBITO_EXTINTO', rotulo: 'Débito extinto' },
];

export type Lado = 'adquirente' | 'fornecedor' | 'ambos';
export type Relacionada = 'complementar' | 'devolucao' | 'cancelamento';

// De onde sai o valor do evento.
export type Base =
  | { de: 'nota' } // IBS da nota que abriu a operação
  | { de: 'relacionada' } // IBS da nota complementar ou de devolução
  | { de: 'relacionada_menos'; tipos: string[] } // IBS da relacionada menos o que esses tipos já levaram dela
  | { de: 'saldo'; campo: Campo } // saldo do campo no extrato da operação
  | { de: 'acumulado'; tipos: string[]; menos?: string[] } // soma do valor desses tipos, menos a dos outros
  | { de: 'menor'; bases: Base[] }
  | { de: 'zero' };

export interface TipoIbs {
  n: string; // número sem prefixo, como na seção 08
  id: string; // E-IBS-NN
  mov: string; // texto do MOV, exato como no MOC
  grupo: string;
  lado: Lado;
  efeito: Partial<Record<Campo, 1 | -1>>;
  base: Base;
  precisa: string[][]; // alternativas (OU) de tipos que precisam ter acontecido antes (E)
  relacionada?: Relacionada;
  unico?: 'operacao' | 'relacionada';
  parcial?: boolean; // aceita fração do valor
  nota?: string; // leitura nossa, declarada
}

const T = (n: string, mov: string, grupo: string, lado: Lado, efeito: TipoIbs['efeito'], base: Base, precisa: string[][], extra: Partial<TipoIbs> = {}): TipoIbs =>
  ({ n, id: `E-IBS-${n}`, mov, grupo, lado, efeito, base, precisa, ...extra });

const SALDO = (campo: Campo): Base => ({ de: 'saldo', campo });
const DEBITO_ABERTO = [['02'], ['16'], ['20']];

export const CATALOGO_IBS: TipoIbs[] = [
  T('01', 'Aquisicao', 'Registro e complemento', 'adquirente', { CAP: 1 }, { de: 'nota' }, [], { unico: 'operacao' }),
  T('02', 'Fornecimento', 'Registro e complemento', 'fornecedor', { DEA: 1 }, { de: 'nota' }, [], { unico: 'operacao' }),
  T('03', 'Complemento de Aquisicao', 'Registro e complemento', 'adquirente', { CAP: 1 }, { de: 'relacionada' }, [['01']], { relacionada: 'complementar', unico: 'relacionada' }),
  T('04', 'Complemento de Fornecimento', 'Registro e complemento', 'fornecedor', { DEA: 1 }, { de: 'relacionada' }, [['02']], { relacionada: 'complementar', unico: 'relacionada' }),
  T('05', 'Apropriacao de Credito', 'Crédito', 'adquirente', { CAP: -1, CNU: 1 }, SALDO('CAP'), [['01'], ['03']], { parcial: true }),
  T('06', 'Utilizacao de Credito', 'Crédito', 'adquirente', { CNU: -1, CU: 1 }, SALDO('CNU'), [['05']], { parcial: true }),
  T('07', 'COMPENSAÇÃO COM CRÉDITOS POR AQUISIÇÃO', 'Crédito', 'ambos', {}, { de: 'zero' }, DEBITO_ABERTO,
    { nota: 'O MOC só mostra este MOV com os sete campos zerados; o emulador repete o exemplo.' }),
  T('08', 'Extincao por Compensacao', 'Extinção do débito', 'ambos', { DEA: -1, DEX: 1 }, SALDO('DEA'), DEBITO_ABERTO, { parcial: true }),
  T('09', 'Extincao por Recolhimento', 'Extinção do débito', 'ambos', { DEA: -1, DEX: 1 }, SALDO('DEA'), DEBITO_ABERTO, { parcial: true }),
  T('10', 'RAD provisionado', 'Extinção do débito', 'fornecedor', { DEA: -1, DEX: 1 }, SALDO('DEA'), [['02']], { parcial: true }),
  T('11', 'Estorno de RAD', 'Extinção do débito', 'fornecedor', { DEA: 1, DEX: -1 }, { de: 'acumulado', tipos: ['10'], menos: ['11'] }, [['10']], { parcial: true }),
  T('12', 'SPLIT provisionado', 'Extinção do débito', 'fornecedor', { DEA: -1, DEX: 1 }, SALDO('DEA'), [['02']], { parcial: true }),
  T('13', 'Estorno de SPLIT provisionado', 'Extinção do débito', 'fornecedor', { DEA: 1, DEX: -1 }, { de: 'acumulado', tipos: ['12'], menos: ['13'] }, [['12']], { parcial: true }),
  T('14', 'Extincao por SPLIT', 'Extinção do débito', 'fornecedor', { DEA: -1, DEX: 1 }, SALDO('DEA'), [['12']], { parcial: true }),
  T('15', 'Cancelamento - Estorno de Credito Nao Utilizado', 'Cancelamento', 'adquirente', { CNU: -1 }, SALDO('CNU'), [['05']], { relacionada: 'cancelamento', unico: 'operacao' }),
  T('16', 'Cancelamento - Abertura de Debito para Adquirente', 'Cancelamento', 'adquirente', { DEA: 1 }, SALDO('CU'), [['06']],
    { relacionada: 'cancelamento', unico: 'operacao', nota: 'Leitura nossa: o débito aberto é o crédito já utilizado.' }),
  T('17', 'Cancelamento - Estorno de Debito em aberto', 'Cancelamento', 'fornecedor', { DEA: -1 }, SALDO('DEA'), [['02']], { relacionada: 'cancelamento', unico: 'operacao' }),
  T('18', 'Cancelamento - SPLIT a transferir', 'Cancelamento', 'fornecedor', { RFAT: 1 }, { de: 'acumulado', tipos: ['14'], menos: ['18'] }, [['14']],
    { relacionada: 'cancelamento', unico: 'operacao', nota: 'Leitura nossa: o recurso a transferir é o que o split já extinguiu.' }),
  T('19', 'Devolucao - Estorno de Credito a apropriar', 'Devolução', 'adquirente', { CAP: -1 }, { de: 'menor', bases: [SALDO('CAP'), { de: 'relacionada' }] }, [['01']],
    { relacionada: 'devolucao', unico: 'relacionada' }),
  T('20', 'Devolucao - Abertura de Debito para Adquirente', 'Devolução', 'adquirente', { DEA: 1 }, { de: 'relacionada_menos', tipos: ['19'] }, [['06']],
    { relacionada: 'devolucao', unico: 'relacionada', nota: 'Leitura nossa: a parte da devolução que não saiu do crédito a apropriar.' }),
  T('21', 'Devolucao - Credito a apropriar', 'Devolução', 'fornecedor', { CAP: 1 }, { de: 'relacionada' }, [['02']],
    { relacionada: 'devolucao', unico: 'relacionada', parcial: true }),
  T('22', 'Devolucao - Apropriacao de Credito', 'Devolução', 'fornecedor', { CNU: 1 }, { de: 'relacionada_menos', tipos: ['21'] }, [['21']],
    { relacionada: 'devolucao', unico: 'relacionada', nota: 'Leitura nossa: o que a devolução não levou para o crédito a apropriar.' }),
  T('23', 'Transferencia para Fornecedor', 'Transferência ao fornecedor', 'fornecedor', { RFAT: -1, RFDT: 1 }, SALDO('RFAT'), [['18']], { parcial: true }),
  T('24', 'Transferencia para Fornecedor por Excesso', 'Transferência ao fornecedor', 'fornecedor', { RFDT: 1 }, { de: 'acumulado', tipos: ['10'], menos: ['24'] }, [['10']],
    { parcial: true, nota: 'Leitura nossa: o excesso é o RAD provisionado ainda não transferido.' }),
];

export const TIPO_IBS = new Map(CATALOGO_IBS.map((t) => [t.n, t]));

// Aceita "E-IBS-05", "IBS-05", "05" ou 5.
export function numeroIbs(id: unknown): string | undefined {
  const m = /^(?:E-)?(?:IBS-)?0*(\d{1,2})$/i.exec(String(id ?? '').trim());
  if (!m) return undefined;
  const n = m[1].padStart(2, '0');
  return TIPO_IBS.has(n) ? n : undefined;
}

// ---------------------------------------------------------------- roteiros (seção 08)

export interface Passo { tipo: string; pct?: number }
export interface Roteiro {
  id: string;
  lado: 'adquirente' | 'fornecedor';
  historia: string;
  cbs: string[];
  ibs: Passo[];
  precisa?: Relacionada;
}

// O IBS de cada roteiro vem com os passos que o fazem caber no saldo: a fração deixa saldo para o passo seguinte,
// como nos cenários do MOC. A CBS fica registrada para a etapa 2.
const P = (...xs: (string | [string, number])[]): Passo[] => xs.map((x) => (Array.isArray(x) ? { tipo: x[0], pct: x[1] } : { tipo: x }));

export const ROTEIROS: Roteiro[] = [
  { id: 'RT-A1', lado: 'adquirente', historia: 'Fornecedor recolhe; crédito apropriado e usado', cbs: ['C01', 'C02', 'C07'], ibs: P('01', '05', '06') },
  { id: 'RT-A2', lado: 'adquirente', historia: 'Cliente paga pelo RAD', cbs: ['C01', 'R01', 'C02'], ibs: P('01', '05') },
  { id: 'RT-A3', lado: 'adquirente', historia: 'Pagamento com split', cbs: ['C01', 'R02', 'C02'], ibs: P('01', '05') },
  { id: 'RT-A4', lado: 'adquirente', historia: 'Apropriação parcial, depois complemento', cbs: ['C03', 'C02'], ibs: P('01', ['05', 50], '03', '05'), precisa: 'complementar' },
  { id: 'RT-A5', lado: 'adquirente', historia: 'Cancelada depois de usada', cbs: ['C07', 'D07'], ibs: P('01', '05', ['06', 50], '15', '16', '08'), precisa: 'cancelamento' },
  { id: 'RT-A6', lado: 'adquirente', historia: 'Devolvida ao fornecedor', cbs: ['D07'], ibs: P('01', ['05', 50], '06', '19', '20', '09'), precisa: 'devolucao' },
  { id: 'RT-A7', lado: 'adquirente', historia: 'Crédito em risco', cbs: ['C04', 'C05', 'C06', 'C08', 'C09'], ibs: [] },
  { id: 'RT-A8', lado: 'adquirente', historia: 'Saldo credor e ressarcimento', cbs: ['C10', 'C11', 'C12'], ibs: [] },
  { id: 'RT-A9', lado: 'adquirente', historia: 'RAD em atraso', cbs: ['R03'], ibs: [] },
  { id: 'RT-F1', lado: 'fornecedor', historia: 'Cliente recolhe pelo PCONT', cbs: ['D01', 'P01', 'D04'], ibs: P('02', '09') },
  { id: 'RT-F2', lado: 'fornecedor', historia: 'Compensação com créditos', cbs: ['D01', 'D03', 'D04'], ibs: P('02', '07', '08') },
  { id: 'RT-F3', lado: 'fornecedor', historia: 'Cliente do cliente paga pelo RAD, com estorno e excesso', cbs: ['D01', 'P02', 'D04'], ibs: P('02', '10', '11', '08', '24') },
  { id: 'RT-F4', lado: 'fornecedor', historia: 'Split, com estorno', cbs: ['D01', 'P03', 'D04'], ibs: P('02', '12', '13', '14') },
  { id: 'RT-F5', lado: 'fornecedor', historia: 'Complemento de valor', cbs: ['D07'], ibs: P('02', '04'), precisa: 'complementar' },
  { id: 'RT-F6', lado: 'fornecedor', historia: 'Cancelada com split já retido', cbs: ['D07'], ibs: P('02', ['12', 50], '13', ['14', 50], '17', '18', '23'), precisa: 'cancelamento' },
  { id: 'RT-F7', lado: 'fornecedor', historia: 'Devolução recebida do cliente do cliente', cbs: ['C01', 'C02'], ibs: P('02', ['21', 50], '22'), precisa: 'devolucao' },
  { id: 'RT-F8', lado: 'fornecedor', historia: 'Débito excedente, inexigível, suspenso, pago em atraso', cbs: ['D02', 'D05', 'D06', 'P04'], ibs: [] },
];

export const ROTEIRO = new Map(ROTEIROS.map((r) => [r.id, r]));

export const ROTULO_RELACIONADA: Record<Relacionada, string> = {
  complementar: 'a nota complementar', devolucao: 'a nota de devolução', cancelamento: 'o XML do cancelamento',
};

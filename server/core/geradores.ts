// Catálogo de geradores. Cada gerador recebe os parâmetros do campo e o contexto do registro.
// Parâmetros em texto aceitam modelo: "{{ address.state }}".
import type { Gerador, RegistroGerado } from './tipos.ts';
import type { Rng } from './rng.ts';
import { avaliar, dinheiro, num, renderizar, somaDias, temModelo } from './expr.ts';
import { gerarCep, gerarCnpj, gerarCpf, montarChave } from './br.ts';
import { obter, clonar } from './caminhos.ts';
import {
  BAIRROS, EMPRESA_NOMES, EMPRESA_RAMOS, EMPRESA_SUFIXOS, LOGRADOUROS, NOMES, NOMES_RUA, SOBRENOMES, UF_POR_SIGLA, UFS,
} from './dados-br.ts';

export const OMITIR = Symbol('omitir');

export interface CtxGerador {
  rng: Rng;
  entrada: Record<string, unknown>;     // o registro (ou item) até aqui, com os pais acessíveis pelo nome da relação
  vars: Record<string, unknown>;        // $var, $exec, $ref, $indice, $registro
  referencia: string;                   // data de referência, AAAA-MM-DD
  indice: number;                       // posição do registro na entidade, a partir de 1
  anteriores: RegistroGerado[];         // registros já gerados da mesma entidade
}

type Fn = (p: Gerador, c: CtxGerador) => unknown | Promise<unknown>;

interface Definicao {
  rotulo: string;
  descricao: string;
  parametros: Record<string, string>;
  fn: Fn;
}

async function param(c: CtxGerador, v: unknown): Promise<unknown> {
  return temModelo(v) ? renderizar(v, c.entrada, c.vars) : v;
}

async function texto(c: CtxGerador, v: unknown, padrao = ''): Promise<string> {
  const r = await param(c, v);
  return r === undefined || r === null ? padrao : String(r);
}

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function slug(s: string): string {
  return semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
}

function dataBase(c: CtxGerador, base: unknown): string {
  if (typeof base === 'string' && /^\d{4}-\d{2}-\d{2}/.test(base)) return base.slice(0, 10);
  return c.referencia;
}

export const GERADORES: Record<string, Definicao> = {
  fixo: {
    rotulo: 'Valor fixo',
    descricao: 'Sempre o mesmo valor. Em texto, aceita modelo com {{ }}.',
    parametros: { valor: 'o valor' },
    fn: async (p, c) => (temModelo(p.valor) ? renderizar(p.valor, c.entrada, c.vars) : clonar(p.valor)),
  },
  expressao: {
    rotulo: 'Expressão',
    descricao: 'Calcula o valor com JSONata a partir do registro, dos pais e das variáveis.',
    parametros: { expr: 'expressão JSONata, ex.: $dinheiro($num(unit_price) * quantity)' },
    fn: (p, c) => avaliar(String(p.expr), c.entrada, c.vars),
  },
  variavel: {
    rotulo: 'Variável do destino',
    descricao: 'Valor de uma variável cadastrada no destino.',
    parametros: { nome: 'nome da variável' },
    fn: (p, c) => (c.vars.var as Record<string, unknown> | undefined)?.[String(p.nome)],
  },
  lista: {
    rotulo: 'Lista com pesos',
    descricao: 'Escolhe um dos valores. Cada item pode ser um valor ou { valor, peso }.',
    parametros: { valores: 'lista de valores ou de { valor, peso }' },
    fn: (p, c) => {
      const vs = (p.valores as unknown[]) ?? [];
      if (!vs.length) return null;
      const itens = vs.map((v) =>
        v && typeof v === 'object' && 'valor' in (v as object)
          ? { valor: (v as { valor: unknown }).valor, peso: num((v as { peso?: unknown }).peso ?? 1) }
          : { valor: v, peso: 1 });
      return clonar(c.rng.ponderado(itens));
    },
  },
  numero: {
    rotulo: 'Número',
    descricao: 'Número entre mínimo e máximo.',
    parametros: { min: 'mínimo', max: 'máximo', decimais: 'casas decimais (padrão 0)' },
    fn: (p, c) => {
      const min = num(p.min ?? 0);
      const max = num(p.max ?? 100);
      const dec = num(p.decimais ?? 0);
      if (!dec) return c.rng.inteiro(Math.ceil(min), Math.floor(max));
      const f = 10 ** dec;
      return c.rng.inteiro(Math.ceil(min * f), Math.floor(max * f)) / f;
    },
  },
  dinheiro: {
    rotulo: 'Valor monetário',
    descricao: 'Valor redondo entre mínimo e máximo, em passos (padrão 100), como texto com 2 casas: "3200.00".',
    parametros: { min: 'mínimo', max: 'máximo', passo: 'passo (padrão 100)' },
    fn: (p, c) => {
      const passo = num(p.passo ?? 100) || 100;
      const min = Math.ceil(num(p.min ?? passo) / passo);
      const max = Math.floor(num(p.max ?? passo * 100) / passo);
      return dinheiro(c.rng.inteiro(min, Math.max(min, max)) * passo);
    },
  },
  texto: {
    rotulo: 'Texto por padrão',
    descricao: 'Troca # por dígito, @ por letra maiúscula e ? por minúscula. Aceita modelo com {{ }}.',
    parametros: { padrao: 'ex.: SKU-####' },
    fn: async (p, c) => {
      const base = await texto(c, p.padrao);
      let s = '';
      for (const ch of base) {
        if (ch === '#') s += String(c.rng.inteiro(0, 9));
        else if (ch === '@') s += String.fromCharCode(65 + c.rng.inteiro(0, 25));
        else if (ch === '?') s += String.fromCharCode(97 + c.rng.inteiro(0, 25));
        else s += ch;
      }
      return s;
    },
  },
  sequencia: {
    rotulo: 'Sequência',
    descricao: 'Número sequencial pela posição do registro, com prefixo e zeros à esquerda.',
    parametros: { inicio: 'primeiro número (padrão 1)', passo: 'passo (padrão 1)', digitos: 'tamanho com zeros', prefixo: 'texto antes', sufixo: 'texto depois' },
    fn: async (p, c) => {
      const n = num(p.inicio ?? 1) + (c.indice - 1) * num(p.passo ?? 1);
      const corpo = p.digitos ? String(n).padStart(num(p.digitos), '0') : String(n);
      return `${await texto(c, p.prefixo)}${corpo}${await texto(c, p.sufixo)}`;
    },
  },
  data: {
    rotulo: 'Data',
    descricao: 'Data relativa à data de referência (ou a outra data), em AAAA-MM-DD.',
    parametros: { base: 'referencia ou uma data (aceita modelo)', min: 'dias a somar, mínimo', max: 'dias a somar, máximo' },
    fn: async (p, c) => {
      const base = dataBase(c, await param(c, p.base));
      return somaDias(base, c.rng.inteiro(num(p.min ?? 0), num(p.max ?? p.min ?? 0)));
    },
  },
  data_hora: {
    rotulo: 'Data e hora',
    descricao: 'Data e hora no fuso de Brasília (-03:00), relativa à data de referência.',
    parametros: { base: 'referencia ou uma data', min: 'dias, mínimo', max: 'dias, máximo', horaMin: 'hora inicial (padrão 8)', horaMax: 'hora final (padrão 18)' },
    fn: async (p, c) => {
      const dia = somaDias(dataBase(c, await param(c, p.base)), c.rng.inteiro(num(p.min ?? 0), num(p.max ?? p.min ?? 0)));
      const h = c.rng.inteiro(num(p.horaMin ?? 8), num(p.horaMax ?? 18));
      const m = c.rng.inteiro(0, 59);
      return `${dia}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`;
    },
  },
  booleano: {
    rotulo: 'Verdadeiro ou falso',
    descricao: 'Verdadeiro com a probabilidade indicada.',
    parametros: { probabilidade: 'de 0 a 1 (padrão 0.5)' },
    fn: (p, c) => c.rng.booleano(num(p.probabilidade ?? 0.5)),
  },
  uuid: {
    rotulo: 'UUID',
    descricao: 'Identificador UUID v4, reprodutível pela semente.',
    parametros: {},
    fn: (_p, c) => {
      const h = Array.from({ length: 32 }, () => c.rng.inteiro(0, 15).toString(16));
      h[12] = '4';
      h[16] = ((c.rng.inteiro(0, 15) & 0x3) | 0x8).toString(16);
      const s = h.join('');
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    },
  },
  empresa: {
    rotulo: 'Nome de empresa',
    descricao: 'Razão social fictícia. O sufixo aceita modelo, ex.: " — MASSA {{ $exec.codigo }}".',
    parametros: { sufixo: 'texto ao final' },
    fn: async (p, c) =>
      `${c.rng.escolher(EMPRESA_RAMOS)} ${c.rng.escolher(EMPRESA_NOMES)} ${c.rng.escolher(EMPRESA_SUFIXOS)}${await texto(c, p.sufixo)}`,
  },
  pessoa: {
    rotulo: 'Nome de pessoa',
    descricao: 'Nome fictício.',
    parametros: {},
    fn: (_p, c) => `${c.rng.escolher(NOMES)} ${c.rng.escolher(SOBRENOMES)} ${c.rng.escolher(SOBRENOMES)}`,
  },
  email: {
    rotulo: 'E-mail',
    descricao: 'E-mail fictício. Usa o texto de "usuario" (aceita modelo) ou um nome aleatório.',
    parametros: { dominio: 'padrão exemplo.com.br', usuario: 'base do usuário' },
    fn: async (p, c) => {
      const base = (await texto(c, p.usuario)) || `${c.rng.escolher(NOMES)} ${c.rng.escolher(SOBRENOMES)}`;
      return `${slug(base).slice(0, 30) || 'contato'}@${await texto(c, p.dominio, 'exemplo.com.br')}`;
    },
  },
  telefone: {
    rotulo: 'Telefone',
    descricao: 'Telefone com DDD, só dígitos.',
    parametros: { ddd: 'DDD (padrão aleatório)', celular: 'true para celular' },
    fn: async (p, c) => {
      const ddd = (await texto(c, p.ddd)) || c.rng.escolher(['11', '21', '31', '41', '51', '61', '71', '81']);
      return p.celular ? `${ddd}9${c.rng.digitos(8)}` : `${ddd}3${c.rng.digitos(7)}`;
    },
  },
  cnpj: {
    rotulo: 'CNPJ',
    descricao: 'CNPJ com dígito verificador. Prefixo marca a massa; raiz copia a raiz de outro CNPJ (filial).',
    parametros: { prefixo: 'início da raiz, ex.: 9', raiz: 'CNPJ ou raiz de 8 dígitos (aceita modelo)', filial: 'ordem da filial (padrão 1, a matriz)' },
    fn: async (p, c) =>
      gerarCnpj(c.rng, { prefixo: await texto(c, p.prefixo), raiz: await texto(c, p.raiz), filial: num(p.filial ?? 1) || 1 }),
  },
  cpf: {
    rotulo: 'CPF',
    descricao: 'CPF com dígito verificador. Pode coincidir com o de uma pessoa real: use só onde o destino exige.',
    parametros: {},
    fn: (_p, c) => gerarCpf(c.rng),
  },
  uf: {
    rotulo: 'UF',
    descricao: 'Sigla de UF. Sem valores, sorteia entre todas.',
    parametros: { valores: 'lista de siglas ou de { valor, peso }' },
    fn: (p, c) => {
      const vs = p.valores as unknown[] | undefined;
      if (!vs?.length) return c.rng.escolher(UFS).sigla;
      return GERADORES.lista.fn({ tipo: 'lista', valores: vs }, c);
    },
  },
  cep: {
    rotulo: 'CEP',
    descricao: 'CEP de 8 dígitos dentro da faixa da UF.',
    parametros: { uf: 'sigla da UF (aceita modelo)' },
    fn: async (p, c) => gerarCep(c.rng, await texto(c, p.uf)),
  },
  municipio: {
    rotulo: 'Município',
    descricao: 'Nome de um município da UF.',
    parametros: { uf: 'sigla da UF (aceita modelo)' },
    fn: async (p, c) => {
      const u = UF_POR_SIGLA.get((await texto(c, p.uf)).toUpperCase()) ?? c.rng.escolher(UFS);
      return c.rng.escolher(u.municipios).nome;
    },
  },
  municipio_ibge: {
    rotulo: 'Código IBGE do município',
    descricao: 'Código de 7 dígitos de um município da UF.',
    parametros: { uf: 'sigla da UF (aceita modelo)' },
    fn: async (p, c) => {
      const u = UF_POR_SIGLA.get((await texto(c, p.uf)).toUpperCase()) ?? c.rng.escolher(UFS);
      return c.rng.escolher(u.municipios).ibge;
    },
  },
  logradouro: {
    rotulo: 'Logradouro',
    descricao: 'Nome de rua fictício.',
    parametros: {},
    fn: (_p, c) => `${c.rng.escolher(LOGRADOUROS)} ${c.rng.escolher(NOMES_RUA)}`,
  },
  bairro: {
    rotulo: 'Bairro',
    descricao: 'Nome de bairro.',
    parametros: {},
    fn: (_p, c) => c.rng.escolher(BAIRROS),
  },
  chave_dfe: {
    rotulo: 'Chave de acesso de documento fiscal',
    descricao: 'Chave de 44 dígitos montada com UF, data, CNPJ, modelo, série e número do registro, com dígito verificador.',
    parametros: { uf: 'UF (aceita modelo)', data: 'data de emissão', cnpj: 'CNPJ do emitente', modelo: 'modelo', serie: 'série', numero: 'número', dvInvalido: 'true para errar o dígito de propósito' },
    fn: async (p, c) =>
      montarChave(
        {
          uf: await texto(c, p.uf, 'SP'),
          data: await texto(c, p.data, c.referencia),
          cnpj: await texto(c, p.cnpj),
          modelo: await texto(c, p.modelo, '55'),
          serie: await texto(c, p.serie, '1'),
          numero: await texto(c, p.numero, String(c.indice)),
        },
        c.rng,
        Boolean(p.dvInvalido),
      ),
  },
  repetir: {
    rotulo: 'Repetir de outro registro',
    descricao: 'Copia o campo do primeiro registro da mesma entidade — para testar duplicidade.',
    parametros: { campo: 'caminho do campo a copiar' },
    fn: (p, c) => {
      const fonte = c.anteriores.find((r) => !r.caso) ?? c.anteriores[0];
      return fonte ? clonar(obter(fonte.dados, String(p.campo))) : null;
    },
  },
  id_remoto: {
    rotulo: 'Id do pai no destino',
    descricao: 'Id que o destino devolveu ao criar o pai. Resolvido na hora do envio.',
    parametros: { relacao: 'nome da relação' },
    fn: (p) => `{{$remoto.${String(p.relacao)}}}`,
  },
  nulo: {
    rotulo: 'Nulo',
    descricao: 'Valor null.',
    parametros: {},
    fn: () => null,
  },
  omitir: {
    rotulo: 'Omitir o campo',
    descricao: 'O campo não vai no registro. Útil para casos de borda.',
    parametros: {},
    fn: () => OMITIR,
  },
};

export function catalogoGeradores() {
  return Object.entries(GERADORES).map(([tipo, d]) => ({ tipo, rotulo: d.rotulo, descricao: d.descricao, parametros: d.parametros }));
}

export async function executarGerador(g: Gerador, c: CtxGerador): Promise<unknown> {
  const def = GERADORES[g.tipo];
  if (!def) throw new Error(`Gerador desconhecido: ${g.tipo}`);
  return def.fn(g, c);
}

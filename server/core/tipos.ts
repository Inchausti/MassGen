// Tipos do núcleo genérico. Nada aqui conhece um domínio: entidades, campos e regras são configuração.

export type Gerador = { tipo: string; [parametro: string]: unknown };

export interface Campo {
  nome: string;                 // caminho com pontos: address.state
  tipo?: 'texto' | 'inteiro' | 'decimal' | 'data' | 'data_hora' | 'booleano' | 'objeto' | 'lista';
  descricao?: string;
  obrigatorio?: boolean;
  unico?: boolean;              // único na execução
  gerador?: Gerador;
  itens?: { quantidade: { min: number; max: number }; campos: Campo[] }; // para tipo lista
}

export interface Relacao {
  nome: string;                 // como o registro chama o pai: contrato
  entidade: string;             // entidade do pai
  modo?: 'aleatorio' | 'um_para_um';
  via?: string;                 // pega o pai através de outra relação: o fornecedor do contrato
  // Como a integração liga o registro ao pai: o campo deste registro que guarda a chave do pai.
  // Ex.: contrato.supplier_cnpj = fornecedor.cnpj. Com isso, um cadastro só é salvo ligado a um pai cadastrado.
  campo?: string;
  chave?: string;
}

export interface Assercao {
  caminho: string;              // caminho no JSON da resposta: status, failure.code
  igual?: unknown;
  em?: unknown[];
  existe?: boolean;
}

export interface Esperado {
  status?: number | [number, number];
  codigo?: string;              // código de erro esperado na resposta
  caminhoCodigo?: string;       // onde está o código; se omitido, tenta error, code, failure.code
  assercoes?: Assercao[];
}

export interface Conferencia {
  acao?: string;                // operação usada para consultar (padrão: consultar)
  tentativas?: number;
  intervaloMs?: number;
  esperado: Esperado;
}

export interface Perfil {
  nome: string;
  rotulo?: string;
  peso: number;
  campos?: Record<string, Gerador>;
  esperado?: Esperado;
  conferencia?: Conferencia;
}

export interface Regra {
  nome: string;
  expr: string;                 // expressão JSONata que precisa dar verdadeiro
  mensagem: string;
}

export interface CasoBorda {
  id: string;
  rotulo: string;
  descricao?: string;
  quebra?: string;              // nome da regra que o caso quebra de propósito
  campos: Record<string, Gerador>;
  esperado: Esperado;
  conferencia?: Conferencia;
}

export interface ModeloEntidade {
  nome: string;
  rotulo: string;
  descricao?: string;
  rotuloRegistro?: string;      // modelo do rótulo na tela: {{legal_name}}
  idRemoto?: string;            // caminho do id na resposta da criação (padrão: id)
  campos: Campo[];
  relacoes?: Relacao[];
  perfis?: Perfil[];
  regras?: Regra[];
  casos?: CasoBorda[];
  esperado?: Esperado;
  conferencia?: Conferencia;
}

export interface EntidadeCenario {
  entidade: string;
  quantidade?: number;
  porPai?: { relacao: string; min: number; max: number };
  perfis?: Record<string, number>;   // pesos por perfil
  casos?: Record<string, number>;    // quantos registros de cada caso de borda
  cadastros?: string[];              // cadastros mestres a usar antes dos gerados
}

export interface DefinicaoCenario {
  entidades: EntidadeCenario[];
  semente?: number;
  dataReferencia?: string;           // AAAA-MM-DD
}

export interface CadastroUsado {
  id: string;
  entidade: string;
  rotulo: string;
  dados: Record<string, unknown>;
  idRemoto?: string;
  pais?: Record<string, string>;    // relação -> id do cadastro pai
}

export interface RegistroGerado {
  id: string;
  entidade: string;
  indice: number;
  ordem: number;
  rotulo: string;
  perfil?: string;
  caso?: string;
  cadastroId?: string;
  idRemoto?: string;
  pais: Record<string, string>;      // relação -> id do registro pai
  dados: Record<string, unknown>;
  esperado: Esperado;
  conferencia?: Conferencia;
  avisos: string[];
}

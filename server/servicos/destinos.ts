// Integrações (no código, "destinos"): cadastro, papel, segredos, operações (estrutura de APIs) e importação do Postman.
// Desde a v3.0 toda integração pertence a um ambiente e tem um papel: cliente (o app chama a API do sistema testado)
// ou emulador (o app faz o papel de um ente que o sistema integra e entrega eventos nas rotas do sistema).
import { agora, executar, json, novoId, todos, transacao, um } from '../db.ts';
import { conferirDominio } from '../config.ts';
import { ErroHttp } from '../http.ts';
import { lerSegredo, removerSegredo, resumoSegredos, salvarSegredo } from '../cofre.ts';
import type { Autenticacao, ResultadoLeitura } from '../importers/postman.ts';
import { corpoComoJson, lerPostman, normalizarRota } from '../importers/postman.ts';
import { modelosDoPacote, obterPacote, type OperacaoPadrao } from './pacotes.ts';
import { caminhosFolha } from '../core/caminhos.ts';
import { ambientePadraoPara, obterAmbiente } from './ambientes.ts';
import { environmentComSegredos, obterVersao, rotuloVersao } from './biblioteca.ts';
import type { ModeloEntidade } from '../core/tipos.ts';

export type TipoAmbiente = 'sandbox' | 'homologacao' | 'desenvolvimento';
export type Papel = 'cliente' | 'emulador';
export const PAPEIS: Papel[] = ['cliente', 'emulador'];
export type StatusIntegracao = 'pronta' | 'sem_teste' | 'falha' | 'aguardando_rota' | 'inativa';

export interface Destino {
  id: string;
  nome: string;
  tipoAmbiente: TipoAmbiente;
  baseUrl: string;
  pacoteId: string | null;
  autenticacao: Autenticacao;
  limites: { porMinuto?: number; tentativas?: number; timeoutMs?: number };
  idempotencia: { cabecalho?: string };
  cabecalhos: Record<string, string>;
  variaveis: Record<string, string>;
  teste: { metodo?: string; rota?: string };
  rastreio: { cabecalho?: string };
  ativo: boolean;
  ultimoTeste: unknown;
  ambienteId: string | null;
  papel: Papel;
  ente: string | null;
  colecaoVersaoId: string | null;
  environmentVersaoId: string | null;
  criadoEm: string;
  atualizadoEm: string;
}

export interface Operacao {
  id: string;
  destinoId: string;
  nome: string;
  pasta: string | null;
  entidade: string | null;
  acao: string | null;
  metodo: string;
  rota: string;
  cabecalhos: Record<string, string>;
  corpo: string | null;
  usarCorpo: boolean;
  origem: 'importada' | 'manual' | 'pacote';
  ordem: number;
}

export const ACOES = ['criar', 'consultar', 'atualizar', 'remover', 'listar'] as const;
export const SEGREDOS_POR_AUTH: Record<string, string[]> = {
  nenhuma: [], chave_api: ['api_key'], basic: ['senha'], bearer: ['token'], oauth2_cc: ['client_id', 'client_secret'],
};

function linhaParaDestino(l: Record<string, unknown>): Destino {
  return {
    id: l.id as string,
    nome: l.nome as string,
    tipoAmbiente: l.tipo_ambiente as TipoAmbiente,
    baseUrl: l.base_url as string,
    pacoteId: (l.pacote_id as string) ?? null,
    autenticacao: json(l.autenticacao, { tipo: 'nenhuma' } as Autenticacao),
    limites: json(l.limites, {}),
    idempotencia: json(l.idempotencia, {}),
    cabecalhos: json(l.cabecalhos, {}),
    variaveis: json(l.variaveis, {}),
    teste: json(l.teste, {}),
    rastreio: json(l.rastreio, { cabecalho: 'X-MassGen-Rastreio' }),
    ativo: !!l.ativo,
    ultimoTeste: json(l.ultimo_teste, null),
    ambienteId: (l.ambiente_id as string) ?? null,
    papel: ((l.papel as string) === 'emulador' ? 'emulador' : 'cliente') as Papel,
    ente: (l.ente as string) ?? null,
    colecaoVersaoId: (l.colecao_versao_id as string) ?? null,
    environmentVersaoId: (l.environment_versao_id as string) ?? null,
    criadoEm: l.criado_em as string,
    atualizadoEm: l.atualizado_em as string,
  };
}

function linhaParaOperacao(l: Record<string, unknown>): Operacao {
  return {
    id: l.id as string, destinoId: l.destino_id as string, nome: l.nome as string, pasta: (l.pasta as string) ?? null,
    entidade: (l.entidade as string) ?? null, acao: (l.acao as string) ?? null, metodo: l.metodo as string, rota: l.rota as string,
    cabecalhos: json(l.cabecalhos, {}), corpo: (l.corpo as string) ?? null, usarCorpo: !!l.usar_corpo,
    origem: l.origem as Operacao['origem'], ordem: l.ordem as number,
  };
}

export function dominiosProducaoDo(destino: Pick<Destino, 'pacoteId'>): string[] {
  return destino.pacoteId ? obterPacote(destino.pacoteId)?.dominiosProducao ?? [] : [];
}

export function obterDestino(id: string): Destino {
  const l = um('SELECT * FROM destinos WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Destino não encontrado.');
  return linhaParaDestino(l);
}

// Situação da integração para a tela. Ente emulado sem nenhuma rota ainda aguarda as rotas do sistema testado.
export function statusIntegracao(d: Destino, operacoes: number): StatusIntegracao {
  if (!d.ativo) return 'inativa';
  if (d.papel === 'emulador' && operacoes === 0) return 'aguardando_rota';
  const t = d.ultimoTeste as { ok?: boolean } | null;
  if (!t) return 'sem_teste';
  return t.ok ? 'pronta' : 'falha';
}

function nomeDoAmbiente(id: string | null): { id: string; nome: string } | null {
  if (!id) return null;
  const a = um<{ id: string; nome: string }>('SELECT id, nome FROM ambientes WHERE id = ?', id);
  return a ? { id: a.id, nome: a.nome } : null;
}

export function listarDestinos(filtro: { ambienteId?: string } = {}) {
  const linhas = filtro.ambienteId
    ? todos('SELECT * FROM destinos WHERE ambiente_id = ? ORDER BY nome', filtro.ambienteId)
    : todos('SELECT * FROM destinos ORDER BY nome');
  return linhas.map((l) => {
    const d = linhaParaDestino(l);
    const ops = um<{ n: number }>('SELECT COUNT(*) AS n FROM operacoes WHERE destino_id = ?', d.id)?.n ?? 0;
    return {
      ...d, operacoes: ops, segredos: resumoSegredos(d.id), status: statusIntegracao(d, ops), ambiente: nomeDoAmbiente(d.ambienteId),
      colecao: rotuloVersao(d.colecaoVersaoId), environment: rotuloVersao(d.environmentVersaoId),
    };
  });
}

export function detalharDestino(id: string) {
  const d = obterDestino(id);
  const exigidos = SEGREDOS_POR_AUTH[d.autenticacao.tipo] ?? [];
  const segredos = resumoSegredos(id);
  const ops = um<{ n: number }>('SELECT COUNT(*) AS n FROM operacoes WHERE destino_id = ?', id)?.n ?? 0;
  return {
    ...d,
    status: statusIntegracao(d, ops),
    ambiente: nomeDoAmbiente(d.ambienteId),
    colecao: rotuloVersao(d.colecaoVersaoId),
    environment: rotuloVersao(d.environmentVersaoId),
    segredos,
    segredosFaltando: exigidos.filter((s) => !segredos.some((x) => x.chave === s)),
    dominio: conferirDominio(d.baseUrl, dominiosProducaoDo(d)),
    pacote: d.pacoteId ? { id: d.pacoteId, nome: obterPacote(d.pacoteId)?.nome } : null,
  };
}

function validarDestino(dados: Partial<Destino>): void {
  if (!dados.nome?.trim()) throw new ErroHttp(422, 'Informe o nome da integração.');
  if (dados.papel && !PAPEIS.includes(dados.papel)) throw new ErroHttp(422, 'Papel da integração: cliente ou emulador.');
  if (dados.papel === 'emulador' && !dados.ente?.trim()) throw new ErroHttp(422, 'Informe qual ente a integração emula, como Receita Federal ou Comitê Gestor do IBS.');
  if (!['sandbox', 'homologacao', 'desenvolvimento'].includes(dados.tipoAmbiente ?? '')) {
    throw new ErroHttp(422, 'Tipo de ambiente: sandbox, homologação ou desenvolvimento. Produção não é aceita.');
  }
  const r = conferirDominio(dados.baseUrl ?? '', dados.pacoteId ? obterPacote(dados.pacoteId)?.dominiosProducao ?? [] : []);
  if (!r.ok) throw new ErroHttp(422, r.motivo!);
  const tipo = dados.autenticacao?.tipo ?? 'nenhuma';
  if (!SEGREDOS_POR_AUTH[tipo]) throw new ErroHttp(422, `Tipo de autenticação desconhecido: ${tipo}.`);
  if (tipo === 'oauth2_cc' && !dados.autenticacao?.tokenUrl) throw new ErroHttp(422, 'Informe o endereço do token (OAuth 2.0).');
  if (tipo === 'chave_api' && !dados.autenticacao?.cabecalho) throw new ErroHttp(422, 'Informe o cabeçalho da chave de API.');
}

export function criarDestino(dados: Partial<Destino>): Destino {
  // O ambiente manda no tipo e sugere o pacote. Sem ambiente (v2.0), vai para o ambiente do pacote e do tipo.
  if (dados.ambienteId) {
    const amb = obterAmbiente(dados.ambienteId);
    dados = { ...dados, tipoAmbiente: amb.tipo, pacoteId: dados.pacoteId === undefined ? amb.pacoteId : dados.pacoteId };
  }
  const pacote = dados.pacoteId ? obterPacote(dados.pacoteId) : undefined;
  if (dados.pacoteId && !pacote) throw new ErroHttp(422, 'Pacote não encontrado.');
  const padrao = pacote?.destinoPadrao ?? {};
  const completo: Partial<Destino> = {
    ...dados,
    autenticacao: (dados.autenticacao ?? padrao.autenticacao ?? { tipo: 'nenhuma' }) as Autenticacao,
    limites: dados.limites ?? (padrao.limites as Destino['limites']) ?? {},
    idempotencia: dados.idempotencia ?? (padrao.idempotencia as Destino['idempotencia']) ?? {},
    cabecalhos: dados.cabecalhos ?? padrao.cabecalhos ?? {},
    variaveis: { ...(padrao.variaveis ?? {}), ...(dados.variaveis ?? {}) },
    teste: dados.teste ?? padrao.teste ?? {},
    rastreio: dados.rastreio ?? { cabecalho: 'X-MassGen-Rastreio' },
  };
  validarDestino(completo);
  const ambienteId = dados.ambienteId ?? ambientePadraoPara(completo.pacoteId ?? null, completo.tipoAmbiente!).id;
  const papel: Papel = dados.papel ?? 'cliente';
  const id = novoId('dst');
  const t = agora();
  executar(
    `INSERT INTO destinos (id, nome, tipo_ambiente, base_url, pacote_id, autenticacao, limites, idempotencia, cabecalhos, variaveis, teste, rastreio, ativo,
       ambiente_id, papel, ente, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    id, completo.nome!.trim(), completo.tipoAmbiente!, completo.baseUrl!.replace(/\/$/, ''), completo.pacoteId ?? null,
    JSON.stringify(completo.autenticacao), JSON.stringify(completo.limites), JSON.stringify(completo.idempotencia),
    JSON.stringify(completo.cabecalhos), JSON.stringify(completo.variaveis), JSON.stringify(completo.teste), JSON.stringify(completo.rastreio),
    ambienteId, papel, papel === 'emulador' ? completo.ente!.trim() : null, t, t,
  );
  // Ente emulado não recebe as operações padrão de cliente do pacote: as rotas dele são as que o sistema testado expõe.
  if (pacote && papel === 'cliente') aplicarOperacoesDoPacote(id);
  return obterDestino(id);
}

export function atualizarDestino(id: string, dados: Partial<Destino>): Destino {
  const atual = obterDestino(id);
  const novo = { ...atual, ...dados, id };
  if (novo.ambienteId) novo.tipoAmbiente = obterAmbiente(novo.ambienteId).tipo;
  validarDestino(novo);
  executar(
    `UPDATE destinos SET nome = ?, tipo_ambiente = ?, base_url = ?, pacote_id = ?, autenticacao = ?, limites = ?, idempotencia = ?,
       cabecalhos = ?, variaveis = ?, teste = ?, rastreio = ?, ativo = ?, ambiente_id = ?, papel = ?, ente = ?, atualizado_em = ? WHERE id = ?`,
    novo.nome.trim(), novo.tipoAmbiente, novo.baseUrl.replace(/\/$/, ''), novo.pacoteId ?? null, JSON.stringify(novo.autenticacao),
    JSON.stringify(novo.limites), JSON.stringify(novo.idempotencia), JSON.stringify(novo.cabecalhos), JSON.stringify(novo.variaveis),
    JSON.stringify(novo.teste), JSON.stringify(novo.rastreio ?? {}), novo.ativo ? 1 : 0, novo.ambienteId, novo.papel,
    novo.papel === 'emulador' ? novo.ente?.trim() || null : null, agora(), id,
  );
  return obterDestino(id);
}

export function removerDestino(id: string): void {
  obterDestino(id);
  const ativa = um<{ n: number }>("SELECT COUNT(*) AS n FROM execucoes WHERE destino_id = ? AND status IN ('enviando', 'conferindo')", id);
  if (ativa && ativa.n) throw new ErroHttp(409, 'Há execução em andamento nesta integração.');
  executar('DELETE FROM destinos WHERE id = ?', id);
}

export function definirSegredo(destinoId: string, chave: string, valor: string | null): void {
  obterDestino(destinoId);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(chave)) throw new ErroHttp(422, 'Nome de segredo inválido.');
  if (valor === null || valor === '') removerSegredo(destinoId, chave);
  else salvarSegredo(destinoId, chave, valor);
}

export function segredo(destinoId: string, chave: string): string | undefined {
  return lerSegredo(destinoId, chave);
}

// ---------------------------------------------------------------- operações

export function listarOperacoes(destinoId: string): Operacao[] {
  return todos('SELECT * FROM operacoes WHERE destino_id = ? ORDER BY ordem, nome', destinoId).map(linhaParaOperacao);
}

const PRIORIDADE = { manual: 0, importada: 1, pacote: 2 } as const;

export function operacaoPara(destinoId: string, entidade: string, acao: string): Operacao | undefined {
  return listarOperacoes(destinoId)
    .filter((o) => o.entidade === entidade && o.acao === acao)
    .sort((a, b) => PRIORIDADE[a.origem] - PRIORIDADE[b.origem] || a.ordem - b.ordem)[0];
}

function inserirOperacao(destinoId: string, o: Partial<Operacao> & { metodo: string; rota: string; nome: string; origem: Operacao['origem'] }): string {
  const id = novoId('op');
  executar(
    `INSERT INTO operacoes (id, destino_id, nome, pasta, entidade, acao, metodo, rota, cabecalhos, corpo, usar_corpo, origem, ordem, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, destinoId, o.nome, o.pasta ?? null, o.entidade ?? null, o.acao ?? null, o.metodo.toUpperCase(), o.rota,
    JSON.stringify(o.cabecalhos ?? {}), o.corpo ?? null, o.usarCorpo ? 1 : 0, o.origem, o.ordem ?? 0, agora(),
  );
  return id;
}

function validarOperacao(o: Partial<Operacao>): void {
  if (!o.nome?.trim()) throw new ErroHttp(422, 'Informe o nome da operação.');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(o.metodo).toUpperCase())) throw new ErroHttp(422, 'Método inválido.');
  if (!o.rota?.trim()) throw new ErroHttp(422, 'Informe a rota.');
  if (o.acao && !ACOES.includes(o.acao as (typeof ACOES)[number])) throw new ErroHttp(422, `Ação inválida: use ${ACOES.join(', ')}.`);
  if (o.acao && !o.entidade) throw new ErroHttp(422, 'Uma operação com ação precisa de entidade.');
}

export function criarOperacao(destinoId: string, o: Partial<Operacao>): Operacao {
  obterDestino(destinoId);
  validarOperacao(o);
  const id = inserirOperacao(destinoId, { ...o, nome: o.nome!, metodo: o.metodo!, rota: o.rota!, origem: 'manual' });
  return linhaParaOperacao(um('SELECT * FROM operacoes WHERE id = ?', id)!);
}

export function atualizarOperacao(id: string, o: Partial<Operacao>): Operacao {
  const atual = um('SELECT * FROM operacoes WHERE id = ?', id);
  if (!atual) throw new ErroHttp(404, 'Operação não encontrada.');
  const novo = { ...linhaParaOperacao(atual), ...o };
  validarOperacao(novo);
  // Editar à mão uma operação do pacote ou importada a torna manual: a importação seguinte não a sobrescreve.
  executar(
    `UPDATE operacoes SET nome = ?, pasta = ?, entidade = ?, acao = ?, metodo = ?, rota = ?, cabecalhos = ?, corpo = ?, usar_corpo = ?,
       origem = 'manual', atualizado_em = ? WHERE id = ?`,
    novo.nome, novo.pasta, novo.entidade || null, novo.acao || null, novo.metodo.toUpperCase(), novo.rota,
    JSON.stringify(novo.cabecalhos ?? {}), novo.corpo, novo.usarCorpo ? 1 : 0, agora(), id,
  );
  return linhaParaOperacao(um('SELECT * FROM operacoes WHERE id = ?', id)!);
}

export function removerOperacao(id: string): void {
  executar('DELETE FROM operacoes WHERE id = ?', id);
}

// Operações padrão do pacote que ainda não existem no destino (D-09: usadas quando a collection não tem a requisição).
export function aplicarOperacoesDoPacote(destinoId: string): number {
  const d = obterDestino(destinoId);
  if (!d.pacoteId) return 0;
  const ops = obterPacote(d.pacoteId)?.operacoes ?? [];
  const existentes = listarOperacoes(destinoId);
  let n = 0;
  for (const [i, o] of ops.entries()) {
    if (existentes.some((e) => e.entidade === o.entidade && e.acao === o.acao)) continue;
    inserirOperacao(destinoId, { ...o, origem: 'pacote', ordem: 1000 + i });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- importação do Postman

interface Ligacao { entidade: string; acao: string }

function ligarAoPacote(metodo: string, rota: string, padrao: OperacaoPadrao[]): Ligacao | undefined {
  const alvo = normalizarRota(rota);
  const p = padrao.find((o) => o.metodo.toUpperCase() === metodo && normalizarRota(o.rota) === alvo && o.entidade && o.acao);
  return p ? { entidade: p.entidade!, acao: p.acao! } : undefined;
}

// Nas ações sobre um registro, o último parâmetro da rota é o id do registro no destino.
function rotaComId(rota: string, acao: string): string {
  if (!['consultar', 'atualizar', 'remover'].includes(acao)) return rota;
  const [caminho, query] = rota.split('?');
  const partes = caminho.split('/');
  for (let i = partes.length - 1; i >= 0; i--) {
    if (/^\{\{.+\}\}$/.test(partes[i]) || partes[i].startsWith(':')) { partes[i] = '{{$id}}'; break; }
  }
  return partes.join('/') + (query ? `?${query}` : '');
}

function camposDoModelo(m: ModeloEntidade): Set<string> {
  const s = new Set<string>();
  const listas = new Set(m.campos.filter((c) => c.tipo === 'lista' && c.itens).map((c) => c.nome));
  for (const c of m.campos) {
    if (listas.has(c.nome)) for (const ci of c.itens!.campos) s.add(`${c.nome}[].${ci.nome}`);
    else s.add(c.nome);
  }
  // Perfis e casos podem acrescentar campos; a lista inteira (ex.: omitir "items") não conta como campo.
  for (const g of [...(m.perfis ?? []), ...(m.casos ?? [])]) {
    for (const k of Object.keys(g.campos ?? {})) if (!listas.has(k)) s.add(k);
  }
  return s;
}

export interface Divergencia { operacao: string; entidade: string; foraDoModelo: string[]; ausentesNoCorpo: string[] }

export function divergencias(destinoId: string): Divergencia[] {
  const d = obterDestino(destinoId);
  if (!d.pacoteId) return [];
  const modelos = modelosDoPacote(d.pacoteId);
  const saida: Divergencia[] = [];
  for (const o of listarOperacoes(destinoId)) {
    if (o.acao !== 'criar' || !o.entidade || !o.corpo) continue;
    const m = modelos.find((x) => x.nome === o.entidade);
    const corpo = corpoComoJson(o.corpo);
    if (!m || !corpo || typeof corpo !== 'object') continue;
    const doCorpo = new Set(caminhosFolha(corpo));
    const doModelo = camposDoModelo(m);
    const prefixoDe = (c: string) => [...doModelo].some((x) => x === c || x.startsWith(`${c}.`) || c.startsWith(`${x}.`));
    const foraDoModelo = [...doCorpo].filter((c) => !prefixoDe(c));
    const obrigatorios: string[] = [];
    for (const c of m.campos) {
      if (!c.obrigatorio) continue;
      if (c.tipo === 'lista') { if (![...doCorpo].some((x) => x.startsWith(`${c.nome}[]`))) obrigatorios.push(c.nome); }
      else if (![...doCorpo].some((x) => x === c.nome || x.startsWith(`${c.nome}.`))) obrigatorios.push(c.nome);
    }
    if (foraDoModelo.length || obrigatorios.length) {
      saida.push({ operacao: o.nome, entidade: o.entidade, foraDoModelo, ausentesNoCorpo: obrigatorios });
    }
  }
  return saida;
}

export interface PreviaImportacao {
  leitura: ResultadoLeitura;
  dominio: { ok: boolean; motivo?: string } | null;
  operacoes: { nome: string; pasta: string; metodo: string; rota: string; entidade?: string; acao?: string; situacao: 'nova' | 'alterada' | 'mantida' | 'token'; corpo?: string; cabecalhos: Record<string, string> }[];
  removidas: string[];
  semRequisicao: { entidade: string; acao: string; rota: string }[];
}

export function previaImportacao(colecao: unknown, ambiente: unknown, destinoId?: string, pacoteId?: string): PreviaImportacao {
  let leitura: ResultadoLeitura;
  try {
    leitura = lerPostman(colecao, ambiente);
  } catch (e) {
    throw new ErroHttp(422, (e as Error).message);
  }
  const destino = destinoId ? obterDestino(destinoId) : undefined;
  const pacId = destino?.pacoteId ?? pacoteId;
  const padrao = pacId ? obterPacote(pacId)?.operacoes ?? [] : [];
  const existentes = destino ? listarOperacoes(destino.id).filter((o) => o.origem === 'importada') : [];
  const ligadas = new Set<string>();
  const operacoes: PreviaImportacao['operacoes'] = leitura.operacoes.map((o) => {
    if (o.eToken) return { nome: o.nome, pasta: o.pasta, metodo: o.metodo, rota: o.rota, situacao: 'token' as const, corpo: o.corpo, cabecalhos: o.cabecalhos };
    let lig = ligarAoPacote(o.metodo, o.rota, padrao);
    if (lig && ligadas.has(`${lig.entidade}.${lig.acao}`)) lig = undefined;
    if (lig) ligadas.add(`${lig.entidade}.${lig.acao}`);
    const rota = lig ? rotaComId(o.rota, lig.acao) : o.rota;
    const igual = existentes.find((e) => e.metodo === o.metodo && normalizarRota(e.rota) === normalizarRota(rota) && e.nome === o.nome);
    const situacao = !igual ? 'nova' : igual.corpo !== (o.corpo ?? null) || JSON.stringify(igual.cabecalhos) !== JSON.stringify(o.cabecalhos) ? 'alterada' : 'mantida';
    return { nome: o.nome, pasta: o.pasta, metodo: o.metodo, rota, entidade: lig?.entidade, acao: lig?.acao, situacao, corpo: o.corpo, cabecalhos: o.cabecalhos };
  });
  const removidas = existentes.filter((e) => !operacoes.some((o) => o.nome === e.nome && o.metodo === e.metodo)).map((e) => e.nome);
  const semRequisicao = padrao
    .filter((p) => p.entidade && p.acao && !ligadas.has(`${p.entidade}.${p.acao}`))
    .map((p) => ({ entidade: p.entidade!, acao: p.acao!, rota: `${p.metodo} ${p.rota}` }));
  const base = leitura.baseUrl ?? destino?.baseUrl;
  const dominio = base ? conferirDominio(base, pacId ? obterPacote(pacId)?.dominiosProducao ?? [] : []) : null;
  return { leitura, dominio, operacoes, removidas, semRequisicao };
}

// Aplica a importação: cria o destino (ou atualiza) e troca as operações importadas. As manuais ficam.
export function aplicarImportacao(colecao: unknown, ambiente: unknown, opcoes: {
  destinoId?: string; nome?: string; tipoAmbiente?: TipoAmbiente; pacoteId?: string; baseUrl?: string; ambienteId?: string; papel?: Papel; ente?: string;
}) {
  const previa = previaImportacao(colecao, ambiente, opcoes.destinoId, opcoes.pacoteId);
  const l = previa.leitura;
  return transacao(() => {
    let destinoId = opcoes.destinoId;
    if (destinoId) {
      const d = obterDestino(destinoId);
      atualizarDestino(destinoId, {
        baseUrl: opcoes.baseUrl || l.baseUrl || d.baseUrl,
        autenticacao: l.autenticacao ?? d.autenticacao,
        variaveis: { ...d.variaveis, ...l.variaveis },
      });
    } else {
      const base = opcoes.baseUrl || l.baseUrl;
      if (!base) throw new ErroHttp(422, 'O environment não trouxe o endereço base. Informe o endereço da integração.');
      destinoId = criarDestino({
        nome: opcoes.nome || l.nomeColecao, tipoAmbiente: opcoes.tipoAmbiente ?? 'sandbox', baseUrl: base,
        pacoteId: opcoes.pacoteId ?? (opcoes.ambienteId ? undefined : null), autenticacao: l.autenticacao, variaveis: l.variaveis,
        ambienteId: opcoes.ambienteId, papel: opcoes.papel, ente: opcoes.ente,
      }).id;
      executar("DELETE FROM operacoes WHERE destino_id = ? AND origem = 'pacote'", destinoId);
    }
    executar("DELETE FROM operacoes WHERE destino_id = ? AND origem = 'importada'", destinoId);
    const manuais = listarOperacoes(destinoId).filter((o) => o.origem === 'manual');
    for (const [i, o] of previa.operacoes.entries()) {
      if (o.situacao === 'token') continue;
      const ocupada = o.entidade && manuais.some((m) => m.entidade === o.entidade && m.acao === o.acao);
      inserirOperacao(destinoId, {
        nome: o.nome, pasta: o.pasta, metodo: o.metodo, rota: o.rota, cabecalhos: o.cabecalhos, corpo: o.corpo,
        entidade: ocupada ? null : o.entidade ?? null, acao: ocupada ? null : o.acao ?? null, origem: 'importada', ordem: i,
      });
    }
    for (const [chave, valor] of Object.entries(l.segredos)) {
      const destinoChave = /client_?id/i.test(chave) ? 'client_id' : /client_?secret/i.test(chave) ? 'client_secret' : chave;
      salvarSegredo(destinoId, destinoChave, valor);
    }
    const ops = obterDestino(destinoId).papel === 'cliente' ? aplicarOperacoesDoPacote(destinoId) : 0;
    const resumo = {
      colecao: l.nomeColecao, operacoes: previa.operacoes.filter((o) => o.situacao !== 'token').length,
      ligadas: previa.operacoes.filter((o) => o.entidade).length, doPacote: ops, segredos: Object.keys(l.segredos).length,
      segredosVazios: l.segredosVazios, descartadas: l.descartadas.length, avisos: l.avisos,
    };
    executar('INSERT INTO importacoes (id, destino_id, tipo, resumo, criado_em) VALUES (?, ?, ?, ?, ?)', novoId('imp'), destinoId, 'postman', JSON.stringify(resumo), agora());
    return { destinoId, resumo, divergencias: divergencias(destinoId) };
  });
}

export function historicoImportacoes(destinoId: string) {
  return todos<{ id: string; tipo: string; resumo: string; criado_em: string }>(
    'SELECT * FROM importacoes WHERE destino_id = ? ORDER BY criado_em DESC LIMIT 20', destinoId,
  ).map((i) => ({ id: i.id, tipo: i.tipo, resumo: json(i.resumo, {}), criadoEm: i.criado_em }));
}

// ---------------------------------------------------------------- integração e biblioteca de APIs

// Liga a integração às versões da biblioteca de onde vieram a collection e o environment.
export function ligarVersoes(destinoId: string, colecaoVersaoId: string | null, environmentVersaoId?: string | null): void {
  const sets = ['colecao_versao_id = ?'];
  const params: (string | null)[] = [colecaoVersaoId];
  if (environmentVersaoId !== undefined) { sets.push('environment_versao_id = ?'); params.push(environmentVersaoId); }
  executar(`UPDATE destinos SET ${sets.join(', ')}, atualizado_em = ? WHERE id = ?`, ...params, agora(), destinoId);
}

function conteudosDaBiblioteca(colecaoVersaoId: string, environmentVersaoId?: string | null) {
  const col = obterVersao(colecaoVersaoId);
  if (col.tipo !== 'collection') throw new ErroHttp(422, `${col.nome} não é uma collection.`);
  return { colecao: col.conteudo, ambiente: environmentVersaoId ? environmentComSegredos(environmentVersaoId) : undefined };
}

// Cria uma integração num ambiente a partir de uma collection e de um environment da biblioteca.
export function integracaoDaBiblioteca(ambienteId: string, dados: {
  nome?: string; papel?: Papel; ente?: string; colecaoVersaoId?: string; environmentVersaoId?: string | null; baseUrl?: string; pacoteId?: string | null;
}) {
  const amb = obterAmbiente(ambienteId);
  if (!dados.colecaoVersaoId) throw new ErroHttp(422, 'Escolha a collection da biblioteca.');
  const { colecao, ambiente } = conteudosDaBiblioteca(dados.colecaoVersaoId, dados.environmentVersaoId);
  const r = aplicarImportacao(colecao, ambiente, {
    nome: dados.nome, ambienteId: amb.id, tipoAmbiente: amb.tipo, papel: dados.papel ?? 'cliente', ente: dados.ente, baseUrl: dados.baseUrl,
    pacoteId: dados.pacoteId === undefined ? amb.pacoteId ?? undefined : dados.pacoteId ?? undefined,
  });
  ligarVersoes(r.destinoId, dados.colecaoVersaoId, dados.environmentVersaoId ?? null);
  return r;
}

// Passa a integração para outra versão da collection e/ou do environment. As operações editadas à mão ficam.
export function trocarVersoes(destinoId: string, dados: { colecaoVersaoId?: string; environmentVersaoId?: string | null }) {
  const d = obterDestino(destinoId);
  const colId = dados.colecaoVersaoId ?? d.colecaoVersaoId;
  if (!colId) throw new ErroHttp(422, 'Esta integração não veio da biblioteca: importe uma collection nela antes de trocar a versão.');
  const envId = dados.environmentVersaoId === undefined ? d.environmentVersaoId : dados.environmentVersaoId;
  const { colecao, ambiente } = conteudosDaBiblioteca(colId, envId);
  const r = aplicarImportacao(colecao, ambiente, { destinoId });
  ligarVersoes(destinoId, colId, envId ?? null);
  return r;
}

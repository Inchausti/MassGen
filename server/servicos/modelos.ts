// Modelos de entidade: editados no app, validados e testados com um exemplo antes de salvar.
import { agora, executar, json, novoId, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import type { ModeloEntidade } from '../core/tipos.ts';
import { validarModelo } from '../core/validar.ts';
import { exemploDeModelo } from '../core/gerar.ts';
import { modelosDoPacote, obterPacote } from './pacotes.ts';
import { obterDestino } from './destinos.ts';

interface Linha { id: string; pacote_id: string; nome: string; definicao: string; alterado_localmente: number; atualizado_em: string }

function resumo(l: Linha) {
  const m = json<ModeloEntidade>(l.definicao, { nome: l.nome, rotulo: l.nome, campos: [] });
  return {
    id: l.id, pacoteId: l.pacote_id, nome: m.nome, rotulo: m.rotulo, descricao: m.descricao, campos: m.campos.length,
    relacoes: (m.relacoes ?? []).map((r) => `${r.nome} → ${r.entidade}`), perfis: m.perfis?.length ?? 0, casos: m.casos?.length ?? 0,
    regras: m.regras?.length ?? 0, alterado: !!l.alterado_localmente, atualizadoEm: l.atualizado_em,
  };
}

export function listarModelos(pacoteId?: string) {
  const linhas = pacoteId
    ? todos<Linha>('SELECT * FROM modelos WHERE pacote_id = ? ORDER BY rowid', pacoteId)
    : todos<Linha>('SELECT * FROM modelos ORDER BY pacote_id, rowid');
  return linhas.map(resumo);
}

export function obterModelo(id: string) {
  const l = um<Linha>('SELECT * FROM modelos WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Modelo não encontrado.');
  const original = obterPacote(l.pacote_id)?.modelos.find((m) => m.nome === l.nome);
  return { ...resumo(l), definicao: JSON.parse(l.definicao) as ModeloEntidade, temOriginal: !!original };
}

export function salvarModelo(id: string, definicao: ModeloEntidade) {
  const l = um<Linha>('SELECT * FROM modelos WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Modelo não encontrado.');
  if (definicao?.nome !== l.nome) throw new ErroHttp(422, `O nome do modelo não muda: mantenha "${l.nome}". Para outro nome, crie um modelo novo.`);
  const outros = modelosDoPacote(l.pacote_id).map((m) => (m.nome === l.nome ? definicao : m));
  const erros = validarModelo(definicao, outros);
  if (erros.length) throw new ErroHttp(422, 'O modelo tem erros.', erros);
  executar('UPDATE modelos SET definicao = ?, alterado_localmente = 1, atualizado_em = ? WHERE id = ?', JSON.stringify(definicao), agora(), id);
  return obterModelo(id);
}

export function criarModelo(pacoteId: string, definicao: ModeloEntidade) {
  if (!obterPacote(pacoteId)) throw new ErroHttp(404, 'Pacote não encontrado.');
  const outros = [...modelosDoPacote(pacoteId), definicao];
  const erros = validarModelo(definicao, outros);
  if (erros.length) throw new ErroHttp(422, 'O modelo tem erros.', erros);
  if (um('SELECT 1 FROM modelos WHERE pacote_id = ? AND nome = ?', pacoteId, definicao.nome)) throw new ErroHttp(409, `Já existe o modelo ${definicao.nome} neste pacote.`);
  const id = novoId('mod');
  executar('INSERT INTO modelos (id, pacote_id, nome, definicao, alterado_localmente, atualizado_em) VALUES (?, ?, ?, ?, 1, ?)', id, pacoteId, definicao.nome, JSON.stringify(definicao), agora());
  return obterModelo(id);
}

export function removerModelo(id: string): void {
  const l = um<Linha>('SELECT * FROM modelos WHERE id = ?', id);
  if (!l) return;
  const usados = todos<{ nome: string; definicao: string }>('SELECT nome, definicao FROM cenarios WHERE pacote_id = ?', l.pacote_id)
    .filter((c) => json<{ entidades: { entidade: string }[] }>(c.definicao, { entidades: [] }).entidades.some((e) => e.entidade === l.nome));
  if (usados.length) throw new ErroHttp(409, `O modelo é usado nos cenários: ${usados.map((c) => c.nome).join(', ')}.`);
  const dependentes = modelosDoPacote(l.pacote_id).filter((m) => m.relacoes?.some((r) => r.entidade === l.nome));
  if (dependentes.length) throw new ErroHttp(409, `Outros modelos dependem deste: ${dependentes.map((m) => m.nome).join(', ')}.`);
  executar('DELETE FROM modelos WHERE id = ?', id);
}

export function restaurarModelo(id: string) {
  const l = um<Linha>('SELECT * FROM modelos WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Modelo não encontrado.');
  const original = obterPacote(l.pacote_id)?.modelos.find((m) => m.nome === l.nome);
  if (!original) throw new ErroHttp(404, 'Este modelo não veio do pacote: não há versão original.');
  executar('UPDATE modelos SET definicao = ?, alterado_localmente = 0, atualizado_em = ? WHERE id = ?', JSON.stringify(original), agora(), id);
  return obterModelo(id);
}

// Gera 3 registros de exemplo do modelo (salvo ou em edição), com os pais necessários.
export async function exemplo(id: string, opcoes: { definicao?: ModeloEntidade; destinoId?: string; semente?: number }) {
  const l = um<Linha>('SELECT * FROM modelos WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Modelo não encontrado.');
  const def = opcoes.definicao ?? (JSON.parse(l.definicao) as ModeloEntidade);
  const modelos = modelosDoPacote(l.pacote_id).map((m) => (m.nome === def.nome ? def : m));
  const erros = validarModelo(def, modelos);
  if (erros.length) throw new ErroHttp(422, 'O modelo tem erros.', erros);
  let variaveis: Record<string, unknown> = {};
  if (opcoes.destinoId) variaveis = obterDestino(opcoes.destinoId).variaveis;
  else {
    const padrao = obterPacote(l.pacote_id)?.destinoPadrao?.variaveis ?? {};
    variaveis = Object.fromEntries(Object.keys(padrao).map((k) => [k, `«${k}»`]));
  }
  try {
    const regs = await exemploDeModelo(def, modelos, variaveis, opcoes.semente ?? 1);
    return regs.map((r) => ({ rotulo: r.rotulo, perfil: r.perfil, dados: r.dados, avisos: r.avisos, esperado: r.esperado }));
  } catch (e) {
    throw new ErroHttp(422, (e as Error).message);
  }
}

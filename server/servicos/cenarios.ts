// Cenários: o que gerar, quanto, com quais perfis, cadastros e casos de borda.
import { agora, executar, json, novoId, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import type { DefinicaoCenario } from '../core/tipos.ts';
import { validarCenario } from '../core/validar.ts';
import { modelosDoPacote, obterPacote } from './pacotes.ts';
import { obterDestino } from './destinos.ts';

export interface Cenario {
  id: string;
  nome: string;
  pacoteId: string | null;
  destinoId: string | null;
  definicao: DefinicaoCenario;
  criadoEm: string;
  atualizadoEm: string;
}

function linha(l: Record<string, unknown>): Cenario {
  return {
    id: l.id as string, nome: l.nome as string, pacoteId: (l.pacote_id as string) ?? null, destinoId: (l.destino_id as string) ?? null,
    definicao: json(l.definicao, { entidades: [] }), criadoEm: l.criado_em as string, atualizadoEm: l.atualizado_em as string,
  };
}

export function listarCenarios() {
  return todos('SELECT * FROM cenarios ORDER BY atualizado_em DESC').map((l) => {
    const c = linha(l);
    const ult = um<{ id: string; codigo: string; status: string; criado_em: string }>(
      'SELECT id, codigo, status, criado_em FROM execucoes WHERE cenario_id = ? ORDER BY criado_em DESC LIMIT 1', c.id);
    return { ...c, ultimaExecucao: ult ?? null };
  });
}

export function obterCenario(id: string): Cenario {
  const l = um('SELECT * FROM cenarios WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Cenário não encontrado.');
  return linha(l);
}

function validar(dados: Partial<Cenario>): void {
  if (!dados.nome?.trim()) throw new ErroHttp(422, 'Informe o nome do cenário.');
  if (!dados.pacoteId || !obterPacote(dados.pacoteId)) throw new ErroHttp(422, 'Escolha o pacote do cenário.');
  if (dados.destinoId) {
    const d = obterDestino(dados.destinoId);
    if (d.pacoteId !== dados.pacoteId) throw new ErroHttp(422, 'O destino escolhido usa outro pacote.');
  }
  const erros = validarCenario(dados.definicao!, modelosDoPacote(dados.pacoteId));
  if (erros.length) throw new ErroHttp(422, 'O cenário tem erros.', erros);
}

export function criarCenario(dados: Partial<Cenario>): Cenario {
  validar(dados);
  const id = novoId('cen');
  const t = agora();
  executar('INSERT INTO cenarios (id, nome, pacote_id, destino_id, definicao, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, dados.nome!.trim(), dados.pacoteId!, dados.destinoId ?? null, JSON.stringify(dados.definicao), t, t);
  return obterCenario(id);
}

export function atualizarCenario(id: string, dados: Partial<Cenario>): Cenario {
  const novo = { ...obterCenario(id), ...dados };
  validar(novo);
  executar('UPDATE cenarios SET nome = ?, pacote_id = ?, destino_id = ?, definicao = ?, atualizado_em = ? WHERE id = ?',
    novo.nome.trim(), novo.pacoteId, novo.destinoId ?? null, JSON.stringify(novo.definicao), agora(), id);
  return obterCenario(id);
}

export function removerCenario(id: string): void {
  executar('DELETE FROM cenarios WHERE id = ?', id);
}

// Cria um cenário a partir de um cenário pronto do pacote.
export function cenarioDoPacote(pacoteId: string, cenarioId: string, destinoId?: string): Cenario {
  const p = obterPacote(pacoteId);
  const pronto = p?.cenarios?.find((c) => c.id === cenarioId);
  if (!pronto) throw new ErroHttp(404, 'Cenário pronto não encontrado no pacote.');
  return criarCenario({ nome: pronto.nome, pacoteId, destinoId: destinoId ?? null, definicao: structuredClone(pronto.definicao) });
}

export function contarCenario(definicao: DefinicaoCenario): { entidade: string; estimado: string }[] {
  return definicao.entidades.map((e) => ({
    entidade: e.entidade,
    estimado: e.porPai ? `${e.porPai.min}${e.porPai.max !== e.porPai.min ? ` a ${e.porPai.max}` : ''} por ${e.porPai.relacao}` : String(e.quantidade ?? 0),
  }));
}

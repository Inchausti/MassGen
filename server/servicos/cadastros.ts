// Cadastros mestres: registros salvos de qualquer entidade, reaproveitados nos cenários e vinculados a cada destino.
import { agora, executar, json, novoId, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import type { CadastroUsado } from '../core/tipos.ts';
import { modelosDoPacote } from './pacotes.ts';
import { renderizar } from '../core/expr.ts';

export interface Cadastro {
  id: string;
  pacoteId: string | null;
  entidade: string;
  rotulo: string;
  dados: Record<string, unknown>;
  etiquetas: string[];
  versao: number;
  criadoEm: string;
  atualizadoEm: string;
  vinculos: { destinoId: string; destino?: string; idRemoto: string; atualizadoEm: string }[];
}

function linha(l: Record<string, unknown>): Cadastro {
  const vinculos = todos<{ destino_id: string; nome: string | null; id_remoto: string; atualizado_em: string }>(
    `SELECT v.destino_id, d.nome, v.id_remoto, v.atualizado_em FROM cadastro_vinculos v LEFT JOIN destinos d ON d.id = v.destino_id WHERE v.cadastro_id = ?`,
    l.id as string,
  ).map((v) => ({ destinoId: v.destino_id, destino: v.nome ?? undefined, idRemoto: v.id_remoto, atualizadoEm: v.atualizado_em }));
  return {
    id: l.id as string, pacoteId: (l.pacote_id as string) ?? null, entidade: l.entidade as string, rotulo: l.rotulo as string,
    dados: json(l.dados, {}), etiquetas: json(l.etiquetas, []), versao: l.versao as number,
    criadoEm: l.criado_em as string, atualizadoEm: l.atualizado_em as string, vinculos,
  };
}

export function listarCadastros(filtro: { entidade?: string; busca?: string; etiqueta?: string; pacoteId?: string }) {
  const where: string[] = [];
  const params: string[] = [];
  if (filtro.entidade) { where.push('entidade = ?'); params.push(filtro.entidade); }
  if (filtro.pacoteId) { where.push('pacote_id = ?'); params.push(filtro.pacoteId); }
  if (filtro.busca) { where.push('(rotulo LIKE ? OR dados LIKE ?)'); params.push(`%${filtro.busca}%`, `%${filtro.busca}%`); }
  if (filtro.etiqueta) { where.push('etiquetas LIKE ?'); params.push(`%"${filtro.etiqueta}"%`); }
  return todos(`SELECT * FROM cadastros ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY atualizado_em DESC LIMIT 500`, ...params).map(linha);
}

export function obterCadastro(id: string): Cadastro {
  const l = um('SELECT * FROM cadastros WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Cadastro não encontrado.');
  return linha(l);
}

async function rotuloPara(pacoteId: string | null, entidade: string, dados: Record<string, unknown>, rotulo?: string): Promise<string> {
  if (rotulo?.trim()) return rotulo.trim();
  const m = pacoteId ? modelosDoPacote(pacoteId).find((x) => x.nome === entidade) : undefined;
  if (m?.rotuloRegistro) {
    try { const r = String(await renderizar(m.rotuloRegistro, dados)); if (r.trim()) return r.trim(); } catch { /* usa o padrão */ }
  }
  return `${m?.rotulo ?? entidade} salvo`;
}

export async function criarCadastro(d: Partial<Cadastro>): Promise<Cadastro> {
  if (!d.entidade) throw new ErroHttp(422, 'Informe a entidade do cadastro.');
  if (!d.dados || typeof d.dados !== 'object') throw new ErroHttp(422, 'Os dados do cadastro precisam ser um objeto.');
  const id = novoId('cad');
  const t = agora();
  executar('INSERT INTO cadastros (id, pacote_id, entidade, rotulo, dados, etiquetas, versao, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    id, d.pacoteId ?? null, d.entidade, await rotuloPara(d.pacoteId ?? null, d.entidade, d.dados, d.rotulo), JSON.stringify(d.dados),
    JSON.stringify(d.etiquetas ?? []), t, t);
  return obterCadastro(id);
}

export async function atualizarCadastro(id: string, d: Partial<Cadastro>): Promise<Cadastro> {
  const atual = obterCadastro(id);
  const dados = d.dados ?? atual.dados;
  const mudouDados = JSON.stringify(dados) !== JSON.stringify(atual.dados);
  executar('UPDATE cadastros SET rotulo = ?, dados = ?, etiquetas = ?, versao = ?, atualizado_em = ? WHERE id = ?',
    await rotuloPara(atual.pacoteId, atual.entidade, dados, d.rotulo ?? atual.rotulo), JSON.stringify(dados),
    JSON.stringify(d.etiquetas ?? atual.etiquetas), atual.versao + (mudouDados ? 1 : 0), agora(), id);
  return obterCadastro(id);
}

export function removerCadastro(id: string): void {
  executar('DELETE FROM cadastros WHERE id = ?', id);
}

export function vincular(cadastroId: string, destinoId: string, idRemoto: string, execucaoId?: string): void {
  executar(
    `INSERT INTO cadastro_vinculos (cadastro_id, destino_id, id_remoto, execucao_id, atualizado_em) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (cadastro_id, destino_id) DO UPDATE SET id_remoto = excluded.id_remoto, execucao_id = excluded.execucao_id, atualizado_em = excluded.atualizado_em`,
    cadastroId, destinoId, idRemoto, execucaoId ?? null, agora(),
  );
}

export function desvincular(cadastroId: string, destinoId: string): void {
  executar('DELETE FROM cadastro_vinculos WHERE cadastro_id = ? AND destino_id = ?', cadastroId, destinoId);
}

// Os cadastros usados num cenário, com o id que já têm no destino da execução.
export function cadastrosParaGeracao(ids: string[], destinoId: string | null): Record<string, CadastroUsado> {
  const saida: Record<string, CadastroUsado> = {};
  for (const id of ids) {
    const l = um('SELECT * FROM cadastros WHERE id = ?', id);
    if (!l) continue;
    const c = linha(l);
    saida[id] = { id: c.id, entidade: c.entidade, rotulo: c.rotulo, dados: c.dados, idRemoto: c.vinculos.find((v) => v.destinoId === destinoId)?.idRemoto };
  }
  return saida;
}

export function etiquetasEmUso(): string[] {
  const s = new Set<string>();
  for (const l of todos<{ etiquetas: string }>('SELECT etiquetas FROM cadastros')) for (const e of json<string[]>(l.etiquetas, [])) s.add(e);
  return [...s].sort();
}

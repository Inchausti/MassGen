// Execuções: geram a massa de um cenário, guardam cada registro com o gabarito e servem a pré-visualização.
import { randomBytes } from 'node:crypto';
import { agora, executar, json, todos, transacao, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { gerarMassa } from '../core/gerar.ts';
import { avaliar } from '../core/expr.ts';
import { achatar, obter } from '../core/caminhos.ts';
import type { Conferencia, DefinicaoCenario, Esperado, ModeloEntidade } from '../core/tipos.ts';
import { obterCenario } from './cenarios.ts';
import { obterDestino } from './destinos.ts';
import { modelosDoPacote } from './pacotes.ts';
import { cadastrosParaGeracao, criarCadastro, fecharCadastros, ligacoesDo, vincular } from './cadastros.ts';
import { obterPacote } from './pacotes.ts';
import { sha256, usuarioAtual } from '../auditoria.ts';

export interface Registro {
  id: string;
  execucaoId: string;
  entidade: string;
  indice: number;
  ordem: number;
  rotulo: string;
  perfil: string | null;
  caso: string | null;
  cadastroId: string | null;
  pais: Record<string, string>;
  dados: Record<string, unknown>;
  esperado: Esperado;
  conferencia: Conferencia | null;
  avisos: string[];
  status: string;
  idRemoto: string | null;
  obtido: { status?: number; codigo?: string; conferencia?: { status?: number } } | null;
  resultado: 'ok' | 'divergente' | 'bloqueado' | 'erro' | null;
  diferencas: string[];
}

export function linhaRegistro(l: Record<string, unknown>): Registro {
  return {
    id: l.id as string, execucaoId: l.execucao_id as string, entidade: l.entidade as string, indice: l.indice as number,
    ordem: l.ordem as number, rotulo: (l.rotulo as string) ?? '', perfil: (l.perfil as string) ?? null, caso: (l.caso as string) ?? null,
    cadastroId: (l.cadastro_id as string) ?? null, pais: json(l.pais, {}), dados: json(l.dados, {}), esperado: json(l.esperado, {}),
    conferencia: json(l.conferencia, null), avisos: json(l.avisos, []), status: l.status as string, idRemoto: (l.id_remoto as string) ?? null,
    obtido: json(l.obtido, null), resultado: (l.resultado as Registro['resultado']) ?? null, diferencas: json(l.diferencas, []),
  };
}

function novoCodigo(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const c = Array.from(randomBytes(5), (b) => alfabeto[b % alfabeto.length]).join('');
    if (!um('SELECT 1 FROM execucoes WHERE codigo = ?', c)) return c;
  }
}

export function hojeEmBrasilia(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function gerarExecucao(cenarioId: string, opcoes: { semente?: number; dataReferencia?: string; destinoId?: string } = {}) {
  const cen = obterCenario(cenarioId);
  const destinoId = opcoes.destinoId ?? cen.destinoId;
  if (!destinoId) throw new ErroHttp(422, 'Escolha o destino do cenário antes de gerar: as variáveis do destino entram na massa.');
  const destino = obterDestino(destinoId);
  if (destino.papel === 'emulador') {
    throw new ErroHttp(422, `A integração ${destino.nome} é de ente emulado: ela não recebe a massa do cenário. Os eventos dela vêm da emulação do ente, a partir do contexto do ambiente.`);
  }
  if (!cen.pacoteId) throw new ErroHttp(422, 'O cenário não tem pacote.');
  const modelos = modelosDoPacote(cen.pacoteId);
  const definicao: DefinicaoCenario = cen.definicao;
  const semente = Number.isFinite(opcoes.semente) ? Number(opcoes.semente) : definicao.semente ?? (randomBytes(4).readUInt32BE(0) % 1_000_000_000);
  const dataReferencia = opcoes.dataReferencia || definicao.dataReferencia || hojeEmBrasilia();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia)) throw new ErroHttp(422, 'Data de referência: use AAAA-MM-DD.');
  const codigo = novoCodigo();
  // Os cadastros pai que os escolhidos exigem (o fornecedor do contrato) entram junto, antes deles.
  const { definicao: completa } = fecharCadastros(definicao);
  const ids = completa.entidades.flatMap((e) => e.cadastros ?? []);
  let resultado;
  try {
    resultado = await gerarMassa({
      modelos, cenario: completa, semente, dataReferencia, codigoExecucao: codigo, variaveis: destino.variaveis,
      cadastros: cadastrosParaGeracao(ids, destinoId),
    });
  } catch (e) {
    throw new ErroHttp(422, `Não foi possível gerar a massa: ${(e as Error).message}`);
  }
  const id = `exe_${codigo.toLowerCase()}`;
  const t = agora();
  transacao(() => {
    // Retrato do que gerou a massa: pacote e versão, hash dos modelos e o destino como estava.
    const pacote = obterPacote(cen.pacoteId!);
    const retrato = {
      nome: destino.nome, tipoAmbiente: destino.tipoAmbiente, baseUrl: destino.baseUrl, autenticacao: destino.autenticacao.tipo,
      limites: destino.limites, idempotencia: destino.idempotencia, rastreio: destino.rastreio, variaveis: destino.variaveis,
    };
    executar(
      `INSERT INTO execucoes (id, codigo, cenario_id, cenario_nome, cenario, destino_id, semente, data_referencia, status, etapa, erro, criado_em,
         criado_por, pacote_id, pacote_versao, modelos_hash, destino_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gerada', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      id, codigo, cen.id, cen.nome, JSON.stringify(completa), destinoId, semente, dataReferencia,
      resultado.avisos.length ? JSON.stringify(resultado.avisos) : null, t,
      usuarioAtual().usuario, cen.pacoteId, pacote?.versao ?? null, sha256(JSON.stringify(modelos)), JSON.stringify(retrato),
    );
    const ins = `INSERT INTO registros (id, execucao_id, entidade, indice, ordem, rotulo, perfil, caso, cadastro_id, pais, dados, esperado, conferencia, avisos, status, id_remoto, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    for (const r of resultado.registros) {
      executar(ins, r.id, id, r.entidade, r.indice, r.ordem, r.rotulo, r.perfil ?? null, r.caso ?? null, r.cadastroId ?? null,
        JSON.stringify(r.pais), JSON.stringify(r.dados), JSON.stringify(r.esperado), r.conferencia ? JSON.stringify(r.conferencia) : null,
        JSON.stringify(r.avisos), r.idRemoto ? 'reaproveitado' : 'gerado', r.idRemoto ?? null, t);
    }
  });
  return resumoExecucao(id);
}

export function obterExecucaoLinha(id: string) {
  const l = um<Record<string, unknown>>('SELECT * FROM execucoes WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Execução não encontrada.');
  return l;
}

export function resumoExecucao(id: string) {
  const l = obterExecucaoLinha(id);
  const porEntidade = todos<{ entidade: string; ordem: number; status: string; resultado: string | null; n: number }>(
    'SELECT entidade, ordem, status, resultado, COUNT(*) AS n FROM registros WHERE execucao_id = ? GROUP BY entidade, ordem, status, resultado ORDER BY ordem', id);
  const entidades: Record<string, { entidade: string; total: number; status: Record<string, number>; resultado: Record<string, number> }> = {};
  for (const r of porEntidade) {
    const e = (entidades[r.entidade] ??= { entidade: r.entidade, total: 0, status: {}, resultado: {} });
    e.total += r.n;
    e.status[r.status] = (e.status[r.status] ?? 0) + r.n;
    if (r.resultado) e.resultado[r.resultado] = (e.resultado[r.resultado] ?? 0) + r.n;
  }
  const total = Object.values(entidades).reduce((s, e) => s + e.total, 0);
  const pendentes = Object.values(entidades).reduce((s, e) => s + (e.status.gerado ?? 0) + (e.status.enviando ?? 0), 0);
  const res = (k: string) => Object.values(entidades).reduce((s, e) => s + (e.resultado[k] ?? 0), 0);
  const destino = l.destino_id ? um<{ nome: string }>('SELECT nome FROM destinos WHERE id = ?', l.destino_id as string) : undefined;
  const comAviso = um<{ n: number }>("SELECT COUNT(*) AS n FROM registros WHERE execucao_id = ? AND avisos != '[]'", id)?.n ?? 0;
  return {
    id: l.id, codigo: l.codigo, cenarioId: l.cenario_id, cenarioNome: l.cenario_nome, cenario: json(l.cenario, {}), destinoId: l.destino_id,
    destinoNome: destino?.nome ?? null, semente: l.semente, dataReferencia: l.data_referencia, status: l.status, etapa: l.etapa,
    erro: l.erro, criadoEm: l.criado_em, iniciadoEm: l.iniciado_em, finalizadoEm: l.finalizado_em,
    criadoPor: l.criado_por, enviadoPor: l.enviado_por, pacoteId: l.pacote_id, pacoteVersao: l.pacote_versao, modelosHash: l.modelos_hash,
    destinoRetrato: json(l.destino_snapshot, null),
    total, pendentes, comAviso, ok: res('ok'), divergentes: res('divergente'), bloqueados: res('bloqueado'), erros: res('erro'),
    entidades: Object.values(entidades),
  };
}

export function listarExecucoes(limite = 100) {
  return todos<{ id: string }>('SELECT id FROM execucoes ORDER BY criado_em DESC LIMIT ?', limite).map((x) => resumoExecucao(x.id));
}

export function listarRegistros(execucaoId: string, f: { entidade?: string; status?: string; resultado?: string; busca?: string; pagina?: number; tamanho?: number }) {
  const where = ['execucao_id = ?'];
  const p: (string | number)[] = [execucaoId];
  if (f.entidade) { where.push('entidade = ?'); p.push(f.entidade); }
  if (f.status) { where.push('status = ?'); p.push(f.status); }
  if (f.resultado === 'pendente') where.push('resultado IS NULL');
  else if (f.resultado === 'aviso') where.push("avisos != '[]'");
  else if (f.resultado === 'caso') where.push('caso IS NOT NULL');
  else if (f.resultado) { where.push('resultado = ?'); p.push(f.resultado); }
  if (f.busca) { where.push('(rotulo LIKE ? OR dados LIKE ? OR id_remoto LIKE ?)'); p.push(`%${f.busca}%`, `%${f.busca}%`, `%${f.busca}%`); }
  const tamanho = Math.min(500, Math.max(1, f.tamanho ?? 50));
  const pagina = Math.max(1, f.pagina ?? 1);
  const total = um<{ n: number }>(`SELECT COUNT(*) AS n FROM registros WHERE ${where.join(' AND ')}`, ...p)!.n;
  const itens = todos(`SELECT * FROM registros WHERE ${where.join(' AND ')} ORDER BY ordem, indice LIMIT ? OFFSET ?`, ...p, tamanho, (pagina - 1) * tamanho).map(linhaRegistro);
  return { total, pagina, tamanho, itens };
}

export function obterRegistro(id: string): Registro {
  const l = um('SELECT * FROM registros WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Registro não encontrado.');
  return linhaRegistro(l);
}

function modelosDaExecucao(execucaoId: string): ModeloEntidade[] {
  const l = obterExecucaoLinha(execucaoId);
  const cen = l.cenario_id ? um<{ pacote_id: string }>('SELECT pacote_id FROM cenarios WHERE id = ?', l.cenario_id as string) : undefined;
  const dest = l.destino_id ? um<{ pacote_id: string }>('SELECT pacote_id FROM destinos WHERE id = ?', l.destino_id as string) : undefined;
  const pacoteId = cen?.pacote_id ?? dest?.pacote_id;
  return pacoteId ? modelosDoPacote(pacoteId) : [];
}

// Editar um registro antes do envio: as regras do modelo rodam de novo sobre os dados novos.
export async function editarRegistro(id: string, dados: Record<string, unknown>): Promise<Registro> {
  const r = obterRegistro(id);
  if (!['gerado'].includes(r.status)) throw new ErroHttp(409, 'Só dá para editar registro que ainda não foi enviado.');
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw new ErroHttp(422, 'Os dados precisam ser um objeto JSON.');
  const modelo = modelosDaExecucao(r.execucaoId).find((m) => m.nome === r.entidade);
  const avisos: string[] = [];
  if (modelo) {
    const entrada: Record<string, unknown> = structuredClone(dados);
    for (const [rel, paiId] of Object.entries(r.pais)) {
      const pai = um<{ dados: string }>('SELECT dados FROM registros WHERE id = ?', paiId);
      if (pai && !(rel in entrada)) Object.defineProperty(entrada, rel, { value: json(pai.dados, {}), enumerable: false });
    }
    const caso = modelo.casos?.find((c) => c.id === r.caso);
    for (const regra of modelo.regras ?? []) {
      if (caso?.quebra === regra.nome) continue;
      try { if (!(await avaliar(regra.expr, entrada, {}))) avisos.push(`Regra ${regra.nome}: ${regra.mensagem}`); }
      catch (e) { avisos.push(`Regra ${regra.nome}: ${(e as Error).message}`); }
    }
    for (const c of modelo.campos) if (c.obrigatorio && obter(dados, c.nome) === undefined && !r.caso) avisos.push(`Campo obrigatório vazio: ${c.nome}`);
  }
  executar('UPDATE registros SET dados = ?, avisos = ?, atualizado_em = ? WHERE id = ?', JSON.stringify(dados), JSON.stringify(avisos), agora(), id);
  return obterRegistro(id);
}

// Salva um registro da massa como cadastro. Se a integração exige um pai que ainda não é cadastro (o fornecedor de um
// contrato gerado), o pai é salvo antes, do mesmo jeito.
export async function salvarComoCadastro(registroId: string, etiquetas: string[] = []): Promise<Awaited<ReturnType<typeof criarCadastro>> & { paisSalvos: { id: string; rotulo: string; entidade: string }[] }> {
  const r = obterRegistro(registroId);
  const exe = obterExecucaoLinha(r.execucaoId);
  const cen = exe.cenario_id ? um<{ pacote_id: string }>('SELECT pacote_id FROM cenarios WHERE id = ?', exe.cenario_id as string) : undefined;
  const pacoteId = (cen?.pacote_id ?? exe.pacote_id ?? null) as string | null;
  const paisSalvos: { id: string; rotulo: string; entidade: string }[] = [];
  for (const lig of ligacoesDo(pacoteId, r.entidade, r.dados)) {
    const regPai = r.pais?.[lig.relacao];
    if (!lig.problema || !regPai) continue;
    const pai = obterRegistro(regPai);
    if (pai.cadastroId) continue;
    const salvo = await salvarComoCadastro(regPai, etiquetas);
    paisSalvos.push(...salvo.paisSalvos, { id: salvo.id, rotulo: salvo.rotulo, entidade: salvo.entidade });
  }
  const cad = await criarCadastro({ pacoteId, entidade: r.entidade, rotulo: r.rotulo, dados: r.dados, etiquetas });
  if (r.idRemoto && exe.destino_id && r.resultado === 'ok') vincular(cad.id, exe.destino_id as string, r.idRemoto, r.execucaoId);
  return { ...cad, paisSalvos };
}

export function removerExecucao(id: string): void {
  const l = obterExecucaoLinha(id);
  if (['enviando', 'conferindo'].includes(l.status as string)) throw new ErroHttp(409, 'Pause ou cancele o envio antes de apagar a execução.');
  executar('DELETE FROM execucoes WHERE id = ?', id);
}

function csv(linhas: Record<string, unknown>[]): string {
  const colunas = [...new Set(linhas.flatMap((l) => Object.keys(l)))];
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [colunas.join(';'), ...linhas.map((l) => colunas.map((c) => esc(l[c])).join(';'))].join('\r\n') + '\r\n';
}

export function exportarExecucao(id: string, formato: 'json' | 'csv', entidade?: string) {
  const l = obterExecucaoLinha(id);
  const where = entidade ? 'execucao_id = ? AND entidade = ?' : 'execucao_id = ?';
  const regs = todos(`SELECT * FROM registros WHERE ${where} ORDER BY ordem, indice`, ...(entidade ? [id, entidade] : [id])).map(linhaRegistro);
  if (formato === 'csv') {
    if (!entidade) throw new ErroHttp(422, 'Para CSV, escolha uma entidade: cada entidade tem as suas colunas.');
    return { nome: `massgen-${l.codigo}-${entidade}.csv`, tipo: 'text/csv; charset=utf-8', corpo: csv(regs.map((r) => achatar(r.dados))) };
  }
  const corpo = JSON.stringify({
    execucao: l.codigo, cenario: l.cenario_nome, semente: l.semente, dataReferencia: l.data_referencia,
    registros: regs.map((r) => ({ entidade: r.entidade, rotulo: r.rotulo, perfil: r.perfil, caso: r.caso, dados: r.dados, esperado: r.esperado, idRemoto: r.idRemoto, resultado: r.resultado })),
  }, null, 2);
  return { nome: `massgen-${l.codigo}${entidade ? `-${entidade}` : ''}.json`, tipo: 'application/json; charset=utf-8', corpo };
}

export function marcarInterrompidas(): void {
  executar("UPDATE execucoes SET status = 'interrompida', etapa = NULL WHERE status IN ('enviando', 'conferindo')");
  executar("UPDATE registros SET status = 'gerado' WHERE status = 'enviando'");
}

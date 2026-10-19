// Monitor de requisições: cada chamada, com o que foi enviado, o que voltou e o gabarito do registro.
import { json, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';

export interface FiltroRequisicoes {
  execucaoId?: string;
  destinoId?: string;
  registroId?: string;
  fase?: string;
  faixa?: string;
  entidade?: string;
  codigo?: string;
  busca?: string;
  depoisDe?: number;
  antesDe?: number;
  limite?: number;
}

export function listarRequisicoes(f: FiltroRequisicoes) {
  const where: string[] = [];
  const p: (string | number)[] = [];
  if (f.execucaoId) { where.push('q.execucao_id = ?'); p.push(f.execucaoId); }
  if (f.destinoId) { where.push('q.destino_id = ?'); p.push(f.destinoId); }
  if (f.registroId) { where.push('q.registro_id = ?'); p.push(f.registroId); }
  if (f.fase) { where.push('q.fase = ?'); p.push(f.fase); }
  if (f.entidade) { where.push('q.entidade = ?'); p.push(f.entidade); }
  if (f.codigo) { where.push('q.codigo_erro = ?'); p.push(f.codigo); }
  if (f.faixa === 'erro') where.push('q.status IS NULL');
  else if (f.faixa === '429') where.push('q.status = 429');
  else if (f.faixa && /^[2-5]xx$/.test(f.faixa)) { where.push('q.status BETWEEN ? AND ?'); p.push(Number(f.faixa[0]) * 100, Number(f.faixa[0]) * 100 + 99); }
  if (f.busca) { where.push('(q.url LIKE ? OR q.req_corpo LIKE ? OR q.res_corpo LIKE ? OR r.rotulo LIKE ?)'); p.push(...Array(4).fill(`%${f.busca}%`)); }
  if (f.depoisDe) { where.push('q.id > ?'); p.push(f.depoisDe); }
  if (f.antesDe) { where.push('q.id < ?'); p.push(f.antesDe); }
  const limite = Math.min(500, Math.max(1, f.limite ?? 100));
  return todos<Record<string, unknown>>(
    `SELECT q.id, q.execucao_id, q.destino_id, q.registro_id, q.fase, q.entidade, q.metodo, q.url, q.status, q.duracao_ms, q.tentativa,
            q.chave_idempotencia, q.codigo_erro, q.resultado, q.erro, q.criado_em, r.rotulo AS registro_rotulo, r.caso AS registro_caso
       FROM requisicoes q LEFT JOIN registros r ON r.id = q.registro_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.id DESC LIMIT ?`,
    ...p, limite,
  ).map((l) => ({
    id: l.id, execucaoId: l.execucao_id, destinoId: l.destino_id, registroId: l.registro_id, fase: l.fase, entidade: l.entidade,
    metodo: l.metodo, url: l.url, status: l.status, duracaoMs: l.duracao_ms, tentativa: l.tentativa, chaveIdempotencia: l.chave_idempotencia,
    codigoErro: l.codigo_erro, resultado: l.resultado, erro: l.erro, criadoEm: l.criado_em, registroRotulo: l.registro_rotulo, registroCaso: l.registro_caso,
  }));
}

function corpo(texto: unknown): unknown {
  if (typeof texto !== 'string' || !texto) return texto ?? null;
  try { return JSON.parse(texto); } catch { return texto; }
}

export function obterRequisicao(id: number) {
  const l = um<Record<string, unknown>>('SELECT * FROM requisicoes WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Requisição não encontrada.');
  const reg = l.registro_id ? um<Record<string, unknown>>('SELECT id, rotulo, entidade, caso, perfil, esperado, conferencia, obtido, resultado, diferencas, status, id_remoto FROM registros WHERE id = ?', l.registro_id as string) : undefined;
  return {
    id: l.id, execucaoId: l.execucao_id, destinoId: l.destino_id, registroId: l.registro_id, fase: l.fase, entidade: l.entidade,
    metodo: l.metodo, url: l.url, status: l.status, duracaoMs: l.duracao_ms, tentativa: l.tentativa, chaveIdempotencia: l.chave_idempotencia,
    codigoErro: l.codigo_erro, resultado: l.resultado, erro: l.erro, criadoEm: l.criado_em,
    requisicao: { cabecalhos: json(l.req_cabecalhos, {}), corpo: corpo(l.req_corpo) },
    resposta: { cabecalhos: json(l.res_cabecalhos, {}), corpo: corpo(l.res_corpo) },
    registro: reg ? {
      id: reg.id, rotulo: reg.rotulo, entidade: reg.entidade, caso: reg.caso, perfil: reg.perfil, status: reg.status, idRemoto: reg.id_remoto,
      esperado: json(reg.esperado, {}), conferencia: json(reg.conferencia, null), obtido: json(reg.obtido, null),
      resultado: reg.resultado, diferencas: json(reg.diferencas, []),
    } : null,
  };
}

export function painelExecucao(execucaoId: string) {
  const base = 'FROM requisicoes WHERE execucao_id = ?';
  const total = um<{ n: number; media: number | null }>(`SELECT COUNT(*) AS n, AVG(duracao_ms) AS media ${base}`, execucaoId)!;
  const ultimoMinuto = um<{ n: number }>(`SELECT COUNT(*) AS n ${base} AND criado_em >= ?`, execucaoId, new Date(Date.now() - 60000).toISOString())!.n;
  const faixas = todos<{ faixa: string; n: number }>(
    `SELECT CASE WHEN status IS NULL THEN 'erro' WHEN status = 429 THEN '429' ELSE (status / 100) || 'xx' END AS faixa, COUNT(*) AS n ${base} GROUP BY faixa`, execucaoId);
  const erros = todos<{ status: number | null; codigo: string | null; n: number }>(
    `SELECT status, codigo_erro AS codigo, COUNT(*) AS n ${base} AND (status IS NULL OR status >= 400) GROUP BY status, codigo_erro ORDER BY n DESC LIMIT 6`, execucaoId);
  const limite = um<{ res_cabecalhos: string }>(`SELECT res_cabecalhos ${base} AND res_cabecalhos LIKE '%ratelimit-remaining%' ORDER BY id DESC LIMIT 1`, execucaoId);
  const cab = json<Record<string, string>>(limite?.res_cabecalhos, {});
  return {
    total: total.n, mediaMs: total.media ? Math.round(total.media) : null, ultimoMinuto,
    faixas: Object.fromEntries(faixas.map((f) => [f.faixa, f.n])),
    errosFrequentes: erros,
    limite: cab['ratelimit-remaining'] ? { restante: cab['ratelimit-remaining'], limite: cab['ratelimit-limit'], reinicio: cab['ratelimit-reset'] } : null,
  };
}

export function linhaDoTempo(registroId: string) {
  return todos<Record<string, unknown>>(
    'SELECT id, fase, metodo, url, status, duracao_ms, tentativa, codigo_erro, resultado, erro, criado_em FROM requisicoes WHERE registro_id = ? ORDER BY id', registroId,
  ).map((l) => ({ id: l.id, fase: l.fase, metodo: l.metodo, url: l.url, status: l.status, duracaoMs: l.duracao_ms, tentativa: l.tentativa, codigoErro: l.codigo_erro, resultado: l.resultado, erro: l.erro, criadoEm: l.criado_em }));
}

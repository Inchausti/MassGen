// Auditoria: quem fez o quê, quando e em quê. A trilha é só de inclusão e encadeada por hash:
// cada linha guarda o hash da anterior, e qualquer alteração ou remoção quebra a verificação.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { agora, executar, json, todos, um } from './db.ts';

export interface ContextoUso { usuario: string; maquina: string }

export const contexto = new AsyncLocalStorage<ContextoUso>();

const usuarioDoSistema = (() => { try { return userInfo().username; } catch { return 'desconhecido'; } })();
export const MAQUINA = hostname();

// Quem está agindo: o nome informado na interface (cabeçalho X-MassGen-Usuario) ou o usuário do sistema.
export function usuarioAtual(): ContextoUso {
  return contexto.getStore() ?? { usuario: `${usuarioDoSistema} (sistema)`, maquina: MAQUINA };
}

export function contextoDaRequisicao(cabecalho: string | string[] | undefined): ContextoUso {
  const nome = (Array.isArray(cabecalho) ? cabecalho[0] : cabecalho ?? '').trim().slice(0, 80);
  let decodificado = nome;
  try { decodificado = decodeURIComponent(nome); } catch { /* usa como veio */ }
  return { usuario: decodificado ? `${decodificado} · ${usuarioDoSistema}` : usuarioDoSistema, maquina: MAQUINA };
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function ultimoHash(tabela: 'auditoria' | 'requisicoes'): string | null {
  return um<{ hash: string | null }>(`SELECT hash FROM ${tabela} WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`)?.hash ?? null;
}

// ---------------------------------------------------------------- trilha de auditoria

function conteudoAuditoria(l: { em: string; usuario: string; maquina: string; acao: string; alvo_tipo: string | null; alvo_id: string | null; execucao_id: string | null; resumo: string; detalhes: string }): string {
  return JSON.stringify([l.em, l.usuario, l.maquina, l.acao, l.alvo_tipo, l.alvo_id, l.execucao_id, l.resumo, l.detalhes]);
}

// Detalhes nunca levam segredo: chaves com nome de segredo são trocadas por "definido".
function limpar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(limpar);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /(secret|senha|password|token|api_?key)/i.test(k) && typeof x === 'string' ? (x ? 'definido' : '') : limpar(x)]));
  }
  return v;
}

export function auditar(acao: string, resumo: string, opcoes: { alvoTipo?: string; alvoId?: string; execucaoId?: string; detalhes?: unknown } = {}): void {
  const quem = usuarioAtual();
  const linha = {
    em: agora(), usuario: quem.usuario, maquina: quem.maquina, acao, alvo_tipo: opcoes.alvoTipo ?? null, alvo_id: opcoes.alvoId ?? null,
    execucao_id: opcoes.execucaoId ?? null, resumo, detalhes: JSON.stringify(limpar(opcoes.detalhes ?? {})),
  };
  const anterior = ultimoHash('auditoria');
  const hash = sha256(`${anterior ?? ''}|${conteudoAuditoria(linha)}`);
  executar(
    `INSERT INTO auditoria (em, usuario, maquina, acao, alvo_tipo, alvo_id, execucao_id, resumo, detalhes, hash_anterior, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    linha.em, linha.usuario, linha.maquina, acao, linha.alvo_tipo, linha.alvo_id, linha.execucao_id, resumo, linha.detalhes, anterior, hash,
  );
}

export function listarAuditoria(f: { acao?: string; usuario?: string; alvoId?: string; execucaoId?: string; de?: string; ate?: string; antesDe?: number; limite?: number }) {
  const where: string[] = [];
  const p: (string | number)[] = [];
  if (f.acao) { where.push('acao LIKE ?'); p.push(`${f.acao}%`); }
  if (f.usuario) { where.push('usuario LIKE ?'); p.push(`%${f.usuario}%`); }
  if (f.alvoId) { where.push('alvo_id = ?'); p.push(f.alvoId); }
  if (f.execucaoId) { where.push('execucao_id = ?'); p.push(f.execucaoId); }
  if (f.de) { where.push('em >= ?'); p.push(f.de); }
  if (f.ate) { where.push('em <= ?'); p.push(`${f.ate}T23:59:59.999Z`); }
  if (f.antesDe) { where.push('id < ?'); p.push(f.antesDe); }
  return todos<Record<string, unknown>>(
    `SELECT * FROM auditoria ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...p, Math.min(500, f.limite ?? 100),
  ).map((l) => ({
    id: l.id, em: l.em, usuario: l.usuario, maquina: l.maquina, acao: l.acao, alvoTipo: l.alvo_tipo, alvoId: l.alvo_id,
    execucaoId: l.execucao_id, resumo: l.resumo, detalhes: json(l.detalhes, {}), hash: l.hash,
  }));
}

export function acoesAuditadas(): string[] {
  return todos<{ acao: string }>('SELECT DISTINCT acao FROM auditoria ORDER BY acao').map((a) => a.acao);
}

// ---------------------------------------------------------------- requisições encadeadas

export interface ConteudoRequisicao {
  execucao_id: string | null; destino_id: string; registro_id: string | null; operacao_id: string | null; fase: string; entidade: string | null;
  metodo: string; url: string; status: number | null; duracao_ms: number; tentativa: number; chave_idempotencia: string | null;
  req_cabecalhos: string; req_corpo: string | null; res_cabecalhos: string; res_corpo: string | null; erro: string | null; codigo_erro: string | null;
  resultado: string | null; criado_em: string; usuario: string | null; rastreio: string | null; corpo_hash: string | null;
}

const CAMPOS_REQ: (keyof ConteudoRequisicao)[] = [
  'execucao_id', 'destino_id', 'registro_id', 'operacao_id', 'fase', 'entidade', 'metodo', 'url', 'status', 'duracao_ms', 'tentativa', 'chave_idempotencia',
  'req_cabecalhos', 'req_corpo', 'res_cabecalhos', 'res_corpo', 'erro', 'codigo_erro', 'resultado', 'criado_em', 'usuario', 'rastreio', 'corpo_hash',
];

const conteudoRequisicao = (l: ConteudoRequisicao) => JSON.stringify(CAMPOS_REQ.map((c) => l[c] ?? null));

export function gravarRequisicao(l: ConteudoRequisicao): number {
  const anterior = ultimoHash('requisicoes');
  const hash = sha256(`${anterior ?? ''}|${conteudoRequisicao(l)}`);
  const r = executar(
    `INSERT INTO requisicoes (${CAMPOS_REQ.join(', ')}, hash_anterior, hash) VALUES (${CAMPOS_REQ.map(() => '?').join(', ')}, ?, ?)`,
    ...CAMPOS_REQ.map((c) => l[c] ?? null), anterior, hash,
  );
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------- verificação de integridade

export interface Integridade { ok: boolean; total: number; primeiraFalha?: { id: number; motivo: string } }

function verificar(tabela: 'auditoria' | 'requisicoes', conteudo: (l: any) => string): Integridade {
  let anterior: string | null = null;
  let total = 0;
  const stmt = todos<Record<string, unknown>>(`SELECT * FROM ${tabela} WHERE hash IS NOT NULL ORDER BY id`);
  for (const l of stmt) {
    total++;
    if ((l.hash_anterior ?? null) !== anterior) return { ok: false, total, primeiraFalha: { id: l.id as number, motivo: 'A linha anterior foi removida ou alterada.' } };
    const esperado = sha256(`${anterior ?? ''}|${conteudo(l)}`);
    if (esperado !== l.hash) return { ok: false, total, primeiraFalha: { id: l.id as number, motivo: 'O conteúdo desta linha foi alterado depois de gravado.' } };
    anterior = l.hash as string;
  }
  return { ok: true, total };
}

export function verificarIntegridade() {
  return {
    auditoria: verificar('auditoria', (l) => conteudoAuditoria(l)),
    requisicoes: verificar('requisicoes', (l) => conteudoRequisicao(l as ConteudoRequisicao)),
    verificadoEm: agora(),
  };
}

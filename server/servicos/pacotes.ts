// Pacotes de domínio: instalam modelos, operações padrão, configuração de destino e cenários prontos.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { agora, executar, json, novoId, todos, transacao, um } from '../db.ts';
import type { DefinicaoCenario, ModeloEntidade } from '../core/tipos.ts';
import { validarModelo } from '../core/validar.ts';
import { ErroHttp } from '../http.ts';

export interface OperacaoPadrao {
  nome: string;
  pasta?: string;
  entidade?: string;
  acao?: string;
  metodo: string;
  rota: string;
  cabecalhos?: Record<string, string>;
  corpo?: string;
}

export interface ConteudoPacote {
  id: string;
  nome: string;
  versao: string;
  descricao?: string;
  contrato?: string;
  dominiosProducao?: string[];
  destinoPadrao?: {
    autenticacao?: Record<string, unknown>;
    limites?: Record<string, unknown>;
    idempotencia?: Record<string, unknown>;
    cabecalhos?: Record<string, string>;
    variaveis?: Record<string, string>;
    teste?: { metodo: string; rota: string };
  };
  operacoes?: OperacaoPadrao[];
  modelos: ModeloEntidade[];
  cenarios?: { id: string; nome: string; descricao?: string; definicao: DefinicaoCenario }[];
}

interface LinhaPacote { id: string; nome: string; versao: string; descricao: string | null; conteudo: string; embutido: number; instalado_em: string }

function versaoMaior(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export function validarPacote(c: ConteudoPacote): string[] {
  const erros: string[] = [];
  if (!c || typeof c !== 'object') return ['O pacote precisa ser um objeto JSON.'];
  if (!/^[a-z0-9_-]+$/.test(c.id ?? '')) erros.push('id: use letras minúsculas, números, _ ou -.');
  if (!c.nome) erros.push('nome: obrigatório.');
  if (!c.versao) erros.push('versao: obrigatória.');
  if (!Array.isArray(c.modelos) || !c.modelos.length) erros.push('modelos: o pacote precisa de pelo menos um modelo.');
  for (const m of c.modelos ?? []) for (const e of validarModelo(m, c.modelos)) erros.push(`${m.nome}: ${e}`);
  return erros;
}

export function instalarPacote(c: ConteudoPacote, opcoes: { embutido?: boolean; sobrescreverModelos?: boolean } = {}): { id: string; modelos: number; preservados: string[] } {
  const erros = validarPacote(c);
  if (erros.length) throw new ErroHttp(422, 'O pacote tem erros.', erros);
  const preservados: string[] = [];
  transacao(() => {
    const t = agora();
    executar(
      `INSERT INTO pacotes (id, nome, versao, descricao, conteudo, embutido, instalado_em) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, versao = excluded.versao, descricao = excluded.descricao,
         conteudo = excluded.conteudo, embutido = excluded.embutido, instalado_em = excluded.instalado_em`,
      c.id, c.nome, c.versao, c.descricao ?? null, JSON.stringify(c), opcoes.embutido ? 1 : 0, t,
    );
    for (const m of c.modelos) {
      const atual = um<{ id: string; alterado_localmente: number }>('SELECT id, alterado_localmente FROM modelos WHERE pacote_id = ? AND nome = ?', c.id, m.nome);
      if (atual?.alterado_localmente && !opcoes.sobrescreverModelos) { preservados.push(m.nome); continue; }
      if (atual) executar('UPDATE modelos SET definicao = ?, alterado_localmente = 0, atualizado_em = ? WHERE id = ?', JSON.stringify(m), t, atual.id);
      else executar('INSERT INTO modelos (id, pacote_id, nome, definicao, atualizado_em) VALUES (?, ?, ?, ?, ?)', novoId('mod'), c.id, m.nome, JSON.stringify(m), t);
    }
  });
  return { id: c.id, modelos: c.modelos.length, preservados };
}

// Na subida: instala os pacotes da pasta packs/ que faltam ou que têm versão nova.
export function garantirPacotesEmbutidos(): void {
  if (!existsSync(config.dirPacotes)) return;
  for (const arq of readdirSync(config.dirPacotes).filter((f) => f.endsWith('.json'))) {
    const c = JSON.parse(readFileSync(path.join(config.dirPacotes, arq), 'utf8')) as ConteudoPacote;
    const atual = um<{ versao: string }>('SELECT versao FROM pacotes WHERE id = ?', c.id);
    if (!atual || versaoMaior(c.versao, atual.versao)) {
      const r = instalarPacote(c, { embutido: true });
      console.log(`Pacote ${c.nome} ${c.versao} instalado${r.preservados.length ? ` (modelos alterados mantidos: ${r.preservados.join(', ')})` : ''}.`);
    }
  }
}

export function obterPacote(id: string): ConteudoPacote | undefined {
  const l = um<LinhaPacote>('SELECT * FROM pacotes WHERE id = ?', id);
  return l ? json<ConteudoPacote>(l.conteudo, undefined as never) : undefined;
}

export function listarPacotes() {
  return todos<LinhaPacote>('SELECT * FROM pacotes ORDER BY nome').map((l) => {
    const c = json<ConteudoPacote>(l.conteudo, { modelos: [] } as never);
    return {
      id: l.id, nome: l.nome, versao: l.versao, descricao: l.descricao, embutido: !!l.embutido, instaladoEm: l.instalado_em,
      contrato: c.contrato, modelos: modelosDoPacote(l.id).map((m) => ({ nome: m.nome, rotulo: m.rotulo })),
      operacoes: c.operacoes?.length ?? 0, cenarios: (c.cenarios ?? []).map((x) => ({ id: x.id, nome: x.nome, descricao: x.descricao })),
      dominiosProducao: c.dominiosProducao ?? [],
    };
  });
}

export function modelosDoPacote(pacoteId: string): ModeloEntidade[] {
  return todos<{ definicao: string }>('SELECT definicao FROM modelos WHERE pacote_id = ? ORDER BY rowid', pacoteId)
    .map((m) => JSON.parse(m.definicao) as ModeloEntidade);
}

// Exporta o pacote com os modelos como estão agora (inclusive os alterados no app).
export function exportarPacote(id: string): ConteudoPacote {
  const c = obterPacote(id);
  if (!c) throw new ErroHttp(404, 'Pacote não encontrado.');
  return { ...c, modelos: modelosDoPacote(id) };
}

export function removerPacote(id: string): void {
  const usado = um<{ n: number }>('SELECT COUNT(*) AS n FROM destinos WHERE pacote_id = ?', id);
  if (usado && usado.n > 0) throw new ErroHttp(409, 'Há destinos usando este pacote. Troque o pacote desses destinos antes de remover.');
  executar('DELETE FROM pacotes WHERE id = ?', id);
}

// Ambientes de teste: a raiz da v3.0. Um ambiente é um sistema testado num tipo de ambiente e reúne as integrações
// dele — a API que o sistema expõe e as APIs dos entes que ele integra —, os dados mestre e os contextos de massa.
import { agora, executar, novoId, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { usuarioAtual } from '../auditoria.ts';
import { obterPacote } from './pacotes.ts';
import { listarDestinos, type TipoAmbiente } from './destinos.ts';

export const TIPOS_AMBIENTE: TipoAmbiente[] = ['sandbox', 'homologacao', 'desenvolvimento'];
const ROTULO_TIPO: Record<TipoAmbiente, string> = { sandbox: 'Sandbox', homologacao: 'Homologação', desenvolvimento: 'Desenvolvimento' };

export interface Ambiente {
  id: string;
  nome: string;
  sistema: string | null;
  tipo: TipoAmbiente;
  pacoteId: string | null;
  descricao: string | null;
  criadoPor: string | null;
  criadoEm: string;
  atualizadoEm: string;
}

function linha(l: Record<string, unknown>): Ambiente {
  return {
    id: l.id as string, nome: l.nome as string, sistema: (l.sistema as string) ?? null, tipo: l.tipo as TipoAmbiente,
    pacoteId: (l.pacote_id as string) ?? null, descricao: (l.descricao as string) ?? null, criadoPor: (l.criado_por as string) ?? null,
    criadoEm: l.criado_em as string, atualizadoEm: l.atualizado_em as string,
  };
}

export function obterAmbiente(id: string): Ambiente {
  const l = um('SELECT * FROM ambientes WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Ambiente não encontrado.');
  return linha(l);
}

export function listarAmbientes() {
  const integracoes = listarDestinos();
  return todos('SELECT * FROM ambientes ORDER BY nome').map((l) => {
    const a = linha(l);
    return {
      ...a,
      pacote: a.pacoteId ? { id: a.pacoteId, nome: obterPacote(a.pacoteId)?.nome ?? a.pacoteId } : null,
      integracoes: integracoes.filter((d) => d.ambienteId === a.id).map((d) => ({ id: d.id, nome: d.nome, papel: d.papel, ente: d.ente, status: d.status })),
    };
  });
}

export function detalharAmbiente(id: string) {
  const a = obterAmbiente(id);
  return {
    ...a,
    pacote: a.pacoteId ? { id: a.pacoteId, nome: obterPacote(a.pacoteId)?.nome ?? a.pacoteId } : null,
    integracoes: listarDestinos({ ambienteId: id }),
  };
}

function validar(dados: Partial<Ambiente>, id?: string): void {
  if (!dados.nome?.trim()) throw new ErroHttp(422, 'Informe o nome do ambiente.');
  if (!TIPOS_AMBIENTE.includes(dados.tipo as TipoAmbiente)) throw new ErroHttp(422, 'Tipo de ambiente: sandbox, homologação ou desenvolvimento. Produção não é aceita.');
  if (dados.pacoteId && !obterPacote(dados.pacoteId)) throw new ErroHttp(422, 'Pacote não encontrado.');
  const mesmo = um<{ id: string }>('SELECT id FROM ambientes WHERE lower(nome) = lower(?)', dados.nome.trim());
  if (mesmo && mesmo.id !== id) throw new ErroHttp(409, `Já existe um ambiente chamado ${dados.nome.trim()}.`);
}

export function criarAmbiente(dados: Partial<Ambiente>): Ambiente {
  validar(dados);
  const id = novoId('amb');
  const t = agora();
  executar(
    'INSERT INTO ambientes (id, nome, sistema, tipo, pacote_id, descricao, criado_por, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, dados.nome!.trim(), dados.sistema?.trim() || null, dados.tipo!, dados.pacoteId || null, dados.descricao?.trim() || null, usuarioAtual().usuario, t, t,
  );
  return obterAmbiente(id);
}

export function atualizarAmbiente(id: string, dados: Partial<Ambiente>): Ambiente {
  const atual = obterAmbiente(id);
  const novo = { ...atual, ...dados, id };
  validar(novo, id);
  const t = agora();
  executar(
    'UPDATE ambientes SET nome = ?, sistema = ?, tipo = ?, pacote_id = ?, descricao = ?, atualizado_em = ? WHERE id = ?',
    novo.nome.trim(), novo.sistema?.trim() || null, novo.tipo, novo.pacoteId || null, novo.descricao?.trim() || null, t, id,
  );
  // O tipo é do ambiente: as integrações acompanham.
  if (novo.tipo !== atual.tipo) executar('UPDATE destinos SET tipo_ambiente = ?, atualizado_em = ? WHERE ambiente_id = ?', novo.tipo, t, id);
  return obterAmbiente(id);
}

export function removerAmbiente(id: string): void {
  const a = obterAmbiente(id);
  const n = um<{ n: number }>('SELECT COUNT(*) AS n FROM destinos WHERE ambiente_id = ?', id)?.n ?? 0;
  if (n > 0) throw new ErroHttp(409, `O ambiente ${a.nome} tem ${n} integração(ões). Remova ou mova as integrações antes.`);
  executar('DELETE FROM ambientes WHERE id = ?', id);
}

// Ambiente de um pacote e de um tipo: o primeiro que existir, ou um novo, chamado "<pacote> — <tipo>".
export function ambientePadraoPara(pacoteId: string | null, tipo: TipoAmbiente): Ambiente {
  const existente = um(
    'SELECT * FROM ambientes WHERE tipo = ? AND ((pacote_id IS NULL AND ? IS NULL) OR pacote_id = ?) ORDER BY criado_em LIMIT 1',
    tipo, pacoteId, pacoteId,
  );
  if (existente) return linha(existente);
  const pacote = pacoteId ? obterPacote(pacoteId) : undefined;
  const base = `${pacote?.nome ?? 'Sem pacote'} — ${ROTULO_TIPO[tipo]}`;
  let nome = base;
  for (let i = 2; um('SELECT 1 FROM ambientes WHERE lower(nome) = lower(?)', nome); i++) nome = `${base} ${i}`;
  const id = novoId('amb');
  const t = agora();
  executar(
    'INSERT INTO ambientes (id, nome, sistema, tipo, pacote_id, descricao, criado_por, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, nome, pacote?.nome ?? null, tipo, pacoteId, null, usuarioAtual().usuario, t, t,
  );
  return obterAmbiente(id);
}

// Migração da v2.0: cada destino sem ambiente vai para o ambiente do seu pacote e do seu tipo.
export function garantirAmbientes(): number {
  const soltos = todos<{ id: string; pacote_id: string | null; tipo_ambiente: TipoAmbiente }>('SELECT id, pacote_id, tipo_ambiente FROM destinos WHERE ambiente_id IS NULL');
  for (const d of soltos) executar('UPDATE destinos SET ambiente_id = ? WHERE id = ?', ambientePadraoPara(d.pacote_id, d.tipo_ambiente).id, d.id);
  return soltos.length;
}

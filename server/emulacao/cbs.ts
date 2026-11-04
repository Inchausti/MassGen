// Receita Federal emulada (proposta v4.3, seções 03 e 10; APIs de Apuração da CBS v2, A.3 a A.5): a base de documentos
// e os tíquetes. Fechar o dia muda as fotos e, com a urlRetorno cadastrada na POC, abre um tíquete sem pedido por
// endpoint que mudou naquele dia (D-MG-03). O pedido do SplitHub abre o tíquete pela janela de 8 dias, ou desde o dia 1 do mês na
// primeira coleta daquele endpoint. Cada tíquete guarda o arquivo como saiu, e o link assinado vale 48 horas simuladas.
import { createHash, randomUUID } from 'node:crypto';
import { agora, executar, json, novoId, todos, um } from '../db.ts';
import { sha256 } from '../auditoria.ts';
import { assinar } from '../cofre.ts';
import { ENDPOINTS, TIPO_CBS, type Endpoint } from './catalogo-cbs.ts';
import { montarArquivoCbs, type DadosCbs, type EventoCbs, type ItemArquivo } from './arquivo-cbs.ts';
import { armado, registrarInjecao } from './casos.ts';
import { somarDias, type NotaRow, type PocRow } from './execucao.ts';

export interface TiqueteRow {
  id: string; poc_id: string; tiquete: string; endpoint: Endpoint; origem: 'pedido' | 'sem_pedido'; url_retorno: string | null;
  estado: 'PENDENTE' | 'EM_PROCESSAMENTO' | 'CONCLUIDA' | 'ERRO'; dia: string; janela_ini: string | null; janela_fim: string | null; gerado_em: string | null;
  conteudo: string | null; hash: string | null; tamanho: number | null; qtd_documentos: number; assinatura_hash: string | null; expira_em: string | null;
  codigo_erro: string | null; mensagem_erro: string | null; concluido_em: string | null; expirado_em: string | null; criado_por: string | null;
  criado_em: string; atualizado_em: string;
}

export const VALIDADE_HORAS = 48;
export const JANELA_DIAS = 8;
export const LIMITE_POR_DIA = 4;

// O relógio simulado dá a data; a hora é a de Brasília no relógio de parede, para o pedido ter um horário plausível.
export function agoraSimulado(dia: string): string {
  return `${dia}T${new Date(Date.now() - 3 * 3600_000).toISOString().slice(11, 19)}-03:00`;
}
const maisHoras = (iso: string, horas: number) => new Date(Date.parse(iso) + horas * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// O link assinado sai sempre igual para o mesmo tíquete (o reenvio do aviso repete o mesmo link) e só o hash fica no banco.
export const assinaturaDe = (t: { id: string }) => assinar(`cbs-link:${t.id}`);
export const tiquetePorAssinatura = (assinatura: string) => um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE assinatura_hash = ?', sha256(assinatura));

// Vencido quando o relógio já passou do fim da validade.
export const expirou = (t: Pick<TiqueteRow, 'expira_em'>, dia: string) => !!t.expira_em && Date.parse(t.expira_em) < Date.parse(`${dia}T00:00:00-03:00`);

// ---------------------------------------------------------------- o que entra num arquivo

interface Fechado { id: string; nota_id: string; tipo: string; valores: string; dth_lancto: string; dados: string | null }

const paraEvento = (e: Fechado): EventoCbs => ({ tipo: e.tipo, valores: json(e.valores, {}), dth: e.dth_lancto, dados: json<DadosCbs | null>(e.dados, null) });

function fechados(pocId: string, endpoint: Endpoint): Fechado[] {
  return todos<Fechado>(
    "SELECT id, nota_id, tipo, valores, dth_lancto, dados FROM eventos WHERE poc_id = ? AND ente = 'cbs' AND situacao NOT IN ('planejado', 'substituido') AND dth_lancto IS NOT NULL ORDER BY dth_lancto, ordem",
    pocId).filter((e) => TIPO_CBS.get(e.tipo)?.endpoint === endpoint);
}

// O pedido usa a janela; o aviso sem pedido, o dia que fechou. Dia fechado sem urlRetorno fica só para o pedido.
export type Criterio = { janela: [string, string] } | { dia: string };

// Débitos e créditos: o documento entra pela última mudança dele (o atualizacao) e com a foto inteira. Pagamentos e
// recolhimentos: só os registros do período.
export function selecionar(pocId: string, endpoint: Endpoint, c: Criterio): { itens: ItemArquivo[]; eventos: string[] } {
  const evs = fechados(pocId, endpoint);
  const dentro = (e: Fechado) => ('janela' in c ? e.dth_lancto >= c.janela[0] && e.dth_lancto <= c.janela[1] : e.dth_lancto.startsWith(c.dia));
  const porDoc = new Map<string, Fechado[]>();
  for (const e of evs) porDoc.set(e.nota_id, [...(porDoc.get(e.nota_id) ?? []), e]);
  const itens: ItemArquivo[] = [];
  const eventos: string[] = [];
  for (const [notaId, lista] of porDoc) {
    const fotos = endpoint === 'debitos' || endpoint === 'creditos';
    const escolhidos = fotos ? (dentro(lista[lista.length - 1]) ? lista : []) : lista.filter(dentro);
    if (!escolhidos.length) continue;
    const doc = um<NotaRow>('SELECT * FROM notas WHERE id = ?', notaId)!;
    itens.push({ doc, eventos: escolhidos.map(paraEvento) });
    eventos.push(...escolhidos.map((e) => e.id));
  }
  return { itens, eventos };
}

// ---------------------------------------------------------------- tíquetes

export function abrirTiquete(poc: PocRow, d: { endpoint: Endpoint; origem: TiqueteRow['origem']; url: string | null; janela?: [string, string]; usuario: string }): TiqueteRow {
  const id = novoId('tiq');
  executar(
    `INSERT INTO cbs_tiquetes (id, poc_id, tiquete, endpoint, origem, url_retorno, estado, dia, janela_ini, janela_fim, criado_por, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDENTE', ?, ?, ?, ?, ?, ?)`,
    id, poc.id, randomUUID(), d.endpoint, d.origem, d.url, poc.dia, d.janela?.[0] ?? null, d.janela?.[1] ?? null, d.usuario, agora(), agora(),
  );
  return um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE id = ?', id)!;
}

export function concluirTiquete(t: TiqueteRow, sel: { itens: ItemArquivo[]; eventos: string[] }, geradoEm: string): TiqueteRow {
  const poc = um<PocRow>('SELECT * FROM pocs WHERE id = ?', t.poc_id)!;
  const { conteudo, registros } = montarArquivoCbs(t.endpoint, t.tiquete, poc.cnpj_raiz, geradoEm, sel.itens);
  const texto = JSON.stringify(conteudo, null, 2);
  executar(
    `UPDATE cbs_tiquetes SET estado = 'CONCLUIDA', gerado_em = ?, conteudo = ?, hash = ?, tamanho = ?, qtd_documentos = ?, assinatura_hash = ?, expira_em = ?,
       concluido_em = ?, atualizado_em = ? WHERE id = ?`,
    geradoEm, texto, createHash('sha256').update(texto).digest('hex'), Buffer.byteLength(texto), registros, sha256(assinaturaDe(t)), maisHoras(geradoEm, VALIDADE_HORAS),
    agora(), agora(), t.id,
  );
  for (const e of sel.eventos) executar('INSERT OR IGNORE INTO cbs_tiquete_eventos (tiquete_id, evento_id) VALUES (?, ?)', t.id, e);
  return um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE id = ?', t.id)!;
}

// O pedido do SplitHub: janela de 8 dias até agora, ou desde o dia 1 do mês na primeira coleta deste endpoint.
export function abrirPedido(poc: PocRow, endpoint: Endpoint, url: string, usuario: string): TiqueteRow {
  const fim = agoraSimulado(poc.dia);
  const primeira = !um("SELECT 1 FROM cbs_tiquetes WHERE poc_id = ? AND endpoint = ? AND origem = 'pedido'", poc.id, endpoint);
  const ini = primeira ? `${poc.dia.slice(0, 7)}-01T00:00:00-03:00` : `${somarDias(poc.dia, -JANELA_DIAS)}${fim.slice(10)}`;
  return abrirTiquete(poc, { endpoint, origem: 'pedido', url, janela: [ini, fim], usuario });
}

export const pedidosNoDia = (poc: PocRow, endpoint: Endpoint) =>
  um<{ n: number }>("SELECT COUNT(*) AS n FROM cbs_tiquetes WHERE poc_id = ? AND endpoint = ? AND origem = 'pedido' AND dia = ?", poc.id, endpoint, poc.dia)!.n;

export function marcarProcessando(tiqueteId: string): TiqueteRow | undefined {
  executar("UPDATE cbs_tiquetes SET estado = 'EM_PROCESSAMENTO', atualizado_em = ? WHERE id = ? AND estado = 'PENDENTE'", agora(), tiqueteId);
  return um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE id = ?', tiqueteId);
}

export const ERRO_408 = { codigo: 'APURACAO-408', mensagem: 'Tempo limite de processamento excedido (240 minutos).' };

// Casos de transporte e falha ligados (seção 07): T03 estoura o processamento; T02 conclui com o link já vencido.
export function processarPedido(tiqueteId: string): TiqueteRow | undefined {
  const t = um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE id = ?', tiqueteId);
  if (!t || t.estado === 'CONCLUIDA' || t.estado === 'ERRO') return t;
  if (armado(t.poc_id, 'T03', 'cbs')) {
    executar("UPDATE cbs_tiquetes SET estado = 'ERRO', codigo_erro = ?, mensagem_erro = ?, concluido_em = ?, atualizado_em = ? WHERE id = ?",
      ERRO_408.codigo, ERRO_408.mensagem, agora(), agora(), t.id);
    registrarInjecao(t.poc_id, 'T03', 'cbs', t.dia, { tipo: 'tiquete', id: t.id }, { endpoint: t.endpoint, tiquete: t.tiquete });
    return um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE id = ?', t.id);
  }
  const c = concluirTiquete(t, selecionar(t.poc_id, t.endpoint, { janela: [t.janela_ini!, t.janela_fim!] }), t.janela_fim!);
  if (!armado(t.poc_id, 'T02', 'cbs')) return c;
  executar('UPDATE cbs_tiquetes SET expira_em = gerado_em, expirado_em = ?, atualizado_em = ? WHERE id = ?', agora(), agora(), t.id);
  registrarInjecao(t.poc_id, 'T02', 'cbs', t.dia, { tipo: 'tiquete', id: t.id }, { endpoint: t.endpoint, tiquete: t.tiquete });
  return um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE id = ?', t.id);
}

// ---------------------------------------------------------------- fechamento do dia e validade dos links

export interface ProcessamentoCbs { dia: string; eventos: number; tiquetes: { id: string; tiquete: string; endpoint: Endpoint; documentos: number }[] }

// Dentro da transação do fechamento: os eventos do dia mudam as fotos, com o atualizacao no horário simulado, e
// ficam disponíveis. Com a urlRetorno cadastrada, sai um tíquete sem pedido por endpoint com o que mudou desde o último.
export function processarDiaCbs(poc: PocRow, dia: string, usuario: string): ProcessamentoCbs | null {
  const fila = todos<{ id: string }>("SELECT id FROM eventos WHERE poc_id = ? AND ente = 'cbs' AND situacao = 'planejado' AND dia <= ? ORDER BY dia, ordem", poc.id, dia);
  fila.forEach((ev, i) => {
    const minutos = Math.min(10 * 60 + i, 22 * 60 + 59);
    const dth = `${dia}T${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}:00-03:00`;
    executar("UPDATE eventos SET dth_lancto = ?, dia = ?, situacao = 'disponivel', atualizado_em = ? WHERE id = ?", dth, dia, agora(), ev.id);
  });
  const tiquetes: ProcessamentoCbs['tiquetes'] = [];
  if (poc.cbs_url_retorno) {
    for (const endpoint of ENDPOINTS) {
      const sel = selecionar(poc.id, endpoint, { dia });
      if (!sel.itens.length) continue;
      const t = concluirTiquete(abrirTiquete({ ...poc, dia }, { endpoint, origem: 'sem_pedido', url: poc.cbs_url_retorno, usuario }), sel, `${dia}T23:00:00-03:00`);
      tiquetes.push({ id: t.id, tiquete: t.tiquete, endpoint, documentos: t.qtd_documentos });
    }
  }
  if (!fila.length && !tiquetes.length) return null;
  return { dia, eventos: fila.length, tiquetes };
}

// Link vencido sem download: os eventos dele que ninguém recebeu por outro tíquete viram "não recebido" (seção 11).
export function expirarTiquetes(pocId: string, dia: string): void {
  const vencidos = todos<TiqueteRow>("SELECT * FROM cbs_tiquetes WHERE poc_id = ? AND estado = 'CONCLUIDA' AND expirado_em IS NULL", pocId).filter((t) => expirou(t, dia));
  for (const t of vencidos) {
    executar('UPDATE cbs_tiquetes SET expirado_em = ?, atualizado_em = ? WHERE id = ?', agora(), agora(), t.id);
    if (um('SELECT 1 FROM cbs_downloads WHERE tiquete_id = ?', t.id)) continue;
    executar(
      `UPDATE eventos SET situacao = 'nao_recebido', motivo = ?, atualizado_em = ? WHERE id IN (SELECT evento_id FROM cbs_tiquete_eventos WHERE tiquete_id = ?) AND situacao IN ('disponivel', 'avisado')`,
      `O link do tíquete ${t.tiquete.slice(0, 8)}… expirou sem download.`, agora(), t.id,
    );
  }
}

// Baixar é a prova de recebimento (D-MG-09): os eventos do tíquete passam a "recebido", mesmo os que outro link perdeu.
export function registrarDownloadCbs(t: TiqueteRow, ip: string, agente: string): void {
  executar('INSERT INTO cbs_downloads (poc_id, tiquete_id, ip, agente, em) VALUES (?, ?, ?, ?, ?)', t.poc_id, t.id, ip, agente, agora());
  executar(
    "UPDATE eventos SET situacao = 'recebido', motivo = NULL, atualizado_em = ? WHERE id IN (SELECT evento_id FROM cbs_tiquete_eventos WHERE tiquete_id = ?) AND situacao IN ('disponivel', 'avisado', 'nao_recebido')",
    agora(), t.id,
  );
}

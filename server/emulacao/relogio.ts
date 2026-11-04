// Relógio da POC e Processamento Diário dos dois entes emulados (proposta v4.3, seção 10). Fechar um dia simulado põe
// os lançamentos do IBS no Arquivo Diferencial (Delta), abre a solicitação DIFERENCIAL, gera os Arquivos Manuais pedidos
// até ali e avisa o webhook do SplitHub; na CBS, muda as fotos dos documentos e, com a urlRetorno cadastrada, avisa sem
// pedido por endpoint que mudou. Os casos T05, T06 e T07 ligados mexem no Delta do primeiro dia em que cabem (um por dia).
import { createHash } from 'node:crypto';
import { agora, executar, json, novoId, todos, transacao, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { usuarioAtual } from '../auditoria.ts';
import { cabecalhoOperacao, fatiar, hashExtrato, linhaMoc, montarArquivo, nomeBase, zipDoArquivo, type Fatia, type OperacaoDoDia } from './arquivo-ibs.ts';
import { avisarSolicitacao, type ResultadoAviso } from '../entes/ibs.ts';
import { avisarTiquete } from '../entes/cbs.ts';
import { expirarTiquetes, processarDiaCbs, type ProcessamentoCbs } from './cbs.ts';
import { armado, registrarInjecao, type Caso } from './casos.ts';
import { diaBr, obterPoc, rotuloNota, somarDias, type NotaRow, type PocRow } from './execucao.ts';
import type { Campo } from './catalogo.ts';

export const VALIDADE_DIAS = 90;
const MAX_DIAS_POR_COMANDO = 62;

interface Fila { id: string; nota_id: string; tipo: string; valores: string; ordem: number }

export interface ArquivoGerado { id: string; idArq: number; nome: string; lancamentos: number }
export interface Processamento {
  dia: string; tipo: 'DIFERENCIAL' | 'MANUAL'; solicitacaoId?: string; idSolic?: number; periodo?: [string, string];
  arquivos: ArquivoGerado[]; operacoes: number; lancamentos: number; semDelta?: boolean; provocado?: { caso: Caso; descricao: string }; aviso?: ResultadoAviso;
}

// Um dia: avança o relógio e processa os dois entes na mesma transação.
function processarDia(pocId: string, dia: string): { ibs: Processamento | null; manuais: Processamento[]; cbs: ProcessamentoCbs | null } | undefined {
  return transacao(() => {
    const poc = obterPoc(pocId);
    if (poc.dia !== dia) return undefined; // outro comando já fechou este dia
    executar('UPDATE pocs SET dia = ?, atualizado_em = ? WHERE id = ?', somarDias(dia, 1), agora(), poc.id);
    const ibs = processarIbs(poc, dia);
    return { ibs, manuais: gerarManuais(poc, dia), cbs: processarDiaCbs(poc, dia, usuarioAtual().usuario) };
  });
}

const proximoIdArq = (pocId: string) => um<{ n: number }>("SELECT COALESCE(MAX(numero), 1000) AS n FROM arquivos WHERE poc_id = ? AND ente = 'ibs'", pocId)!.n;
const marcas = (n: number) => Array(n).fill('?').join(', ');

// Os arquivos de uma solicitação, compactados como o webhook indica, e os eventos que cada um leva.
function gravarArquivos(poc: PocRow, s: { id: string; tipo: 'diferencial(delta)' | 'solicitação manual'; dia: string; inicial: string; final: string; geradoEm: string }, fatias: Fatia[]): ArquivoGerado[] {
  let idArq = proximoIdArq(poc.id);
  return fatias.map((f, i) => {
    const base = nomeBase(s.dia, ++idArq, i + 1);
    const conteudo = JSON.stringify(montarArquivo(`${base}.json`, s.tipo, s.geradoEm, s.inicial, s.final, f), null, 2);
    const zip = zipDoArquivo(`${base}.zip`, conteudo, s.geradoEm);
    const id = novoId('arq');
    executar(
      `INSERT INTO arquivos (id, poc_id, ente, solicitacao_id, numero, parte, nome, conteudo, hash, tamanho, qtd_operacoes, qtd_lancamentos, gerado_em)
       VALUES (?, ?, 'ibs', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, poc.id, s.id, idArq, i + 1, `${base}.zip`, conteudo, createHash('sha256').update(zip).digest('hex'), zip.length, f.operacoes.length, f.lancamentos, s.geradoEm,
    );
    const eventos = f.operacoes.flatMap((o) => o.eventos);
    for (const e of eventos) executar('INSERT OR IGNORE INTO ibs_arquivo_eventos (arquivo_id, evento_id) VALUES (?, ?)', id, e);
    // O primeiro arquivo que levou o evento fica no evento, para o histórico mostrar onde ele saiu.
    if (eventos.length) executar(`UPDATE eventos SET arquivo_id = ?, atualizado_em = ? WHERE arquivo_id IS NULL AND id IN (${marcas(eventos.length)})`, id, agora(), ...eventos);
    return { id, idArq, nome: `${base}.zip`, lancamentos: f.lancamentos };
  });
}

// IBS: lançamentos, hash, arquivos e solicitação DIFERENCIAL do dia.
function processarIbs(poc: PocRow, dia: string): Processamento | null {
  const seguinte = somarDias(dia, 1);
  const fila = todos<Fila>("SELECT id, nota_id, tipo, valores, ordem FROM eventos WHERE poc_id = ? AND ente = 'ibs' AND situacao = 'planejado' AND dia <= ? ORDER BY dia, ordem", poc.id, dia);
  if (!fila.length) return null;
  let lancamento = um<{ n: number }>('SELECT COALESCE(MAX(lancamento_id), 70000000) AS n FROM eventos WHERE poc_id = ?', poc.id)!.n;
  const ops = new Map<string, OperacaoDoDia & { hash: string | null; nota: NotaRow }>();
  fila.forEach((ev, i) => {
    let op = ops.get(ev.nota_id);
    if (!op) {
      const nota = um<NotaRow>('SELECT * FROM notas WHERE id = ?', ev.nota_id)!;
      if (!nota.operacao_id) {
        const proxima = um<{ n: number }>('SELECT COALESCE(MAX(operacao_id), 90000000) + 1 AS n FROM notas WHERE poc_id = ?', poc.id)!.n;
        executar('UPDATE notas SET operacao_id = ? WHERE id = ?', proxima, nota.id);
        nota.operacao_id = proxima;
      }
      const anterior = um<{ hash: string }>('SELECT hash FROM eventos WHERE nota_id = ? AND hash IS NOT NULL ORDER BY lancamento_id DESC LIMIT 1', nota.id);
      op = { cabecalho: cabecalhoOperacao(nota as NotaRow & { operacao_id: number }), linhas: [], hash: anterior?.hash ?? null, nota };
      ops.set(ev.nota_id, op);
    }
    const minutos = Math.min(9 * 60 + i, 23 * 60 + 59);
    const dth = `${dia} ${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}:00.000 -03:00`;
    const linha = linhaMoc(++lancamento, dth, ev.tipo, json<Record<Campo, number>>(ev.valores, {} as Record<Campo, number>));
    op.hash = hashExtrato(op.hash, linha);
    op.linhas.push({ linha, hash: op.hash, eventoId: ev.id });
    executar('UPDATE eventos SET lancamento_id = ?, dth_lancto = ?, hash = ?, dia = ? WHERE id = ?', lancamento, dth, op.hash, dia, ev.id);
  });
  const lista = [...ops.values()];

  // Casos de transporte e falha (seção 07): um por dia, na ordem T05, T07, T06.
  const comDuas = lista.find((o) => o.linhas.length >= 2);
  const quebra = comDuas && armado(poc.id, 'T05', 'ibs') ? comDuas : undefined;
  const omitir = !quebra && comDuas && armado(poc.id, 'T07', 'ibs') ? comDuas : undefined;
  if (!quebra && !omitir && armado(poc.id, 'T06', 'ibs')) {
    const ids = fila.map((f) => f.id);
    executar(`UPDATE eventos SET situacao = 'nao_recebido', motivo = ?, atualizado_em = ? WHERE id IN (${marcas(ids.length)})`,
      `Dia sem Delta (T06): o lançamento existe no IBS emulado, mas o dia ${dia} não gerou Arquivo Diferencial. Só um Arquivo Manual do período o entrega.`, agora(), ...ids);
    registrarInjecao(poc.id, 'T06', 'ibs', dia, { tipo: 'dia', id: dia }, { eventos: ids, lancamentos: ids.length, operacoes: lista.length });
    return { dia, tipo: 'DIFERENCIAL', arquivos: [], operacoes: lista.length, lancamentos: fila.length, semDelta: true,
      provocado: { caso: 'T06', descricao: `Dia ${diaBr(dia)} sem Delta: ${fila.length} lançamento(s) sem entrega até um Arquivo Manual.` } };
  }
  const omitido = omitir ? omitir.linhas.shift()! : undefined;

  const numero = um<{ n: number }>("SELECT COALESCE(MAX(numero), 9000) + 1 AS n FROM solicitacoes WHERE poc_id = ? AND ente = 'ibs'", poc.id)!.n;
  const solicitacaoId = novoId('sol');
  executar(
    `INSERT INTO solicitacoes (id, poc_id, ente, numero, tipo, situacao, dia, data_solic, trans_ini, trans_fim, validade, qtd_oper, criado_em, atualizado_em)
     VALUES (?, ?, 'ibs', ?, 'DIFERENCIAL', 'GERADA', ?, ?, ?, ?, ?, ?, ?, ?)`,
    solicitacaoId, poc.id, numero, dia, `${seguinte}T01:30:00Z`, `${dia}T00:00:00Z`, `${dia}T23:59:59.999Z`, `${somarDias(seguinte, VALIDADE_DIAS)}T01:30:00Z`, ops.size, agora(), agora(),
  );
  const fatias = fatiar(lista, poc.lancamentos_por_arquivo, quebra?.linhas[0].eventoId);
  const arquivos = gravarArquivos(poc, { id: solicitacaoId, tipo: 'diferencial(delta)', dia, inicial: `${dia} 00:00:00`, final: `${dia} 23:59:59`, geradoEm: `${seguinte} 01:30:00` }, fatias);
  const noArquivo = fatias.flatMap((f) => f.operacoes.flatMap((o) => o.eventos));
  executar(`UPDATE eventos SET situacao = 'disponivel', atualizado_em = ? WHERE id IN (${marcas(noArquivo.length)})`, agora(), ...noArquivo);
  let provocado: Processamento['provocado'];
  if (quebra) {
    const partes = fatias.filter((f) => f.operacoes.some((o) => o.cabecalho.ID === quebra.cabecalho.ID)).length;
    registrarInjecao(poc.id, 'T05', 'ibs', dia, { tipo: 'solicitacao', id: solicitacaoId }, { idSolic: numero, operacao: quebra.cabecalho.ID, nota: rotuloNota(quebra.nota), arquivos: arquivos.length, partes });
    provocado = { caso: 'T05', descricao: `A operação ${quebra.cabecalho.ID} (${rotuloNota(quebra.nota)}) saiu em ${partes} arquivos do Delta ${numero}.` };
  }
  if (omitir && omitido) {
    executar("UPDATE eventos SET situacao = 'nao_recebido', motivo = ?, atualizado_em = ? WHERE id = ?",
      `Linha omitida do Delta ${numero} (T07): o hash da operação conta com ela, e o arquivo não a traz. Só um Arquivo Manual do período a entrega.`, agora(), omitido.eventoId);
    registrarInjecao(poc.id, 'T07', 'ibs', dia, { tipo: 'evento', id: omitido.eventoId }, { idSolic: numero, operacao: omitir.cabecalho.ID, nota: rotuloNota(omitir.nota), lancamento: omitido.linha.ID });
    provocado = { caso: 'T07', descricao: `O lançamento ${String(omitido.linha.ID)} da operação ${omitir.cabecalho.ID} ficou fora do Delta ${numero}, e o hash conta com ele.` };
  }
  return { dia, tipo: 'DIFERENCIAL', solicitacaoId, idSolic: numero, arquivos, operacoes: ops.size, lancamentos: fila.length, provocado };
}

interface Lancado { id: string; nota_id: string; tipo: string; valores: string; lancamento_id: number; dth_lancto: string; hash: string }

// Arquivo Manual: no Processamento Diário seguinte ao pedido, com os lançamentos do período, operação a operação, na
// ordem do extrato. O hash de cada operação é o acumulado até o último lançamento dela no período. Período sem
// lançamento gera um arquivo vazio, para a solicitação não ficar sem resposta.
function gerarManuais(poc: PocRow, dia: string): Processamento[] {
  const seguinte = somarDias(dia, 1);
  const pendentes = todos<{ id: string; numero: number; trans_ini: string; trans_fim: string }>(
    "SELECT id, numero, trans_ini, trans_fim FROM solicitacoes WHERE poc_id = ? AND ente = 'ibs' AND tipo = 'MANUAL' AND situacao = 'SOLICITADA' AND dia <= ? ORDER BY numero", poc.id, dia);
  return pendentes.map((s) => {
    const ini = s.trans_ini.slice(0, 10);
    const fim = s.trans_fim.slice(0, 10);
    const evs = todos<Lancado>(
      `SELECT id, nota_id, tipo, valores, lancamento_id, dth_lancto, hash FROM eventos
        WHERE poc_id = ? AND ente = 'ibs' AND lancamento_id IS NOT NULL AND substr(dth_lancto, 1, 10) BETWEEN ? AND ? ORDER BY lancamento_id`, poc.id, ini, fim);
    const ops = new Map<string, OperacaoDoDia>();
    for (const e of evs) {
      let op = ops.get(e.nota_id);
      if (!op) {
        const nota = um<NotaRow>('SELECT * FROM notas WHERE id = ?', e.nota_id)!;
        ops.set(e.nota_id, (op = { cabecalho: cabecalhoOperacao(nota as NotaRow & { operacao_id: number }), linhas: [] }));
      }
      op.linhas.push({ linha: linhaMoc(e.lancamento_id, e.dth_lancto, e.tipo, json<Record<Campo, number>>(e.valores, {} as Record<Campo, number>)), hash: e.hash, eventoId: e.id });
    }
    const fatias = fatiar([...ops.values()], poc.lancamentos_por_arquivo);
    if (!fatias.length) fatias.push({ operacoes: [], lancamentos: 0 });
    const arquivos = gravarArquivos(poc, { id: s.id, tipo: 'solicitação manual', dia, inicial: `${ini} 00:00:00`, final: `${fim} 23:59:59`, geradoEm: `${seguinte} 01:30:00` }, fatias);
    executar("UPDATE solicitacoes SET situacao = 'GERADA', validade = ?, qtd_oper = ?, atualizado_em = ? WHERE id = ?",
      `${somarDias(seguinte, VALIDADE_DIAS)}T01:30:00Z`, ops.size, agora(), s.id);
    return { dia, tipo: 'MANUAL' as const, solicitacaoId: s.id, idSolic: s.numero, periodo: [ini, fim] as [string, string], arquivos, operacoes: ops.size, lancamentos: evs.length };
  });
}

// Link vencido sem download: a solicitação expira e o evento conta como não recebido (seção 11), a não ser que outro
// arquivo ainda válido também o leve (o Manual que repete o Delta).
function expirar(pocId: string, dia: string): void {
  const vencidas = todos<{ id: string }>("SELECT id FROM solicitacoes WHERE poc_id = ? AND situacao IN ('GERADA', 'ENVIADA') AND substr(validade, 1, 10) < ?", pocId, dia);
  for (const s of vencidas) {
    executar("UPDATE solicitacoes SET situacao = 'EXPIRADA', atualizado_em = ? WHERE id = ?", agora(), s.id);
    executar(
      `UPDATE eventos SET situacao = 'nao_recebido', motivo = 'O arquivo expirou sem download.', atualizado_em = ?
        WHERE id IN (SELECT ae.evento_id FROM ibs_arquivo_eventos ae JOIN arquivos a ON a.id = ae.arquivo_id WHERE a.solicitacao_id = ?)
          AND situacao IN ('disponivel', 'avisado')
          AND NOT EXISTS (SELECT 1 FROM ibs_arquivo_eventos o JOIN arquivos oa ON oa.id = o.arquivo_id JOIN solicitacoes os ON os.id = oa.solicitacao_id
                           WHERE o.evento_id = eventos.id AND os.id <> ? AND os.situacao IN ('GERADA', 'ENVIADA'))`,
      agora(), s.id, s.id,
    );
  }
}

// Um comando de cada vez por POC: dois "fechar o dia" ao mesmo tempo não processam o mesmo dia duas vezes.
const filas = new Map<string, Promise<unknown>>();

export interface ProcessamentoCbsAvisado extends ProcessamentoCbs { avisos: ResultadoAviso[] }

// processados é o IBS (o Delta de cada dia com lançamentos e os Arquivos Manuais gerados); cbs, os dias em que a base
// da Receita Federal emulada mudou.
export function fecharDia(pocId: string, ate?: string): Promise<{ dia: string; processados: Processamento[]; cbs: ProcessamentoCbsAvisado[]; diasFechados: number }> {
  const anterior = filas.get(pocId) ?? Promise.resolve();
  const atual = anterior.catch(() => undefined).then(async () => {
    const poc = obterPoc(pocId);
    const alvo = ate ?? poc.dia;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(alvo)) throw new ErroHttp(400, 'Use a data no formato AAAA-MM-DD.');
    if (alvo < poc.dia) throw new ErroHttp(409, `O relógio já está em ${poc.dia}; ele não volta.`);
    if (alvo > somarDias(poc.dia, MAX_DIAS_POR_COMANDO)) throw new ErroHttp(400, `Feche no máximo ${MAX_DIAS_POR_COMANDO} dias por comando.`);
    const processados: Processamento[] = [];
    const cbs: ProcessamentoCbsAvisado[] = [];
    let dias = 0;
    for (let dia = poc.dia; dia <= alvo; dia = somarDias(dia, 1)) {
      const r = processarDia(pocId, dia);
      if (r === undefined) continue;
      dias++;
      expirar(pocId, somarDias(dia, 1));
      expirarTiquetes(pocId, somarDias(dia, 1));
      for (const p of [r.ibs, ...r.manuais]) {
        if (!p) continue;
        if (p.solicitacaoId) p.aviso = await avisarSolicitacao(pocId, p.solicitacaoId);
        processados.push(p);
      }
      if (r.cbs) {
        // Aviso sem pedido (D-MG-03): um por endpoint que mudou, na urlRetorno validada da POC.
        const avisos: ResultadoAviso[] = [];
        for (const t of r.cbs.tiquetes) avisos.push(await avisarTiquete(pocId, t.id));
        cbs.push({ ...r.cbs, avisos });
      }
    }
    return { dia: obterPoc(pocId).dia, processados, cbs, diasFechados: dias };
  });
  filas.set(pocId, atual);
  return atual.finally(() => { if (filas.get(pocId) === atual) filas.delete(pocId); });
}

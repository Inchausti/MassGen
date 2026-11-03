// Relógio da POC e Processamento Diário do IBS emulado (proposta v4.3, seção 10). Fechar um dia simulado põe os
// lançamentos do dia no Arquivo Diferencial (Delta), abre a solicitação DIFERENCIAL e avisa o webhook do SplitHub.
import { createHash } from 'node:crypto';
import { agora, executar, json, novoId, todos, transacao, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { cabecalhoOperacao, fatiar, hashExtrato, linhaMoc, montarArquivo, nomeBase, zipDoArquivo, type OperacaoDoDia } from './arquivo-ibs.ts';
import { avisarSolicitacao, type ResultadoAviso } from '../entes/ibs.ts';
import { obterPoc, somarDias, type NotaRow } from './execucao.ts';
import type { Campo } from './catalogo.ts';

const VALIDADE_DIAS = 90;
const MAX_DIAS_POR_COMANDO = 62;

interface Fila { id: string; nota_id: string; tipo: string; valores: string; ordem: number }

export interface Processamento { dia: string; solicitacaoId: string; idSolic: number; arquivos: { id: string; idArq: number; nome: string; lancamentos: number }[]; operacoes: number; lancamentos: number; aviso?: ResultadoAviso }

// Um dia: lançamentos, hash, arquivos e solicitação, numa transação. Avança o relógio para o dia seguinte.
function processarDia(pocId: string, dia: string): Processamento | null | undefined {
  return transacao(() => {
    const poc = obterPoc(pocId);
    if (poc.dia !== dia) return undefined; // outro comando já fechou este dia
    const seguinte = somarDias(dia, 1);
    executar('UPDATE pocs SET dia = ?, atualizado_em = ? WHERE id = ?', seguinte, agora(), poc.id);
    const fila = todos<Fila>("SELECT id, nota_id, tipo, valores, ordem FROM eventos WHERE poc_id = ? AND ente = 'ibs' AND situacao = 'planejado' AND dia <= ? ORDER BY dia, ordem", poc.id, dia);
    if (!fila.length) return null;
    let lancamento = um<{ n: number }>('SELECT COALESCE(MAX(lancamento_id), 70000000) AS n FROM eventos WHERE poc_id = ?', poc.id)!.n;
    const ops = new Map<string, OperacaoDoDia & { hash: string | null }>();
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
        op = { cabecalho: cabecalhoOperacao(nota as NotaRow & { operacao_id: number }), linhas: [], hash: anterior?.hash ?? null };
        ops.set(ev.nota_id, op);
      }
      const minutos = Math.min(9 * 60 + i, 23 * 60 + 59);
      const dth = `${dia} ${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}:00.000 -03:00`;
      const linha = linhaMoc(++lancamento, dth, ev.tipo, json<Record<Campo, number>>(ev.valores, {} as Record<Campo, number>));
      op.hash = hashExtrato(op.hash, linha);
      op.linhas.push({ linha, hash: op.hash, eventoId: ev.id });
      executar('UPDATE eventos SET lancamento_id = ?, dth_lancto = ?, hash = ?, dia = ? WHERE id = ?', lancamento, dth, op.hash, dia, ev.id);
    });
    const numero = um<{ n: number }>("SELECT COALESCE(MAX(numero), 9000) + 1 AS n FROM solicitacoes WHERE poc_id = ? AND ente = 'ibs'", poc.id)!.n;
    const solicitacaoId = novoId('sol');
    const dataSolic = `${seguinte}T01:30:00Z`;
    executar(
      `INSERT INTO solicitacoes (id, poc_id, ente, numero, tipo, situacao, dia, data_solic, trans_ini, trans_fim, validade, qtd_oper, criado_em, atualizado_em)
       VALUES (?, ?, 'ibs', ?, 'DIFERENCIAL', 'GERADA', ?, ?, ?, ?, ?, ?, ?, ?)`,
      solicitacaoId, poc.id, numero, dia, dataSolic, `${dia}T00:00:00Z`, `${dia}T23:59:59.999Z`, `${somarDias(seguinte, VALIDADE_DIAS)}T01:30:00Z`, ops.size, agora(), agora(),
    );
    let idArq = um<{ n: number }>("SELECT COALESCE(MAX(numero), 1000) AS n FROM arquivos WHERE poc_id = ? AND ente = 'ibs'", poc.id)!.n;
    const geradoEm = `${seguinte} 01:30:00`;
    const arquivos: Processamento['arquivos'] = [];
    fatiar([...ops.values()], poc.lancamentos_por_arquivo).forEach((f, i) => {
      const base = nomeBase(dia, ++idArq, i + 1);
      const conteudo = JSON.stringify(montarArquivo(`${base}.json`, 'diferencial(delta)', geradoEm, `${dia} 00:00:00`, `${dia} 23:59:59`, f), null, 2);
      const zip = zipDoArquivo(`${base}.zip`, conteudo, geradoEm);
      const id = novoId('arq');
      executar(
        `INSERT INTO arquivos (id, poc_id, ente, solicitacao_id, numero, parte, nome, conteudo, hash, tamanho, qtd_operacoes, qtd_lancamentos, gerado_em)
         VALUES (?, ?, 'ibs', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, poc.id, solicitacaoId, idArq, i + 1, `${base}.zip`, conteudo, createHash('sha256').update(zip).digest('hex'), zip.length, f.operacoes.length, f.lancamentos, geradoEm,
      );
      const eventos = f.operacoes.flatMap((o) => o.eventos);
      executar(`UPDATE eventos SET arquivo_id = ?, situacao = 'disponivel', atualizado_em = ? WHERE id IN (${eventos.map(() => '?').join(', ')})`, id, agora(), ...eventos);
      arquivos.push({ id, idArq, nome: `${base}.zip`, lancamentos: f.lancamentos });
    });
    return { dia, solicitacaoId, idSolic: numero, arquivos, operacoes: ops.size, lancamentos: fila.length };
  });
}

// Link vencido sem download: a solicitação expira e o evento conta como não recebido (seção 11).
function expirar(pocId: string, dia: string): void {
  const vencidas = todos<{ id: string }>("SELECT id FROM solicitacoes WHERE poc_id = ? AND situacao IN ('GERADA', 'ENVIADA') AND substr(validade, 1, 10) < ?", pocId, dia);
  for (const s of vencidas) {
    executar("UPDATE solicitacoes SET situacao = 'EXPIRADA', atualizado_em = ? WHERE id = ?", agora(), s.id);
    executar("UPDATE eventos SET situacao = 'nao_recebido', motivo = 'O arquivo expirou sem download.', atualizado_em = ? WHERE arquivo_id IN (SELECT id FROM arquivos WHERE solicitacao_id = ?) AND situacao IN ('disponivel', 'avisado')", agora(), s.id);
  }
}

// Um comando de cada vez por POC: dois "fechar o dia" ao mesmo tempo não processam o mesmo dia duas vezes.
const filas = new Map<string, Promise<unknown>>();

export function fecharDia(pocId: string, ate?: string): Promise<{ dia: string; processados: Processamento[]; diasFechados: number }> {
  const anterior = filas.get(pocId) ?? Promise.resolve();
  const atual = anterior.catch(() => undefined).then(async () => {
    const poc = obterPoc(pocId);
    const alvo = ate ?? poc.dia;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(alvo)) throw new ErroHttp(400, 'Use a data no formato AAAA-MM-DD.');
    if (alvo < poc.dia) throw new ErroHttp(409, `O relógio já está em ${poc.dia}; ele não volta.`);
    if (alvo > somarDias(poc.dia, MAX_DIAS_POR_COMANDO)) throw new ErroHttp(400, `Feche no máximo ${MAX_DIAS_POR_COMANDO} dias por comando.`);
    const processados: Processamento[] = [];
    let dias = 0;
    for (let dia = poc.dia; dia <= alvo; dia = somarDias(dia, 1)) {
      const r = processarDia(pocId, dia);
      if (r === undefined) continue;
      dias++;
      expirar(pocId, somarDias(dia, 1));
      if (r) {
        r.aviso = await avisarSolicitacao(pocId, r.solicitacaoId);
        processados.push(r);
      }
    }
    return { dia: obterPoc(pocId).dia, processados, diasFechados: dias };
  });
  filas.set(pocId, atual);
  return atual.finally(() => { if (filas.get(pocId) === atual) filas.delete(pocId); });
}

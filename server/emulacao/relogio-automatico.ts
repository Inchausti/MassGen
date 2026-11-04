// Relógio automático da POC (proposta v4.3, seção 10; D-MG-07): "o relógio da POC avança por comando ou a cada intervalo
// configurado, e o envio acompanha o relógio". Cada passo é o Fechar o dia, nos dois entes, com a defasagem da CBS, os
// casos armados e os avisos. Um passo fecha um dia só: o link da CBS vale 48 horas no relógio, e um dia por intervalo dá
// ao SplitHub o intervalo inteiro para baixar. O estado fica no banco: na subida do servidor o agendamento volta, e o dia
// que já fechou não fecha de novo (dia_alvo).
import { agora, executar, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { MAQUINA, auditar, contexto, usuarioAtual, type ContextoUso } from '../auditoria.ts';
import { config } from '../config.ts';
import { auditarFechamento, contarFechamento, fecharDiaEsperado, type Fechamento } from './relogio.ts';
import { diaBr, obterPoc } from './execucao.ts';

export const INTERVALO_MAX_SEG = 24 * 3600;
// Na subida, o passo que venceu com o servidor fora sai logo, um só: os intervalos perdidos não viram dias fechados de uma vez.
const ESPERA_NA_SUBIDA_MS = 1000;

interface RelogioRow {
  poc_id: string; estado: 'rodando' | 'pausado'; intervalo_seg: number; parar_em: string | null; dia_alvo: string; proximo_em: string | null;
  passos: number; ultimo_passo_em: string | null; ultimo_resumo: string | null; ligado_por: string | null; ligado_em: string | null;
  pausado_por: string | null; pausado_em: string | null; motivo: string | null; atualizado_em: string;
}

const linha = (pocId: string) => um<RelogioRow>('SELECT * FROM relogios WHERE poc_id = ?', pocId);
const timers = new Map<string, NodeJS.Timeout>();
const andamento = new Set<string>();
const daqui = (ms: number) => new Date(Date.now() + ms).toISOString();

export function duracao(seg: number): string {
  if (seg >= 3600 && seg % 3600 === 0) return `${seg / 3600} h`;
  if (seg >= 60 && seg % 60 === 0) return `${seg / 60} min`;
  return seg > 60 ? `${Math.floor(seg / 60)} min ${seg % 60} s` : `${seg} s`;
}

const limites = () => ({ minSeg: config.relogioMinSeg, maxSeg: INTERVALO_MAX_SEG });

export interface RelogioLigado {
  estado: 'rodando' | 'pausado'; intervaloSeg: number; pararEm: string | null; diaAlvo: string; proximoEm: string | null; emAndamento: boolean;
  passos: number; ultimoPassoEm: string | null; ultimoResumo: string | null; ligadoPor: string | null; ligadoEm: string | null;
  pausadoPor: string | null; pausadoEm: string | null; motivo: string | null; limites: { minSeg: number; maxSeg: number };
}

function visao(r: RelogioRow): RelogioLigado {
  return {
    estado: r.estado, intervaloSeg: r.intervalo_seg, pararEm: r.parar_em, diaAlvo: r.dia_alvo, proximoEm: r.estado === 'rodando' ? r.proximo_em : null,
    emAndamento: andamento.has(r.poc_id), passos: r.passos, ultimoPassoEm: r.ultimo_passo_em, ultimoResumo: r.ultimo_resumo,
    ligadoPor: r.ligado_por, ligadoEm: r.ligado_em, pausadoPor: r.pausado_por, pausadoEm: r.pausado_em, motivo: r.motivo, limites: limites(),
  };
}
const ligado = (pocId: string) => visao(linha(pocId)!);

// O que a tela mostra: desligado (nunca ligado), rodando ou pausado, com o próximo passo e o dia que ele fecha.
export function estadoRelogio(pocId: string): RelogioLigado | { estado: 'desligado'; limites: { minSeg: number; maxSeg: number } } {
  const r = linha(pocId);
  return r ? visao(r) : { estado: 'desligado', limites: limites() };
}

export interface OpcoesRelogio { intervaloSeg?: unknown; pararEm?: unknown }

// O intervalo é em segundos reais por dia simulado; a data de parada é o último dia que o relógio fecha sozinho (vazia: sem parada).
function lerOpcoes(dia: string, o: OpcoesRelogio, atual?: RelogioRow): { intervaloSeg: number; pararEm: string | null } {
  const vazio = (v: unknown) => v === undefined || v === null || v === '';
  const bruto = vazio(o.intervaloSeg) ? atual?.intervalo_seg : Number(o.intervaloSeg);
  if (bruto === undefined) throw new ErroHttp(400, 'Informe o intervalo: quantos segundos reais valem um dia simulado.');
  const intervaloSeg = Math.round(bruto);
  if (!Number.isFinite(intervaloSeg) || intervaloSeg < config.relogioMinSeg || intervaloSeg > INTERVALO_MAX_SEG) {
    throw new ErroHttp(400, `O intervalo vai de ${duracao(config.relogioMinSeg)} a ${duracao(INTERVALO_MAX_SEG)} por dia simulado.`);
  }
  const pararEm = o.pararEm === undefined ? atual?.parar_em ?? null : vazio(o.pararEm) ? null : String(o.pararEm);
  if (pararEm !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pararEm) || Number.isNaN(Date.parse(pararEm))) throw new ErroHttp(400, 'Use a data de parada no formato AAAA-MM-DD.');
    if (pararEm < dia) throw new ErroHttp(400, `O relógio já está em ${diaBr(dia)}; a data de parada não pode vir antes.`);
  }
  return { intervaloSeg, pararEm };
}

// ---------------------------------------------------------------- comandos (quem ligou, pausou e retomou fica na trilha)

export function ligar(pocId: string, o: OpcoesRelogio, usuario: string) {
  const poc = obterPoc(pocId);
  if (linha(pocId)) throw new ErroHttp(409, 'O relógio automático desta POC já foi ligado. Pause ou retome.');
  const { intervaloSeg, pararEm } = lerOpcoes(poc.dia, o);
  // O primeiro passo vem depois de um intervalo inteiro: ligar não fecha o dia na hora.
  executar(
    `INSERT INTO relogios (poc_id, estado, intervalo_seg, parar_em, dia_alvo, proximo_em, ligado_por, ligado_em, atualizado_em)
     VALUES (?, 'rodando', ?, ?, ?, ?, ?, ?, ?)`,
    pocId, intervaloSeg, pararEm, poc.dia, daqui(intervaloSeg * 1000), usuario, agora(), agora(),
  );
  agendar(pocId);
  return ligado(pocId);
}

export function pausar(pocId: string, usuario: string) {
  obterPoc(pocId);
  const r = linha(pocId);
  if (!r || r.estado !== 'rodando') throw new ErroHttp(409, 'O relógio automático desta POC não está rodando.');
  // Um passo em andamento termina (o dia dele fecha inteiro, com os avisos); o seguinte não sai.
  executar("UPDATE relogios SET estado = 'pausado', proximo_em = NULL, pausado_por = ?, pausado_em = ?, motivo = NULL, atualizado_em = ? WHERE poc_id = ?",
    usuario, agora(), agora(), pocId);
  desarmar(pocId);
  return ligado(pocId);
}

export function retomar(pocId: string, o: OpcoesRelogio, usuario: string) {
  const poc = obterPoc(pocId);
  const r = linha(pocId);
  if (!r) throw new ErroHttp(409, 'O relógio automático desta POC ainda não foi ligado.');
  if (r.estado === 'rodando') throw new ErroHttp(409, 'O relógio automático desta POC já está rodando.');
  const { intervaloSeg, pararEm } = lerOpcoes(poc.dia, o, r);
  executar(
    `UPDATE relogios SET estado = 'rodando', intervalo_seg = ?, parar_em = ?, dia_alvo = ?, proximo_em = ?, ligado_por = ?, ligado_em = ?, motivo = NULL, atualizado_em = ?
      WHERE poc_id = ?`,
    intervaloSeg, pararEm, poc.dia, daqui(intervaloSeg * 1000), usuario, agora(), agora(), pocId,
  );
  agendar(pocId);
  return ligado(pocId);
}

// Muda o intervalo ou a data de parada. Rodando, o próximo passo conta o intervalo novo a partir do último.
export function configurar(pocId: string, o: OpcoesRelogio) {
  const poc = obterPoc(pocId);
  const r = linha(pocId);
  if (!r) throw new ErroHttp(409, 'Ligue o relógio automático primeiro.');
  const { intervaloSeg, pararEm } = lerOpcoes(poc.dia, o, r);
  let proximo = r.proximo_em;
  if (r.estado === 'rodando' && proximo && intervaloSeg !== r.intervalo_seg) {
    const inicio = Date.parse(proximo) - r.intervalo_seg * 1000;
    proximo = new Date(Math.max(Date.now(), inicio + intervaloSeg * 1000)).toISOString();
  }
  executar('UPDATE relogios SET intervalo_seg = ?, parar_em = ?, proximo_em = ?, atualizado_em = ? WHERE poc_id = ?', intervaloSeg, pararEm, proximo, agora(), pocId);
  if (r.estado === 'rodando') agendar(pocId);
  return { antes: { intervaloSeg: r.intervalo_seg, pararEm: r.parar_em }, relogio: ligado(pocId) };
}

// A POC apagada leva a linha junto (ON DELETE CASCADE); aqui sai o timer.
export const esquecer = (pocId: string) => desarmar(pocId);

// ---------------------------------------------------------------- o passo

function desarmar(pocId: string): void {
  clearTimeout(timers.get(pocId));
  timers.delete(pocId);
}

function agendar(pocId: string): void {
  desarmar(pocId);
  const r = linha(pocId);
  if (!r || r.estado !== 'rodando' || !r.proximo_em) return;
  const espera = Math.min(Math.max(0, Date.parse(r.proximo_em) - Date.now()), 2 ** 31 - 1);
  const t = setTimeout(() => { passo(pocId).catch((e) => console.error(`Relógio automático da POC ${pocId}:`, e)); }, espera);
  t.unref();
  timers.set(pocId, t);
}

function pausarSozinho(pocId: string, motivo: string): void {
  const r = linha(pocId);
  if (!r || r.estado !== 'rodando') return;
  executar("UPDATE relogios SET estado = 'pausado', proximo_em = NULL, pausado_por = ?, pausado_em = ?, motivo = ?, atualizado_em = ? WHERE poc_id = ?",
    usuarioAtual().usuario, agora(), motivo, agora(), pocId);
  desarmar(pocId);
  const poc = obterPoc(pocId);
  auditar('poc.relogio_auto', `Relógio automático da POC ${poc.nome} pausou sozinho: ${motivo}`, { alvoTipo: 'poc', alvoId: pocId, detalhes: { acao: 'pausar', motivo, dia: poc.dia } });
}

function resumoDoPasso(dia: string, f: Fechamento): string {
  const { deltas, manuais, tiquetes } = contarFechamento(f);
  if (!f.processados.length && !f.cbs.length) return `Fechou ${diaBr(dia)}, sem evento planejado.`;
  return `Fechou ${diaBr(dia)}: ${deltas} Delta(s) e ${manuais} Arquivo(s) Manual(is) do IBS, ${tiquetes} aviso(s) sem pedido da CBS.`;
}

async function executarPasso(pocId: string, r: RelogioRow): Promise<void> {
  const poc = obterPoc(pocId);
  if (r.parar_em && poc.dia > r.parar_em) return pausarSozinho(pocId, `chegou ao dia de parada (${diaBr(r.parar_em)})`);
  const f = poc.dia === r.dia_alvo ? await fecharDiaEsperado(pocId, r.dia_alvo) : null;
  const depois = obterPoc(pocId).dia;
  const atual = linha(pocId);
  if (!atual) return;
  // Rodando, o próximo passo espera o intervalo inteiro depois deste. Pausado no meio, fica sem próximo.
  const proximo = atual.estado === 'rodando' ? daqui(atual.intervalo_seg * 1000) : null;
  if (f) {
    auditarFechamento(pocId, r.dia_alvo, f, { intervaloSeg: atual.intervalo_seg });
    executar('UPDATE relogios SET dia_alvo = ?, passos = passos + 1, ultimo_passo_em = ?, ultimo_resumo = ?, proximo_em = ?, atualizado_em = ? WHERE poc_id = ?',
      depois, agora(), resumoDoPasso(r.dia_alvo, f), proximo, agora(), pocId);
  } else {
    // O dia esperado já tinha fechado: por comando (Fechar o dia, Fechar até, Executar e enviar) ou antes de o servidor
    // cair. Nada fecha de novo; o passo conta como dado e o seguinte fecha o dia em que o relógio está.
    executar('UPDATE relogios SET dia_alvo = ?, ultimo_resumo = ?, proximo_em = ?, atualizado_em = ? WHERE poc_id = ?',
      depois, `O dia ${diaBr(r.dia_alvo)} já tinha fechado; nada fechou de novo. O próximo passo fecha ${diaBr(depois)}.`, proximo, agora(), pocId);
  }
  if (atual.estado === 'rodando' && atual.parar_em && depois > atual.parar_em) pausarSozinho(pocId, `chegou ao dia de parada (${diaBr(atual.parar_em)})`);
}

async function passo(pocId: string): Promise<void> {
  timers.delete(pocId);
  // Um passo de cada vez: o que está em andamento agenda o seguinte quando termina.
  if (andamento.has(pocId)) return;
  const r = linha(pocId);
  if (!r || r.estado !== 'rodando') return;
  andamento.add(pocId);
  // O passo age em nome do relógio, e a trilha diz quem o ligou.
  const quem: ContextoUso = { usuario: `relógio automático (ligado por ${r.ligado_por ?? 'desconhecido'})`, maquina: MAQUINA, origem: 'sistema' };
  let parado = false;
  try {
    await contexto.run(quem, () => executarPasso(pocId, r));
  } catch (e) {
    // POC apagada no meio do passo: a linha saiu junto e não há o que pausar. Fora isso, o relógio para e diz por quê.
    if (linha(pocId)) {
      console.error(`Relógio automático da POC ${pocId}:`, e);
      try {
        contexto.run(quem, () => pausarSozinho(pocId, `o passo falhou (${(e as Error).message})`));
      } catch (e2) {
        parado = true; // nem a pausa gravou: sem novo agendamento, para não repetir a falha sem parar
        console.error(`Relógio automático da POC ${pocId}: a pausa também falhou:`, e2);
      }
    }
  } finally {
    andamento.delete(pocId);
    if (!parado) agendar(pocId);
  }
}

// Na subida do servidor, depois de ele escutar (o SplitHub baixa daqui o que o passo avisa): cada relógio rodando volta
// ao agendamento. O passo vencido sai uma vez só, e o dia_alvo impede de fechar outra vez o dia que fechou antes da queda.
export function retomarNaSubida(): number {
  const rodando = todos<RelogioRow>("SELECT * FROM relogios WHERE estado = 'rodando'");
  for (const r of rodando) {
    const venceu = !r.proximo_em || Date.parse(r.proximo_em) <= Date.now();
    const proximo = venceu ? daqui(ESPERA_NA_SUBIDA_MS) : r.proximo_em!;
    if (venceu) executar('UPDATE relogios SET proximo_em = ?, atualizado_em = ? WHERE poc_id = ?', proximo, agora(), r.poc_id);
    const poc = obterPoc(r.poc_id);
    auditar('poc.relogio_auto', `Relógio automático da POC ${poc.nome} retomado na subida do servidor: ${venceu ? 'o passo vencido sai agora, um só' : 'o próximo passo mantém a hora'}`, {
      alvoTipo: 'poc', alvoId: r.poc_id, detalhes: { acao: 'subida', proximoEm: proximo, diaAlvo: r.dia_alvo, dia: poc.dia, jaFechado: poc.dia !== r.dia_alvo, intervaloSeg: r.intervalo_seg },
    });
    agendar(r.poc_id);
  }
  return rodando.length;
}

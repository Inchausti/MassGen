// Roteiros (proposta v4.3, seção 08). Cada passo fica planejado num dia simulado, a partir do dia corrente, e sai quando o
// relógio fecha aquele dia. Cada ente anda no seu tempo (seção 10): a defasagem da CBS, em dias, empurra a CBS para
// depois do IBS (positiva) ou o IBS para depois da CBS (negativa). O plano automático de cobertura (cobertura.ts) e a
// troca de roteiro de uma nota (D-MG-04) usam o mesmo planejamento.
import { executar, todos, transacao } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { ROTEIRO, ROTULO_RELACIONADA, TIPO_IBS, type Passo, type Relacionada, type Roteiro } from './catalogo.ts';
import { TIPO_CBS } from './catalogo-cbs.ts';
import {
  AUSENTE, CANCELAMENTO, ENTES, ausente, carregarEstado, gravarEventos, incluir, notaPorId, operacaoDe, registrarEnvio, relacionadasDe, rotuloNota, somarDias,
  type Bloqueio, type Contexto, type Ente, type Estado, type ItemPlano, type NotaRow, type PocRow,
} from './execucao.ts';
import { diaDe } from './xml.ts';

const temEventos = (docId: string, ente: Ente) =>
  todos<{ n: number }>("SELECT 1 AS n FROM eventos WHERE nota_id = ? AND ente = ? AND situacao <> 'substituido' LIMIT 1", docId, ente).length > 0;

export const DEFASAGEM_MAX = 30;
export const limitarDefasagem = (v: unknown, padrao: number) => {
  const n = v === undefined || v === null || v === '' ? padrao : Math.round(Number(v));
  if (!Number.isFinite(n)) throw new ErroHttp(400, 'A defasagem é um número inteiro de dias.');
  return Math.min(DEFASAGEM_MAX, Math.max(-DEFASAGEM_MAX, n));
};

const copiar = (e: Estado) => ({ saldos: { ...e.saldos }, ocorreu: new Map(e.ocorreu), acumulado: new Map(e.acumulado), porRel: new Map(e.porRel) });

// Os passos de um ente num documento. Cada passo cai no dia seguinte ao anterior, nunca antes do documento que o origina.
// continuar: a nota já tem história; o passo que não cabe mais (já aconteceu, sem saldo) fica de fora e o resto segue.
function planejarPassos(ente: Ente, doc: NotaRow, passos: Passo[], notaId: string, dia0: string, intervalo: number,
  ctxRel: { precisa?: Relacionada; relacionada?: NotaRow; preferida?: string }, continuar = false) {
  const ctx: Contexto = { dia: dia0, forcar: false, itens: [], bloqueios: [] };
  const e = carregarEstado(doc, '9999-12-31', ente);
  let dia = [dia0, diaDe(doc.emissao ?? undefined)].filter((d): d is string => !!d).sort().pop()!;
  let ok = true;
  const pulados: Bloqueio[] = [];
  passos.forEach((p, i) => {
    if (!ok) return;
    const t = ENTES[ente].tipo(p.tipo)!;
    const cancelamento = t.relacionada === 'cancelamento' || (t.relacionada === 'ajuste' && ctxRel.precisa === 'cancelamento');
    const desde = cancelamento ? diaDe(doc.cancelada_em ?? undefined) : t.relacionada ? diaDe(ctxRel.relacionada?.emissao ?? undefined) : undefined;
    if (i > 0) dia = somarDias(dia, intervalo);
    if (desde && desde > dia) dia = desde;
    ctx.dia = dia;
    const antes = { itens: ctx.itens.length, bloqueios: ctx.bloqueios.length, estado: copiar(e) };
    const r = incluir(ctx, e, notaId, { tipo: p.tipo, pct: p.pct }, 'roteiro', new Map(), ctxRel.preferida);
    if (!r && continuar) {
      pulados.push(...ctx.bloqueios.splice(antes.bloqueios));
      ctx.itens.length = antes.itens;
      Object.assign(e, antes.estado);
    } else ok = r;
  });
  return { ok, itens: ctx.itens, bloqueios: ctx.bloqueios, pulados };
}

export interface OpcoesRoteiro { inicio?: string; defasagem?: number; continuar?: boolean; incluirAusentes?: boolean }

export interface PlanoRoteiro { roteiro: Roteiro; intervalo: number; defasagem: number; inicio: string; itens: ItemPlano[]; bloqueios: Bloqueio[]; pulados: Bloqueio[] }

export function planejarRoteiro(poc: PocRow, notaIds: unknown, roteiroId: string, intervaloDias: unknown = 1, opcoes: OpcoesRoteiro = {}): PlanoRoteiro {
  const r = ROTEIRO.get(roteiroId);
  if (!r) throw new ErroHttp(400, `Roteiro desconhecido: ${roteiroId}.`);
  if (!Array.isArray(notaIds) || !notaIds.length) throw new ErroHttp(400, 'Marque pelo menos uma nota.');
  const intervalo = Math.min(30, Math.max(0, Math.round(Number(intervaloDias) || 0)));
  const defasagem = limitarDefasagem(opcoes.defasagem, poc.defasagem_cbs ?? 0);
  const inicio = opcoes.inicio && opcoes.inicio > poc.dia ? opcoes.inicio : poc.dia;
  const itens: ItemPlano[] = [];
  const bloqueios: Bloqueio[] = [];
  const pulados: Bloqueio[] = [];
  for (const id of new Set(notaIds.map(String))) {
    const nota = notaPorId(id);
    if (!nota || nota.poc_id !== poc.id) { bloqueios.push({ notaId: id, nota: id, motivo: 'nota não encontrada nesta POC' }); continue; }
    const { op, preferida, motivo } = operacaoDe(nota);
    const rot = rotuloNota(nota);
    if (!op) { bloqueios.push({ notaId: id, nota: rot, motivo: motivo! }); continue; }
    if (op.papel !== r.lado) { bloqueios.push({ notaId: id, nota: rot, motivo: `o ${r.id} é de nota ${r.lado === 'adquirente' ? 'de entrada' : 'de saída'}` }); continue; }
    if (!opcoes.incluirAusentes && ausente(nota, op)) { bloqueios.push({ notaId: id, nota: rot, motivo: AUSENTE }); continue; }
    const relacionadas = relacionadasDe(op);
    const relacionada = r.precisa === 'cancelamento' ? undefined
      : relacionadas.find((x) => x.id === preferida && x.finalidade === r.precisa) ?? relacionadas.find((x) => x.finalidade === r.precisa);
    if (r.precisa === 'cancelamento' && !op.cancelada_em) { bloqueios.push({ notaId: id, nota: rot, motivo: `falta ${ROTULO_RELACIONADA.cancelamento} desta nota no lote` }); continue; }
    if (r.precisa && r.precisa !== 'cancelamento' && !relacionada) { bloqueios.push({ notaId: id, nota: rot, motivo: `falta ${ROTULO_RELACIONADA[r.precisa]} no lote` }); continue; }
    const docCbs = r.cbsNaRelacionada ? relacionada! : op;
    if (!opcoes.continuar) {
      const jaTem = [r.ibs.length && temEventos(op.id, 'ibs') && 'no IBS', r.cbs.length && temEventos(docCbs.id, 'cbs') && 'na CBS'].filter(Boolean);
      if (jaTem.length) { bloqueios.push({ notaId: id, nota: rot, motivo: `a nota já tem eventos ${jaTem.join(' e ')}; use o envio sob demanda ou troque o roteiro` }); continue; }
    }
    // A história é uma só: se um ente não couber, a nota fica de fora inteira. Cada ente parte do seu dia.
    const base = [inicio, diaDe(op.emissao ?? undefined)].filter((d): d is string => !!d).sort().pop()!;
    const diaIbs = somarDias(base, Math.max(0, -defasagem));
    const diaCbs = somarDias(base, Math.max(0, defasagem));
    const rel = { precisa: r.precisa, relacionada, preferida: r.precisa === 'cancelamento' ? CANCELAMENTO : relacionada?.id ?? preferida };
    const partes = [
      r.ibs.length ? planejarPassos('ibs', op, r.ibs, id, diaIbs, intervalo, { ...rel, preferida: relacionada?.id ?? preferida }, opcoes.continuar) : undefined,
      r.cbs.length ? planejarPassos('cbs', docCbs, r.cbs, id, diaCbs, intervalo, r.cbsNaRelacionada ? {} : rel, opcoes.continuar) : undefined,
    ].filter((x) => !!x);
    if (partes.some((x) => !x.ok)) { bloqueios.push(...partes.flatMap((x) => x.bloqueios)); continue; }
    itens.push(...partes.flatMap((x) => x.itens));
    pulados.push(...partes.flatMap((x) => x.pulados));
  }
  return { roteiro: r, intervalo, defasagem, inicio, itens, bloqueios, pulados };
}

// Grava o roteiro já planejado: o envio (tipo roteiro), os eventos e o roteiro na nota. Sem transação própria: quem chama
// decide se grava (transacao) ou só mostra (simular).
export function gravarRoteiro(poc: PocRow, plano: Pick<PlanoRoteiro, 'roteiro' | 'itens' | 'bloqueios' | 'intervalo' | 'defasagem' | 'inicio'>, usuario: string, extra: Record<string, unknown> = {}) {
  const ops = [...new Set(plano.itens.map((i) => i.opId))];
  const r = plano.roteiro;
  const env = registrarEnvio(poc, {
    tipo: 'roteiro', roteiro: r.id, notaIds: ops, forcar: false, usuario,
    tipos: [...r.ibs.map((p) => TIPO_IBS.get(p.tipo)!.id), ...r.cbs.map((p) => TIPO_CBS.get(p.tipo)!.id)],
    resumo: {
      eventos: plano.itens.length, ibs: plano.itens.filter((i) => i.ente === 'ibs').length, cbs: plano.itens.filter((i) => i.ente === 'cbs').length,
      bloqueios: plano.bloqueios.length, notas: ops.length, intervalo: plano.intervalo, defasagem: plano.defasagem, inicio: plano.inicio, ...extra,
    },
  });
  gravarEventos(poc, plano.itens, { envioId: env.id, roteiro: r.id, usuario });
  for (const id of new Set(plano.itens.map((i) => i.notaId))) {
    const nota = notaPorId(id)!;
    executar('UPDATE notas SET roteiro = ? WHERE id = ?', r.id, nota.origem_id && (nota.finalidade === 'complementar' || nota.finalidade === 'devolucao') ? nota.origem_id : nota.id);
  }
  return { envio: env, itens: plano.itens, bloqueios: plano.bloqueios, ultimoDia: plano.itens.map((i) => i.dia).sort().pop() };
}

export function aplicarRoteiro(poc: PocRow, notaIds: unknown, roteiroId: string, intervaloDias: unknown, usuario: string, opcoes: OpcoesRoteiro = {}) {
  const plano = planejarRoteiro(poc, notaIds, roteiroId, intervaloDias ?? 1, opcoes);
  if (!plano.itens.length) throw new ErroHttp(422, 'Nenhuma nota pode seguir este roteiro.', plano.bloqueios.map((b) => `${b.nota}${b.id ? ` · ${b.id}` : ''}: ${b.motivo}`));
  return transacao(() => gravarRoteiro(poc, plano, usuario));
}

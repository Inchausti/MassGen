// Roteiros aplicados pelo operador (proposta v4.3, seção 08). Cada passo fica planejado num dia simulado, a partir do dia
// corrente, e sai quando o relógio fecha aquele dia. Os dois entes começam no mesmo dia e andam no mesmo passo; a
// defasagem entre eles e o plano automático de cobertura entram na etapa 3.
import { executar, todos, transacao } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { ROTEIRO, ROTULO_RELACIONADA, TIPO_IBS, type Passo, type Relacionada } from './catalogo.ts';
import { TIPO_CBS } from './catalogo-cbs.ts';
import {
  CANCELAMENTO, ENTES, carregarEstado, gravarEventos, incluir, notaPorId, operacaoDe, registrarEnvio, relacionadasDe, rotuloNota, somarDias,
  type Bloqueio, type Contexto, type Ente, type ItemPlano, type NotaRow, type PocRow,
} from './execucao.ts';
import { diaDe } from './xml.ts';

const temEventos = (docId: string, ente: Ente) =>
  todos<{ n: number }>("SELECT 1 AS n FROM eventos WHERE nota_id = ? AND ente = ? AND situacao <> 'substituido' LIMIT 1", docId, ente).length > 0;

// Os passos de um ente num documento. Cada passo cai no dia seguinte ao anterior, nunca antes do documento que o origina.
function planejarPassos(ente: Ente, doc: NotaRow, passos: Passo[], notaId: string, dia0: string, intervalo: number, ctxRel: { precisa?: Relacionada; relacionada?: NotaRow; preferida?: string }) {
  const ctx: Contexto = { dia: dia0, forcar: false, itens: [], bloqueios: [] };
  const e = carregarEstado(doc, '9999-12-31', ente);
  let dia = [dia0, diaDe(doc.emissao ?? undefined)].filter((d): d is string => !!d).sort().pop()!;
  let ok = true;
  passos.forEach((p, i) => {
    if (!ok) return;
    const t = ENTES[ente].tipo(p.tipo)!;
    const cancelamento = t.relacionada === 'cancelamento' || (t.relacionada === 'ajuste' && ctxRel.precisa === 'cancelamento');
    const desde = cancelamento ? diaDe(doc.cancelada_em ?? undefined) : t.relacionada ? diaDe(ctxRel.relacionada?.emissao ?? undefined) : undefined;
    if (i > 0) dia = somarDias(dia, intervalo);
    if (desde && desde > dia) dia = desde;
    ctx.dia = dia;
    ok = incluir(ctx, e, notaId, { tipo: p.tipo, pct: p.pct }, 'roteiro', new Map(), ctxRel.preferida);
  });
  return { ok, itens: ctx.itens, bloqueios: ctx.bloqueios };
}

export function planejarRoteiro(poc: PocRow, notaIds: unknown, roteiroId: string, intervaloDias = 1) {
  const r = ROTEIRO.get(roteiroId);
  if (!r) throw new ErroHttp(400, `Roteiro desconhecido: ${roteiroId}.`);
  if (!Array.isArray(notaIds) || !notaIds.length) throw new ErroHttp(400, 'Marque pelo menos uma nota.');
  const intervalo = Math.min(30, Math.max(0, Math.round(Number(intervaloDias) || 0)));
  const itens: ItemPlano[] = [];
  const bloqueios: Bloqueio[] = [];
  for (const id of new Set(notaIds.map(String))) {
    const nota = notaPorId(id);
    if (!nota || nota.poc_id !== poc.id) { bloqueios.push({ notaId: id, nota: id, motivo: 'nota não encontrada nesta POC' }); continue; }
    const { op, preferida, motivo } = operacaoDe(nota);
    const rot = rotuloNota(nota);
    if (!op) { bloqueios.push({ notaId: id, nota: rot, motivo: motivo! }); continue; }
    if (op.papel !== r.lado) { bloqueios.push({ notaId: id, nota: rot, motivo: `o ${r.id} é de nota ${r.lado === 'adquirente' ? 'de entrada' : 'de saída'}` }); continue; }
    const relacionadas = relacionadasDe(op);
    const relacionada = r.precisa === 'cancelamento' ? undefined
      : relacionadas.find((x) => x.id === preferida && x.finalidade === r.precisa) ?? relacionadas.find((x) => x.finalidade === r.precisa);
    if (r.precisa === 'cancelamento' && !op.cancelada_em) { bloqueios.push({ notaId: id, nota: rot, motivo: `falta ${ROTULO_RELACIONADA.cancelamento} desta nota no lote` }); continue; }
    if (r.precisa && r.precisa !== 'cancelamento' && !relacionada) { bloqueios.push({ notaId: id, nota: rot, motivo: `falta ${ROTULO_RELACIONADA[r.precisa]} no lote` }); continue; }
    const docCbs = r.cbsNaRelacionada ? relacionada! : op;
    const jaTem = [r.ibs.length && temEventos(op.id, 'ibs') && 'no IBS', r.cbs.length && temEventos(docCbs.id, 'cbs') && 'na CBS'].filter(Boolean);
    if (jaTem.length) { bloqueios.push({ notaId: id, nota: rot, motivo: `a nota já tem eventos ${jaTem.join(' e ')}; use o envio sob demanda` }); continue; }
    // Os dois entes partem do mesmo dia: o corrente, ou a emissão, o que vier depois. A história é uma só: se um ente
    // não couber, a nota fica de fora inteira.
    const rel = { precisa: r.precisa, relacionada, preferida: r.precisa === 'cancelamento' ? CANCELAMENTO : relacionada?.id ?? preferida };
    const partes = [
      r.ibs.length ? planejarPassos('ibs', op, r.ibs, id, poc.dia, intervalo, { ...rel, preferida: relacionada?.id ?? preferida }) : undefined,
      r.cbs.length ? planejarPassos('cbs', docCbs, r.cbs, id, poc.dia, intervalo, r.cbsNaRelacionada ? {} : rel) : undefined,
    ].filter((x) => !!x);
    if (partes.some((x) => !x.ok)) { bloqueios.push(...partes.flatMap((x) => x.bloqueios)); continue; }
    itens.push(...partes.flatMap((x) => x.itens));
  }
  return { roteiro: r, intervalo, itens, bloqueios };
}

export function aplicarRoteiro(poc: PocRow, notaIds: unknown, roteiroId: string, intervaloDias: number | undefined, usuario: string) {
  const plano = planejarRoteiro(poc, notaIds, roteiroId, intervaloDias ?? 1);
  if (!plano.itens.length) throw new ErroHttp(422, 'Nenhuma nota pode seguir este roteiro.', plano.bloqueios.map((b) => `${b.nota}${b.id ? ` · ${b.id}` : ''}: ${b.motivo}`));
  return transacao(() => {
    const ops = [...new Set(plano.itens.map((i) => i.opId))];
    const r = plano.roteiro;
    const env = registrarEnvio(poc, {
      tipo: 'roteiro', roteiro: r.id, notaIds: ops, forcar: false, usuario,
      tipos: [...r.ibs.map((p) => TIPO_IBS.get(p.tipo)!.id), ...r.cbs.map((p) => TIPO_CBS.get(p.tipo)!.id)],
      resumo: { eventos: plano.itens.length, ibs: plano.itens.filter((i) => i.ente === 'ibs').length, cbs: plano.itens.filter((i) => i.ente === 'cbs').length, bloqueios: plano.bloqueios.length, notas: ops.length },
    });
    gravarEventos(poc, plano.itens, { envioId: env.id, roteiro: r.id, usuario });
    for (const op of new Set(plano.itens.map((i) => i.notaId))) {
      const nota = notaPorId(op)!;
      executar('UPDATE notas SET roteiro = ? WHERE id = ?', r.id, nota.origem_id && (nota.finalidade === 'complementar' || nota.finalidade === 'devolucao') ? nota.origem_id : nota.id);
    }
    return { envio: env, itens: plano.itens, bloqueios: plano.bloqueios, ultimoDia: plano.itens.map((i) => i.dia).sort().pop() };
  });
}

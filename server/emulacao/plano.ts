// Roteiros aplicados pelo operador (proposta v4.3, seção 08). Cada passo do IBS fica planejado num dia simulado, a partir
// do dia corrente, e sai quando o relógio fecha aquele dia. O plano automático de cobertura entra na etapa 3.
import { executar, todos, transacao } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { ROTEIRO, ROTULO_RELACIONADA, TIPO_IBS } from './catalogo.ts';
import {
  carregarEstado, gravarEventos, incluir, notaPorId, operacaoDe, registrarEnvio, rotuloNota, somarDias,
  type Bloqueio, type Contexto, type ItemPlano, type PocRow,
} from './execucao.ts';
import { diaDe } from './xml.ts';

export function planejarRoteiro(poc: PocRow, notaIds: unknown, roteiroId: string, intervaloDias = 1) {
  const r = ROTEIRO.get(roteiroId);
  if (!r) throw new ErroHttp(400, `Roteiro desconhecido: ${roteiroId}.`);
  if (!r.ibs.length) throw new ErroHttp(422, `O ${r.id} não tem eventos no IBS. A CBS entra na etapa 2.`);
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
    const jaTem = todos<{ n: number }>("SELECT 1 AS n FROM eventos WHERE nota_id = ? AND ente = 'ibs' AND situacao <> 'substituido' LIMIT 1", op.id).length > 0;
    if (jaTem) { bloqueios.push({ notaId: id, nota: rot, motivo: 'a nota já tem eventos no IBS; use o envio sob demanda' }); continue; }
    const e = carregarEstado(op, '9999-12-31');
    const relacionada = r.precisa === 'cancelamento' ? undefined
      : e.relacionadas.find((x) => x.id === preferida && x.finalidade === r.precisa) ?? e.relacionadas.find((x) => x.finalidade === r.precisa);
    if (r.precisa === 'cancelamento' && !op.cancelada_em) { bloqueios.push({ notaId: id, nota: rot, motivo: `falta ${ROTULO_RELACIONADA.cancelamento} desta nota no lote` }); continue; }
    if (r.precisa && r.precisa !== 'cancelamento' && !relacionada) { bloqueios.push({ notaId: id, nota: rot, motivo: `falta ${ROTULO_RELACIONADA[r.precisa]} no lote` }); continue; }
    // Cada passo cai no dia seguinte ao anterior, nunca antes do documento que o origina.
    const ctx: Contexto = { dia: poc.dia, forcar: false, itens: [], bloqueios: [] };
    let dia = [poc.dia, diaDe(op.emissao ?? undefined)].filter((d): d is string => !!d).sort().pop()!;
    let ok = true;
    r.ibs.forEach((p, i) => {
      if (!ok) return;
      const t = TIPO_IBS.get(p.tipo)!;
      const desde = t.relacionada === 'cancelamento' ? diaDe(op.cancelada_em ?? undefined) : t.relacionada ? diaDe(relacionada?.emissao ?? undefined) : undefined;
      if (i > 0) dia = somarDias(dia, intervalo);
      if (desde && desde > dia) dia = desde;
      ctx.dia = dia;
      ok = incluir(ctx, e, id, { tipo: p.tipo, pct: p.pct }, 'roteiro', new Map(), relacionada?.id ?? preferida);
    });
    if (!ok) { bloqueios.push(...ctx.bloqueios); continue; }
    itens.push(...ctx.itens);
  }
  return { roteiro: r, intervalo, itens, bloqueios };
}

export function aplicarRoteiro(poc: PocRow, notaIds: unknown, roteiroId: string, intervaloDias: number | undefined, usuario: string) {
  const plano = planejarRoteiro(poc, notaIds, roteiroId, intervaloDias ?? 1);
  if (!plano.itens.length) throw new ErroHttp(422, 'Nenhuma nota pode seguir este roteiro.', plano.bloqueios.map((b) => `${b.nota}: ${b.motivo}`));
  return transacao(() => {
    const ops = [...new Set(plano.itens.map((i) => i.opId))];
    const env = registrarEnvio(poc, {
      tipo: 'roteiro', roteiro: plano.roteiro.id, notaIds: ops, tipos: plano.roteiro.ibs.map((p) => TIPO_IBS.get(p.tipo)!.id), forcar: false, usuario,
      resumo: { eventos: plano.itens.length, bloqueios: plano.bloqueios.length, notas: ops.length },
    });
    gravarEventos(poc, plano.itens, { envioId: env.id, roteiro: plano.roteiro.id, usuario });
    for (const op of ops) executar('UPDATE notas SET roteiro = ? WHERE id = ?', plano.roteiro.id, op);
    return { envio: env, itens: plano.itens, bloqueios: plano.bloqueios, ultimoDia: plano.itens.map((i) => i.dia).sort().pop() };
  });
}

// Envio sob demanda (proposta v4.3, seção 09) e o motor que o valida: papel, nota relacionada, ordem e saldo.
// O mesmo motor monta os roteiros (plano.ts) e decide o que um envio manual substitui no que estava planejado.
import { agora, executar, json, novoId, todos, transacao, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { CAMPOS, ROTULO_RELACIONADA, TIPO_IBS, numeroIbs, type Base, type Campo, type TipoIbs } from './catalogo.ts';
import { diaDe } from './xml.ts';

export interface NotaRow {
  id: string; poc_id: string; chave: string; modelo: string | null; serie: string | null; numero: string | null; emissao: string | null; autorizacao: string | null;
  emit_cnpj: string | null; emit_nome: string | null; dest_doc: string | null; dest_nome: string | null; papel: string | null; finalidade: string | null;
  ref_chaves: string; origem_id: string | null; cancelada_em: string | null; v_ibs: number; v_ibs_uf: number; v_ibs_mun: number; v_cbs: number;
  situacao: string; motivo: string | null; operacao_id: number | null; roteiro: string | null;
}

export interface PocRow {
  id: string; nome: string; cnpj: string; cnpj_raiz: string; competencia: string; dia: string; ambiente_id: string | null; limites_relaxados: number;
  lancamentos_por_arquivo: number; ibs_client_id: string | null; ibs_secret_hash: string | null; ibs_habilitado_em: string | null; ibs_webhook_url: string | null;
  criado_por: string | null; criado_em: string; atualizado_em: string;
}

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const diaBr = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '—');
export function somarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function rotuloNota(n: Pick<NotaRow, 'modelo' | 'numero' | 'chave'>): string {
  const doc = n.modelo === '65' ? 'NFC-e' : 'NF-e';
  return n.numero ? `${doc} ${Number(n.numero).toLocaleString('pt-BR')}` : `${doc} …${n.chave.slice(-6)}`;
}

export function obterPoc(id: string): PocRow {
  const p = um<PocRow>('SELECT * FROM pocs WHERE id = ?', id);
  if (!p) throw new ErroHttp(404, 'POC não encontrada.');
  return p;
}

export const notaPorId = (id: string) => um<NotaRow>('SELECT * FROM notas WHERE id = ?', id);
const relacionadasDe = (op: NotaRow) => todos<NotaRow>("SELECT * FROM notas WHERE origem_id = ? AND situacao = 'aceita' ORDER BY emissao, numero", op.id);

// ---------------------------------------------------------------- estado da operação no ente emulado

export interface Estado {
  op: NotaRow;
  relacionadas: NotaRow[];
  saldos: Record<Campo, number>;
  ocorreu: Map<string, number>;
  acumulado: Map<string, number>;
  porRel: Map<string, number>; // `${relId}:${tipo}` → valor
}

const zerados = (): Record<Campo, number> => Object.fromEntries(CAMPOS.map((c) => [c.campo, 0])) as Record<Campo, number>;

function aplicar(e: Estado, tipo: string, valor: number, valores: Record<Campo, number>, relId?: string | null): void {
  for (const c of CAMPOS) e.saldos[c.campo] = r2(e.saldos[c.campo] + (valores[c.campo] ?? 0));
  e.ocorreu.set(tipo, (e.ocorreu.get(tipo) ?? 0) + 1);
  e.acumulado.set(tipo, r2((e.acumulado.get(tipo) ?? 0) + valor));
  if (relId) e.porRel.set(`${relId}:${tipo}`, r2((e.porRel.get(`${relId}:${tipo}`) ?? 0) + valor));
}

interface EventoRow { id: string; tipo: string; valor: number; valores: string; nota_rel_id: string | null; dia: string; ordem: number; situacao: string; forcado: number; origem: string; envio_id: string | null }

// Estado com os eventos que já aconteceram ou que saem até o dia informado (inclusive). Substituídos não contam.
export function carregarEstado(op: NotaRow, ateDia?: string): Estado {
  const e: Estado = { op, relacionadas: relacionadasDe(op), saldos: zerados(), ocorreu: new Map(), acumulado: new Map(), porRel: new Map() };
  const evs = todos<EventoRow>(
    `SELECT * FROM eventos WHERE nota_id = ? AND ente = 'ibs' AND situacao <> 'substituido' ${ateDia ? "AND (situacao <> 'planejado' OR dia <= ?)" : "AND situacao <> 'planejado'"} ORDER BY dia, ordem`,
    ...(ateDia ? [op.id, ateDia] : [op.id]));
  for (const ev of evs) aplicar(e, ev.tipo, ev.valor, json(ev.valores, zerados()), ev.nota_rel_id);
  return e;
}

function avaliar(b: Base, e: Estado, rel?: NotaRow): number {
  switch (b.de) {
    case 'nota': return e.op.v_ibs;
    case 'relacionada': return rel?.v_ibs ?? 0;
    case 'relacionada_menos': return rel ? r2(rel.v_ibs - b.tipos.reduce((s, t) => s + (e.porRel.get(`${rel.id}:${t}`) ?? 0), 0)) : 0;
    case 'saldo': return e.saldos[b.campo];
    case 'acumulado': return r2(b.tipos.reduce((s, t) => s + (e.acumulado.get(t) ?? 0), 0) - (b.menos ?? []).reduce((s, t) => s + (e.acumulado.get(t) ?? 0), 0));
    case 'menor': return Math.min(...b.bases.map((x) => avaliar(x, e, rel)));
    case 'zero': return 0;
  }
}

const RELACIONADA_FINALIDADE: Record<string, string> = { complementar: 'complementar', devolucao: 'devolucao' };

// A nota relacionada que o tipo usa: a preferida (quando o usuário marcou a própria complementar ou devolução) ou a primeira ainda livre.
function relacionadaPara(t: TipoIbs, e: Estado, preferida?: string): NotaRow | undefined {
  if (!t.relacionada || t.relacionada === 'cancelamento') return undefined;
  const livres = e.relacionadas.filter((r) => r.finalidade === RELACIONADA_FINALIDADE[t.relacionada!] && !(t.unico === 'relacionada' && e.porRel.has(`${r.id}:${t.n}`)));
  return livres.find((r) => r.id === preferida) ?? livres[0];
}

// O que impede o tipo de acontecer nesta operação, sem contar a ordem e o saldo. Nada: pode.
function impedimento(t: TipoIbs, e: Estado, preferida?: string): string | undefined {
  if (t.lado !== 'ambos' && t.lado !== e.op.papel) return t.lado === 'adquirente' ? 'só em nota de entrada (o cliente é o adquirente)' : 'só em nota de saída (o cliente é o fornecedor)';
  if (t.relacionada === 'cancelamento' && !e.op.cancelada_em) return `falta ${ROTULO_RELACIONADA.cancelamento} desta nota no lote`;
  if (t.relacionada && t.relacionada !== 'cancelamento' && !relacionadaPara(t, e, preferida)) {
    const ja = e.relacionadas.some((r) => r.finalidade === RELACIONADA_FINALIDADE[t.relacionada!]);
    return ja ? `${ROTULO_RELACIONADA[t.relacionada]} já foi usada neste tipo` : `falta ${ROTULO_RELACIONADA[t.relacionada]} no lote`;
  }
  return undefined;
}

const satisfeito = (alt: string[], e: Estado) => alt.every((x) => (e.ocorreu.get(x) ?? 0) > 0);

// ---------------------------------------------------------------- planejamento

export interface ItemPlano {
  notaId: string; opId: string; nota: string; relId?: string; relNota?: string;
  tipo: string; id: string; mov: string; valor: number; valores: Record<Campo, number>;
  origem: 'escolhido' | 'pre-requisito' | 'roteiro'; pct?: number; forcado: boolean; dia: string;
}
export interface Bloqueio { notaId: string; nota: string; tipo?: string; id?: string; motivo: string }

export interface PedidoTipo { tipo: string; pct?: number; valor?: number }

export interface Contexto {
  dia: string;
  forcar: boolean;
  itens: ItemPlano[];
  bloqueios: Bloqueio[];
}

// Inclui o tipo na operação, com os pré-requisitos que faltam antes (D-MG-13). Devolve false se não deu.
export function incluir(ctx: Contexto, e: Estado, notaId: string, pedido: PedidoTipo, origem: ItemPlano['origem'], escolhidos: Map<string, PedidoTipo>, preferida?: string, profundidade = 0): boolean {
  const t = TIPO_IBS.get(pedido.tipo)!;
  const rot = rotuloNota(e.op);
  const bloquear = (motivo: string) => { ctx.bloqueios.push({ notaId, nota: rot, tipo: t.n, id: t.id, motivo }); return false; };
  if (profundidade > 12) return bloquear('a cadeia de pré-requisitos não fecha');
  const imp = impedimento(t, e, preferida);
  if (imp) return bloquear(imp);
  if (t.unico === 'operacao' && (e.ocorreu.get(t.n) ?? 0) > 0 && !ctx.forcar) return bloquear('já aconteceu nesta nota');
  if (!ctx.forcar && t.precisa.length && !t.precisa.some((alt) => satisfeito(alt, e))) {
    // Primeiro uma alternativa cujo que falta o usuário também escolheu; depois a primeira que cabe nesta nota.
    const faltam = (alt: string[]) => alt.filter((x) => !(e.ocorreu.get(x) ?? 0));
    const cabe = (alt: string[]) => faltam(alt).every((x) => !impedimento(TIPO_IBS.get(x)!, e, preferida));
    const alt = t.precisa.find((a) => faltam(a).every((x) => escolhidos.has(x))) ?? t.precisa.find(cabe);
    if (!alt) return bloquear(`precisa antes de ${t.precisa.map((a) => a.map((x) => TIPO_IBS.get(x)!.id).join(' e ')).join(' ou ')}, que não cabe nesta nota`);
    for (const x of faltam(alt)) {
      const escolhido = escolhidos.get(x);
      const ok = incluir(ctx, e, notaId, escolhido ?? { tipo: x }, escolhido ? 'escolhido' : 'pre-requisito', escolhidos, preferida, profundidade + 1);
      if (escolhido) escolhidos.delete(x);
      if (!ok) return bloquear(`o pré-requisito ${TIPO_IBS.get(x)!.id} não pôde entrar`);
    }
  }
  const rel = relacionadaPara(t, e, preferida);
  // A data simulada não vem antes do documento que dá origem ao evento.
  const desde = [diaDe(e.op.emissao ?? undefined), diaDe(rel?.emissao ?? undefined), t.relacionada === 'cancelamento' ? diaDe(e.op.cancelada_em ?? undefined) : undefined]
    .filter((d): d is string => !!d).sort().pop();
  if (desde && desde > ctx.dia && !ctx.forcar) return bloquear(`o documento é de ${diaBr(desde)} e o relógio está em ${diaBr(ctx.dia)}; avance o relógio`);
  const base = avaliar(t.base, e, rel);
  let valor: number;
  if (t.base.de === 'zero') valor = 0;
  else if (pedido.valor !== undefined && pedido.valor !== null) valor = r2(Number(pedido.valor));
  else if (base <= 0 && ctx.forcar) valor = e.op.v_ibs;
  else valor = r2(base * (t.parcial && pedido.pct ? Math.min(100, Math.max(1, pedido.pct)) : 100) / 100);
  if (t.base.de !== 'zero' && !ctx.forcar) {
    if (base <= 0) return bloquear('sem saldo na operação para este tipo');
    if (valor <= 0) return bloquear('o valor precisa ser maior que zero');
    if (valor > base + 0.005) return bloquear(`o valor passa do saldo (${base.toLocaleString('pt-BR', { minimumFractionDigits: 2 })})`);
  }
  const valores = zerados();
  for (const c of CAMPOS) valores[c.campo] = r2((t.efeito[c.campo] ?? 0) * valor);
  aplicar(e, t.n, valor, valores, rel?.id);
  ctx.itens.push({
    notaId, opId: e.op.id, nota: rot, relId: rel?.id, relNota: rel ? rotuloNota(rel) : undefined, tipo: t.n, id: t.id, mov: t.mov, valor, valores,
    origem, pct: t.parcial ? pedido.pct : undefined, forcado: ctx.forcar, dia: ctx.dia,
  });
  return true;
}

// A operação de uma nota: a própria, ou a original, quando a nota é complementar ou de devolução.
export function operacaoDe(nota: NotaRow): { op?: NotaRow; preferida?: string; motivo?: string } {
  if (nota.situacao !== 'aceita') return { motivo: nota.motivo ?? 'a nota ficou de fora da POC' };
  if (nota.finalidade === 'complementar' || nota.finalidade === 'devolucao') {
    if (!nota.origem_id) return { motivo: 'a nota original não está no lote' };
    return { op: notaPorId(nota.origem_id), preferida: nota.id };
  }
  return { op: nota };
}

export function planejarEnvio(poc: PocRow, notaIds: unknown, tipos: unknown, forcar = false) {
  if (!Array.isArray(notaIds) || !notaIds.length) throw new ErroHttp(400, 'Marque pelo menos uma nota.');
  if (notaIds.length > 500) throw new ErroHttp(400, 'No máximo 500 notas por envio.');
  if (!Array.isArray(tipos) || !tipos.length) throw new ErroHttp(400, 'Marque pelo menos um tipo de evento.');
  const pedidos: PedidoTipo[] = [];
  for (const x of tipos as unknown[]) {
    const obj = (typeof x === 'object' && x ? x : { tipo: x }) as Record<string, unknown>;
    const n = numeroIbs(obj.tipo);
    if (!n) throw new ErroHttp(400, `Tipo de evento desconhecido: ${String(obj.tipo)}. Nesta etapa, só os do IBS (E-IBS-01 a E-IBS-24).`);
    if (pedidos.some((p) => p.tipo === n)) continue;
    pedidos.push({ tipo: n, pct: obj.pct === undefined || obj.pct === null || obj.pct === '' ? undefined : Number(obj.pct), valor: obj.valor === undefined || obj.valor === null || obj.valor === '' ? undefined : Number(obj.valor) });
  }
  pedidos.sort((a, b) => a.tipo.localeCompare(b.tipo));
  const ctx: Contexto = { dia: poc.dia, forcar, itens: [], bloqueios: [] };
  const estados = new Map<string, Estado>();
  for (const id of new Set(notaIds.map(String))) {
    const nota = notaPorId(id);
    if (!nota || nota.poc_id !== poc.id) { ctx.bloqueios.push({ notaId: id, nota: id, motivo: 'nota não encontrada nesta POC' }); continue; }
    const { op, preferida, motivo } = operacaoDe(nota);
    if (!op) { ctx.bloqueios.push({ notaId: id, nota: rotuloNota(nota), motivo: motivo! }); continue; }
    let e = estados.get(op.id);
    if (!e) estados.set(op.id, (e = carregarEstado(op, poc.dia)));
    const escolhidos = new Map(pedidos.map((p) => [p.tipo, p]));
    for (const p of pedidos) {
      if (!escolhidos.has(p.tipo)) continue; // já entrou como pré-requisito de outro escolhido
      escolhidos.delete(p.tipo);
      incluir(ctx, e, id, p, 'escolhido', escolhidos, preferida);
    }
  }
  return { dia: poc.dia, forcar, itens: ctx.itens, bloqueios: ctx.bloqueios };
}

// ---------------------------------------------------------------- gravação

const proximaOrdem = (pocId: string) => um<{ n: number }>('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM eventos WHERE poc_id = ?', pocId)!.n;
export const proximoEnvio = (pocId: string) => um<{ n: number }>('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM envios WHERE poc_id = ?', pocId)!.n;

export function gravarEventos(poc: PocRow, itens: ItemPlano[], extra: { envioId: string; roteiro?: string; usuario: string }): string[] {
  let ordem = proximaOrdem(poc.id);
  const ids: string[] = [];
  const quando = agora();
  for (const it of itens) {
    const id = novoId('ev');
    executar(
      `INSERT INTO eventos (id, poc_id, nota_id, nota_rel_id, ente, tipo, roteiro, origem, envio_id, forcado, dia, ordem, valor, valores, situacao, criado_por, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, 'ibs', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planejado', ?, ?, ?)`,
      id, poc.id, it.opId, it.relId ?? null, it.tipo, extra.roteiro ?? null, it.origem === 'pre-requisito' ? 'prerequisito' : it.origem === 'roteiro' ? 'roteiro' : 'manual',
      extra.envioId, it.forcado ? 1 : 0, it.dia, ordem++, it.valor, JSON.stringify(it.valores), extra.usuario, quando, quando,
    );
    ids.push(id);
  }
  return ids;
}

// Evento planejado que o envio manual tornou repetido ou impossível: "substituído" e não sai (seção 09, Plano).
export function substituirPlanejados(poc: PocRow, opIds: string[], envioNumero: number): number {
  let n = 0;
  for (const opId of new Set(opIds)) {
    const op = notaPorId(opId);
    if (!op) continue;
    const e = carregarEstado(op, poc.dia);
    const futuros = todos<EventoRow>("SELECT * FROM eventos WHERE nota_id = ? AND ente = 'ibs' AND situacao = 'planejado' AND dia > ? ORDER BY dia, ordem", opId, poc.dia);
    for (const ev of futuros) {
      const t = TIPO_IBS.get(ev.tipo)!;
      const rel = ev.nota_rel_id ? notaPorId(ev.nota_rel_id) : undefined;
      let motivo: string | undefined;
      if (!ev.forcado) {
        if (t.unico === 'operacao' && (e.ocorreu.get(t.n) ?? 0) > 0) motivo = 'já aconteceu pelo envio manual';
        else if (t.unico === 'relacionada' && rel && e.porRel.has(`${rel.id}:${t.n}`)) motivo = 'já aconteceu pelo envio manual';
        else if (t.precisa.length && !t.precisa.some((alt) => satisfeito(alt, e))) motivo = 'perdeu o pré-requisito';
        else if (t.base.de !== 'zero' && ev.valor > avaliar(t.base, e, rel) + 0.005) motivo = 'o saldo não comporta mais';
      }
      if (motivo) {
        executar("UPDATE eventos SET situacao = 'substituido', motivo = ?, atualizado_em = ? WHERE id = ?", `Substituído pelo envio manual nº ${envioNumero}: ${motivo}.`, agora(), ev.id);
        n++;
      } else aplicar(e, ev.tipo, ev.valor, json(ev.valores, zerados()), ev.nota_rel_id);
    }
  }
  return n;
}

export function registrarEnvio(poc: PocRow, dados: { tipo: 'manual' | 'roteiro'; roteiro?: string; notaIds: string[]; tipos: string[]; forcar: boolean; resumo: unknown; usuario: string }) {
  const id = novoId('env');
  const numero = proximoEnvio(poc.id);
  executar(
    'INSERT INTO envios (id, poc_id, numero, tipo, dia, roteiro, notas, tipos, forcar, resumo, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, poc.id, numero, dados.tipo, poc.dia, dados.roteiro ?? null, JSON.stringify(dados.notaIds), JSON.stringify(dados.tipos), dados.forcar ? 1 : 0,
    JSON.stringify(dados.resumo), dados.usuario, agora(),
  );
  return { id, numero };
}

// Grava o envio e os eventos. Quem chama fecha o dia na hora (D-MG-14).
export function gravarEnvioManual(poc: PocRow, plano: ReturnType<typeof planejarEnvio>, tipos: string[], notaIds: string[], usuario: string) {
  if (!plano.itens.length) throw new ErroHttp(422, 'Nenhum evento pode sair com essa escolha.', plano.bloqueios.map((b) => `${b.nota}${b.id ? ` · ${b.id}` : ''}: ${b.motivo}`));
  return transacao(() => {
    const env = registrarEnvio(poc, { tipo: 'manual', notaIds, tipos, forcar: plano.forcar, usuario, resumo: { eventos: plano.itens.length, bloqueios: plano.bloqueios.length } });
    const ids = gravarEventos(poc, plano.itens, { envioId: env.id, usuario });
    const substituidos = substituirPlanejados(poc, plano.itens.map((i) => i.opId), env.numero);
    executar('UPDATE envios SET resumo = ? WHERE id = ?', JSON.stringify({ eventos: ids.length, bloqueios: plano.bloqueios.length, substituidos }), env.id);
    return { ...env, eventos: ids, substituidos };
  });
}

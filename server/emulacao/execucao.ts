// Envio sob demanda (proposta v4.3, seção 09) e o motor que o valida: papel, nota relacionada, ordem e saldo.
// O mesmo motor monta os roteiros (plano.ts) e decide o que um envio manual substitui no que estava planejado.
// Vale para os dois entes: no IBS, o estado é o extrato da operação; na CBS, a foto do documento.
import { agora, executar, json, novoId, todos, transacao, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { CAMPOS, ROTULO_RELACIONADA, TIPO_IBS, numeroIbs, type Base, type Relacionada, type TipoEvento } from './catalogo.ts';
import { CAMPOS_CBS, ORDEM_CBS, TIPO_CBS, derivadoCbs, multaJuros, numeroCbs, type Endpoint } from './catalogo-cbs.ts';
import { paDe, type DadosCbs } from './arquivo-cbs.ts';
import { diaDe } from './xml.ts';

export interface NotaRow {
  id: string; poc_id: string; chave: string; modelo: string | null; serie: string | null; numero: string | null; emissao: string | null; autorizacao: string | null;
  emit_cnpj: string | null; emit_nome: string | null; dest_doc: string | null; dest_nome: string | null; papel: string | null; finalidade: string | null;
  ref_chaves: string; origem_id: string | null; cancelada_em: string | null; v_ibs: number; v_ibs_uf: number; v_ibs_mun: number; v_cbs: number;
  situacao: string; motivo: string | null; operacao_id: number | null; roteiro: string | null; splithub?: 'nao_conferido' | 'ausente';
}

export interface PocRow {
  id: string; nome: string; cnpj: string; cnpj_raiz: string; competencia: string; dia: string; ambiente_id: string | null; limites_relaxados: number;
  lancamentos_por_arquivo: number; ibs_client_id: string | null; ibs_secret_hash: string | null; ibs_habilitado_em: string | null; ibs_webhook_url: string | null;
  cbs_client_id: string | null; cbs_secret_hash: string | null; cbs_url_retorno: string | null; cbs_url_validada_em: string | null; defasagem_cbs: number;
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

// Nota marcada como ausente no SplitHub: o MassGen avisa antes de mandar; mandar assim mesmo é o caso T08 (seção 04).
export const AUSENTE = 'a nota não está no SplitHub; marque "incluir não importadas" para mandar assim mesmo (T08)';
export const ausente = (...notas: (NotaRow | undefined)[]) => notas.some((n) => n?.splithub === 'ausente');
export const relacionadasDe = (op: NotaRow) => todos<NotaRow>("SELECT * FROM notas WHERE origem_id = ? AND situacao = 'aceita' ORDER BY emissao, numero", op.id);

// ---------------------------------------------------------------- os dois entes

export type Ente = 'ibs' | 'cbs';

interface DefEnte {
  nome: string;
  campos: string[];
  tipo: (n: string) => TipoEvento | undefined;
  numero: (id: unknown) => string | undefined;
  valor: (n: NotaRow) => number; // o tributo da nota neste ente
  derivado?: (s: Record<string, number>, campo: string) => number | undefined;
  ordem: (n: string) => number;
}

export const ENTES: Record<Ente, DefEnte> = {
  ibs: { nome: 'IBS', campos: CAMPOS.map((c) => c.campo), tipo: (n) => TIPO_IBS.get(n), numero: numeroIbs, valor: (n) => n.v_ibs, ordem: (n) => Number(n) },
  cbs: { nome: 'CBS', campos: CAMPOS_CBS.map((c) => c.campo), tipo: (n) => TIPO_CBS.get(n), numero: numeroCbs, valor: (n) => n.v_cbs, derivado: derivadoCbs, ordem: (n) => ORDEM_CBS.indexOf(n) },
};

export const tipoDe = (ente: string, n: string): TipoEvento | undefined => ENTES[ente as Ente]?.tipo(n);
// O cancelamento não é nota: no ajuste (E-CBS-D07), conta como a relacionada desta chave.
export const CANCELAMENTO = 'cancelamento';

// ---------------------------------------------------------------- estado do documento no ente emulado

export interface Estado {
  ente: Ente;
  op: NotaRow; // a operação no IBS; o documento na CBS
  relacionadas: NotaRow[];
  saldos: Record<string, number>;
  ocorreu: Map<string, number>;
  acumulado: Map<string, number>;
  porRel: Map<string, number>; // `${relId}:${tipo}` → valor
}

export const zerados = (ente: Ente): Record<string, number> => Object.fromEntries(ENTES[ente].campos.map((c) => [c, 0]));

function aplicar(e: Estado, tipo: string, valor: number, valores: Record<string, number>, relKey?: string | null): void {
  for (const c of ENTES[e.ente].campos) e.saldos[c] = r2(e.saldos[c] + (valores[c] ?? 0));
  e.ocorreu.set(tipo, (e.ocorreu.get(tipo) ?? 0) + 1);
  e.acumulado.set(tipo, r2((e.acumulado.get(tipo) ?? 0) + valor));
  if (relKey) e.porRel.set(`${relKey}:${tipo}`, r2((e.porRel.get(`${relKey}:${tipo}`) ?? 0) + valor));
}

interface EventoRow { id: string; tipo: string; valor: number; valores: string; nota_rel_id: string | null; dia: string; ordem: number; situacao: string; forcado: number; origem: string; envio_id: string | null }

const relKeyDe = (ente: Ente, ev: Pick<EventoRow, 'tipo' | 'nota_rel_id'>) => ev.nota_rel_id ?? (ENTES[ente].tipo(ev.tipo)?.relacionada === 'ajuste' ? CANCELAMENTO : null);

// Estado com os eventos que já aconteceram ou que saem até o dia informado (inclusive). Substituídos não contam.
export function carregarEstado(op: NotaRow, ateDia?: string, ente: Ente = 'ibs'): Estado {
  const e: Estado = { ente, op, relacionadas: relacionadasDe(op), saldos: zerados(ente), ocorreu: new Map(), acumulado: new Map(), porRel: new Map() };
  const evs = todos<EventoRow>(
    `SELECT * FROM eventos WHERE nota_id = ? AND ente = ? AND situacao <> 'substituido' ${ateDia ? "AND (situacao <> 'planejado' OR dia <= ?)" : "AND situacao <> 'planejado'"} ORDER BY dia, ordem`,
    ...(ateDia ? [op.id, ente, ateDia] : [op.id, ente]));
  for (const ev of evs) aplicar(e, ev.tipo, ev.valor, json(ev.valores, zerados(ente)), relKeyDe(ente, ev));
  return e;
}

export const saldoDe = (e: Estado, campo: string): number => e.saldos[campo] ?? ENTES[e.ente].derivado?.(e.saldos, campo) ?? 0;

function avaliar(b: Base, e: Estado, rel?: NotaRow): number {
  const valor = ENTES[e.ente].valor;
  switch (b.de) {
    case 'nota': return valor(e.op);
    case 'relacionada': return rel ? valor(rel) : 0;
    case 'relacionada_menos': return rel ? r2(valor(rel) - b.tipos.reduce((s, t) => s + (e.porRel.get(`${rel.id}:${t}`) ?? 0), 0)) : 0;
    case 'saldo': return saldoDe(e, b.campo);
    case 'acumulado': return r2(b.tipos.reduce((s, t) => s + (e.acumulado.get(t) ?? 0), 0) - (b.menos ?? []).reduce((s, t) => s + (e.acumulado.get(t) ?? 0), 0));
    case 'menor': return Math.min(...b.bases.map((x) => avaliar(x, e, rel)));
    case 'zero': return 0;
  }
}

const RELACIONADA_FINALIDADE: Record<string, string> = { complementar: 'complementar', devolucao: 'devolucao' };

// A nota relacionada que o tipo usa: a preferida (quando o usuário marcou a própria complementar ou devolução) ou a primeira ainda livre.
function relacionadaPara(t: TipoEvento, e: Estado, preferida?: string): NotaRow | undefined {
  if (!t.relacionada || t.relacionada === 'cancelamento' || t.relacionada === 'ajuste') return undefined;
  const livres = e.relacionadas.filter((r) => r.finalidade === RELACIONADA_FINALIDADE[t.relacionada!] && !(t.unico === 'relacionada' && e.porRel.has(`${r.id}:${t.n}`)));
  return livres.find((r) => r.id === preferida) ?? livres[0];
}

// Como o tipo acontece nesta nota: com que efeito, sobre que base e ligado a que nota relacionada.
interface Resolucao { efeito: Partial<Record<string, 1 | -1>>; base: Base; rel?: NotaRow; relKey?: string; via?: Relacionada; origem?: number }

// O ajuste (E-CBS-D07) usa o que a nota tiver: a preferida, depois a complementar ou a devolução livre, depois o cancelamento.
function resolverAjuste(t: TipoEvento, e: Estado, preferida?: string): Resolucao | string {
  const livre = (key: string) => !e.porRel.has(`${key}:${t.n}`);
  const opcoes: { via: Relacionada; rel?: NotaRow; key: string }[] = [];
  for (const r of e.relacionadas) if ((r.finalidade === 'complementar' || r.finalidade === 'devolucao') && livre(r.id)) opcoes.push({ via: r.finalidade, rel: r, key: r.id });
  if (e.op.cancelada_em && livre(CANCELAMENTO)) opcoes.push({ via: 'cancelamento', key: CANCELAMENTO });
  const preferidas = opcoes.filter((o) => o.key === preferida);
  const o = [...preferidas, ...opcoes].find((x) => t.variantes?.[`${e.op.papel}:${x.via}`]);
  if (!o) {
    if (opcoes.length) return `nesta nota, o ${t.id} não vale para ${opcoes.map((x) => ROTULO_RELACIONADA[x.via]).join(' nem para ')}`;
    const tem = e.relacionadas.some((r) => r.finalidade === 'complementar' || r.finalidade === 'devolucao') || !!e.op.cancelada_em;
    return tem ? `o ${t.id} já foi usado com a nota relacionada e o cancelamento desta nota` : 'falta a nota complementar, a de devolução ou o XML do cancelamento no lote';
  }
  const v = t.variantes![`${e.op.papel}:${o.via}`]!;
  return { efeito: v.efeito, base: v.base, rel: o.rel, relKey: o.key, via: o.via, origem: v.origem };
}

// O que impede o tipo de acontecer nesta nota (texto), sem contar a ordem e o saldo; ou como ele acontece.
function resolver(t: TipoEvento, e: Estado, preferida?: string): Resolucao | string {
  if (t.lado !== 'ambos' && t.lado !== e.op.papel) return t.lado === 'adquirente' ? 'só em nota de entrada (o cliente é o adquirente)' : 'só em nota de saída (o cliente é o fornecedor)';
  if (t.relacionada === 'ajuste') return resolverAjuste(t, e, preferida);
  if (t.relacionada === 'cancelamento' && !e.op.cancelada_em) return `falta ${ROTULO_RELACIONADA.cancelamento} desta nota no lote`;
  if (t.relacionada && t.relacionada !== 'cancelamento') {
    const rel = relacionadaPara(t, e, preferida);
    if (!rel) {
      const ja = e.relacionadas.some((r) => r.finalidade === RELACIONADA_FINALIDADE[t.relacionada!]);
      return ja ? `${ROTULO_RELACIONADA[t.relacionada]} já foi usada neste tipo` : `falta ${ROTULO_RELACIONADA[t.relacionada]} no lote`;
    }
    return { efeito: t.efeito, base: t.base, rel, relKey: rel.id };
  }
  return { efeito: t.efeito, base: t.base, via: t.relacionada === 'cancelamento' ? 'cancelamento' : undefined };
}

const satisfeito = (alt: string[], e: Estado) => alt.every((x) => (e.ocorreu.get(x) ?? 0) > 0);

// ---------------------------------------------------------------- o que o evento da CBS leva além do valor

const ultimoDiaDoMesSeguinte = (pa: string) => {
  const d = new Date(Date.UTC(Number(pa.slice(3)), Number(pa.slice(0, 2)) + 1, 0));
  return d.toISOString().slice(0, 10);
};

function dadosCbs(t: TipoEvento, doc: NotaRow, r: Resolucao, valor: number): DadosCbs | undefined {
  const p = TIPO_CBS.get(t.n)?.pagamento;
  if (p) {
    const pa = paDe(doc.emissao);
    const { multa, juros } = p.atraso ? multaJuros(valor) : { multa: 0, juros: 0 };
    const d: DadosCbs = { tipo: p.tipo, pa, principal: valor, multa, juros, total: r2(valor + multa + juros) };
    if (p.niAdquirente) d.niAdquirente = doc.dest_doc ?? '';
    if (TIPO_CBS.get(t.n)!.endpoint === 'recolhimentos') {
      d.niFornecedor = doc.emit_cnpj ?? '';
      d.chaveDFE = doc.chave;
      d.vencimento = pa ? `${ultimoDiaDoMesSeguinte(pa)}T23:59:59-03:00` : '';
    }
    return d;
  }
  if (r.via) return r.origem === undefined ? { via: r.via } : { via: r.via, origem: r.origem };
  return undefined;
}

// ---------------------------------------------------------------- planejamento

export interface ItemPlano {
  ente: Ente; notaId: string; opId: string; nota: string; relId?: string; relNota?: string;
  tipo: string; id: string; mov: string; valor: number; valores: Record<string, number>;
  origem: 'escolhido' | 'pre-requisito' | 'roteiro'; pct?: number; forcado: boolean; dia: string;
  endpoint?: Endpoint; dados?: DadosCbs;
}
export interface Bloqueio { notaId: string; nota: string; tipo?: string; id?: string; motivo: string }

export interface PedidoTipo { tipo: string; pct?: number; valor?: number }

export interface Contexto {
  dia: string;
  forcar: boolean;
  itens: ItemPlano[];
  bloqueios: Bloqueio[];
}

// Inclui o tipo na nota, com os pré-requisitos que faltam antes (D-MG-13). Devolve false se não deu.
export function incluir(ctx: Contexto, e: Estado, notaId: string, pedido: PedidoTipo, origem: ItemPlano['origem'], escolhidos: Map<string, PedidoTipo>, preferida?: string, profundidade = 0): boolean {
  const def = ENTES[e.ente];
  const t = def.tipo(pedido.tipo)!;
  const rot = rotuloNota(e.op);
  const bloquear = (motivo: string) => { ctx.bloqueios.push({ notaId, nota: rot, tipo: t.n, id: t.id, motivo }); return false; };
  if (profundidade > 12) return bloquear('a cadeia de pré-requisitos não fecha');
  const imp = resolver(t, e, preferida);
  if (typeof imp === 'string') return bloquear(imp);
  if (t.unico === 'operacao' && (e.ocorreu.get(t.n) ?? 0) > 0 && !ctx.forcar) return bloquear('já aconteceu nesta nota');
  if (!ctx.forcar && t.precisa.length && !t.precisa.some((alt) => satisfeito(alt, e))) {
    // Primeiro uma alternativa cujo que falta o usuário também escolheu; depois a primeira que cabe nesta nota.
    const faltam = (alt: string[]) => alt.filter((x) => !(e.ocorreu.get(x) ?? 0));
    const cabe = (alt: string[]) => faltam(alt).every((x) => typeof resolver(def.tipo(x)!, e, preferida) !== 'string');
    const alt = t.precisa.find((a) => faltam(a).every((x) => escolhidos.has(x))) ?? t.precisa.find(cabe);
    if (!alt) return bloquear(`precisa antes de ${t.precisa.map((a) => a.map((x) => def.tipo(x)!.id).join(' e ')).join(' ou ')}, que não cabe nesta nota`);
    for (const x of faltam(alt)) {
      const escolhido = escolhidos.get(x);
      const ok = incluir(ctx, e, notaId, escolhido ?? { tipo: x }, escolhido ? 'escolhido' : 'pre-requisito', escolhidos, preferida, profundidade + 1);
      if (escolhido) escolhidos.delete(x);
      if (!ok) return bloquear(`o pré-requisito ${def.tipo(x)!.id} não pôde entrar`);
    }
  }
  // Os pré-requisitos mudaram o estado: a nota relacionada e a base saem dele de novo.
  const r = resolver(t, e, preferida) as Resolucao;
  // A data simulada não vem antes do documento que dá origem ao evento.
  const desde = [diaDe(e.op.emissao ?? undefined), diaDe(r.rel?.emissao ?? undefined), r.via === 'cancelamento' ? diaDe(e.op.cancelada_em ?? undefined) : undefined]
    .filter((d): d is string => !!d).sort().pop();
  if (desde && desde > ctx.dia && !ctx.forcar) return bloquear(`o documento é de ${diaBr(desde)} e o relógio está em ${diaBr(ctx.dia)}; avance o relógio`);
  const base = avaliar(r.base, e, r.rel);
  const pct = pedido.pct ?? t.pctPadrao;
  const nulo = r.base.de === 'zero';
  let valor: number;
  if (nulo) valor = 0;
  else if (pedido.valor !== undefined && pedido.valor !== null) valor = r2(Number(pedido.valor));
  else if (base <= 0 && ctx.forcar) valor = def.valor(e.op);
  else valor = r2(base * (t.parcial && pct ? Math.min(100, Math.max(1, pct)) : 100) / 100);
  if (!nulo && !ctx.forcar) {
    if (base <= 0) return bloquear('sem saldo na nota para este tipo');
    if (valor <= 0) return bloquear('o valor precisa ser maior que zero');
    if (valor > base + 0.005) return bloquear(`o valor passa do saldo (${base.toLocaleString('pt-BR', { minimumFractionDigits: 2 })})`);
  }
  const valores = zerados(e.ente);
  for (const [c, sinal] of Object.entries(r.efeito)) valores[c] = r2((sinal ?? 0) * valor);
  aplicar(e, t.n, valor, valores, r.relKey);
  ctx.itens.push({
    ente: e.ente, notaId, opId: e.op.id, nota: rot, relId: r.rel?.id, relNota: r.rel ? rotuloNota(r.rel) : undefined, tipo: t.n, id: t.id, mov: t.mov, valor, valores,
    origem, pct: t.parcial ? pct : undefined, forcado: ctx.forcar, dia: ctx.dia,
    endpoint: e.ente === 'cbs' ? TIPO_CBS.get(t.n)?.endpoint : undefined, dados: e.ente === 'cbs' ? dadosCbs(t, e.op, r, valor) : undefined,
  });
  return true;
}

// A operação de uma nota no IBS: a própria, ou a original, quando a nota é complementar ou de devolução.
export function operacaoDe(nota: NotaRow): { op?: NotaRow; preferida?: string; motivo?: string } {
  if (nota.situacao !== 'aceita') return { motivo: nota.motivo ?? 'a nota ficou de fora da POC' };
  if (nota.finalidade === 'complementar' || nota.finalidade === 'devolucao') {
    if (!nota.origem_id) return { motivo: 'a nota original não está no lote' };
    return { op: notaPorId(nota.origem_id), preferida: nota.id };
  }
  return { op: nota };
}

// O documento de uma nota na CBS: cada nota é o seu. Só o ajuste (E-CBS-D07) da complementar ou da devolução vai para a
// foto da original, como o complemento e a devolução vão para a operação no IBS.
export function documentoCbs(nota: NotaRow, t: TipoEvento): { op?: NotaRow; preferida?: string; motivo?: string } {
  if (nota.situacao !== 'aceita') return { motivo: nota.motivo ?? 'a nota ficou de fora da POC' };
  if (t.relacionada === 'ajuste' && (nota.finalidade === 'complementar' || nota.finalidade === 'devolucao')) {
    if (!nota.origem_id) return { motivo: 'a nota original não está no lote' };
    return { op: notaPorId(nota.origem_id), preferida: nota.id };
  }
  return { op: nota };
}

interface Pedido extends PedidoTipo { ente: Ente }

function lerPedidos(tipos: unknown): Pedido[] {
  if (!Array.isArray(tipos) || !tipos.length) throw new ErroHttp(400, 'Marque pelo menos um tipo de evento.');
  const pedidos: Pedido[] = [];
  for (const x of tipos as unknown[]) {
    const obj = (typeof x === 'object' && x ? x : { tipo: x }) as Record<string, unknown>;
    const ibs = numeroIbs(obj.tipo);
    const cbs = ibs ? undefined : numeroCbs(obj.tipo);
    if (!ibs && !cbs) throw new ErroHttp(400, `Tipo de evento desconhecido: ${String(obj.tipo)}. Use E-IBS-01 a E-IBS-24 ou E-CBS-D01 a E-CBS-R03.`);
    const ente: Ente = ibs ? 'ibs' : 'cbs';
    const tipo = (ibs ?? cbs)!;
    if (pedidos.some((p) => p.ente === ente && p.tipo === tipo)) continue;
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    pedidos.push({ ente, tipo, pct: num(obj.pct), valor: num(obj.valor) });
  }
  return pedidos.sort((a, b) => (a.ente === b.ente ? ENTES[a.ente].ordem(a.tipo) - ENTES[b.ente].ordem(b.tipo) : a.ente === 'ibs' ? -1 : 1));
}

export function planejarEnvio(poc: PocRow, notaIds: unknown, tipos: unknown, forcar = false, incluirAusentes = false) {
  if (!Array.isArray(notaIds) || !notaIds.length) throw new ErroHttp(400, 'Marque pelo menos uma nota.');
  if (notaIds.length > 500) throw new ErroHttp(400, 'No máximo 500 notas por envio.');
  const pedidos = lerPedidos(tipos);
  const ctx: Contexto = { dia: poc.dia, forcar, itens: [], bloqueios: [] };
  const estados = new Map<string, Estado>();
  const estado = (ente: Ente, op: NotaRow) => {
    let e = estados.get(`${ente}:${op.id}`);
    if (!e) estados.set(`${ente}:${op.id}`, (e = carregarEstado(op, poc.dia, ente)));
    return e;
  };
  // Os tipos de um ente que caem no mesmo documento rodam juntos: um escolhido pode ser o pré-requisito de outro.
  const rodar = (id: string, e: Estado, lista: Pedido[], preferida?: string) => {
    const escolhidos = new Map(lista.map((p) => [p.tipo, p as PedidoTipo]));
    for (const p of lista) {
      if (!escolhidos.has(p.tipo)) continue; // já entrou como pré-requisito de outro escolhido
      escolhidos.delete(p.tipo);
      incluir(ctx, e, id, p, 'escolhido', escolhidos, preferida);
    }
  };
  for (const id of new Set(notaIds.map(String))) {
    const nota = notaPorId(id);
    if (!nota || nota.poc_id !== poc.id) { ctx.bloqueios.push({ notaId: id, nota: id, motivo: 'nota não encontrada nesta POC' }); continue; }
    if (!incluirAusentes && ausente(nota, nota.origem_id ? notaPorId(nota.origem_id) : undefined)) { ctx.bloqueios.push({ notaId: id, nota: rotuloNota(nota), motivo: AUSENTE }); continue; }
    const ibs = pedidos.filter((p) => p.ente === 'ibs');
    if (ibs.length) {
      const { op, preferida, motivo } = operacaoDe(nota);
      if (!op) ctx.bloqueios.push({ notaId: id, nota: rotuloNota(nota), motivo: `IBS: ${motivo!}` });
      else rodar(id, estado('ibs', op), ibs, preferida);
    }
    const grupos = new Map<string, { op: NotaRow; preferida?: string; lista: Pedido[] }>();
    for (const p of pedidos.filter((x) => x.ente === 'cbs')) {
      const t = TIPO_CBS.get(p.tipo)!;
      const { op, preferida, motivo } = documentoCbs(nota, t);
      if (!op) { ctx.bloqueios.push({ notaId: id, nota: rotuloNota(nota), tipo: t.n, id: t.id, motivo: motivo! }); continue; }
      const g = grupos.get(op.id) ?? { op, preferida, lista: [] };
      g.lista.push(p);
      grupos.set(op.id, g);
    }
    for (const g of grupos.values()) rodar(id, estado('cbs', g.op), g.lista, g.preferida);
  }
  return { dia: poc.dia, forcar, incluirAusentes, itens: ctx.itens, bloqueios: ctx.bloqueios };
}

// ---------------------------------------------------------------- gravação

const proximaOrdem = (pocId: string) => um<{ n: number }>('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM eventos WHERE poc_id = ?', pocId)!.n;
export const proximoEnvio = (pocId: string) => um<{ n: number }>('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM envios WHERE poc_id = ?', pocId)!.n;

// "07.17.26305.0000042-2": o formato do DARF do exemplo da documentação, com o dia do ano e a ordem do evento.
function numeroDarf(dia: string, ordem: number): string {
  const doAno = Math.floor((Date.parse(`${dia}T00:00:00Z`) - Date.parse(`${dia.slice(0, 4)}-01-01T00:00:00Z`)) / 86400000) + 1;
  return `07.17.${dia.slice(2, 4)}${String(doAno).padStart(3, '0')}.${String(ordem).padStart(7, '0')}-${ordem % 10}`;
}

export function gravarEventos(poc: PocRow, itens: ItemPlano[], extra: { envioId: string; roteiro?: string; usuario: string }): string[] {
  let ordem = proximaOrdem(poc.id);
  const ids: string[] = [];
  const quando = agora();
  for (const it of itens) {
    const id = novoId('ev');
    const n = ordem++;
    const dados = it.dados && it.dados.principal !== undefined ? { numeroDARF: numeroDarf(it.dia, n), ...it.dados } : it.dados;
    executar(
      `INSERT INTO eventos (id, poc_id, nota_id, nota_rel_id, ente, tipo, roteiro, origem, envio_id, forcado, dia, ordem, valor, valores, dados, situacao, criado_por, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planejado', ?, ?, ?)`,
      id, poc.id, it.opId, it.relId ?? null, it.ente, it.tipo, extra.roteiro ?? null, it.origem === 'pre-requisito' ? 'prerequisito' : it.origem === 'roteiro' ? 'roteiro' : 'manual',
      extra.envioId, it.forcado ? 1 : 0, it.dia, n, it.valor, JSON.stringify(it.valores), dados ? JSON.stringify(dados) : null, extra.usuario, quando, quando,
    );
    ids.push(id);
  }
  return ids;
}

// A base com que o evento gravado foi calculado, para saber se o saldo ainda o comporta.
function baseDoEvento(t: TipoEvento, e: Estado, ev: EventoRow): Base {
  if (!t.variantes) return t.base;
  const rel = ev.nota_rel_id ? notaPorId(ev.nota_rel_id) : undefined;
  const via = rel?.finalidade ?? CANCELAMENTO;
  return t.variantes[`${e.op.papel}:${via}`]?.base ?? { de: 'zero' };
}

// Evento planejado que o envio manual tornou repetido ou impossível: "substituído" e não sai (seção 09, Plano).
export function substituirPlanejados(poc: PocRow, alvos: { opId: string; ente: Ente }[], envioNumero: number): number {
  let n = 0;
  for (const chave of new Set(alvos.map((a) => `${a.ente}:${a.opId}`))) {
    const [ente, opId] = chave.split(':') as [Ente, string];
    const op = notaPorId(opId);
    if (!op) continue;
    const e = carregarEstado(op, poc.dia, ente);
    const futuros = todos<EventoRow>("SELECT * FROM eventos WHERE nota_id = ? AND ente = ? AND situacao = 'planejado' AND dia > ? ORDER BY dia, ordem", opId, ente, poc.dia);
    for (const ev of futuros) {
      const t = ENTES[ente].tipo(ev.tipo)!;
      const rel = ev.nota_rel_id ? notaPorId(ev.nota_rel_id) : undefined;
      const relKey = relKeyDe(ente, ev);
      let motivo: string | undefined;
      if (!ev.forcado) {
        const base = baseDoEvento(t, e, ev);
        if (t.unico === 'operacao' && (e.ocorreu.get(t.n) ?? 0) > 0) motivo = 'já aconteceu pelo envio manual';
        else if ((t.unico === 'relacionada' || t.relacionada === 'ajuste') && relKey && e.porRel.has(`${relKey}:${t.n}`)) motivo = 'já aconteceu pelo envio manual';
        else if (t.precisa.length && !t.precisa.some((alt) => satisfeito(alt, e))) motivo = 'perdeu o pré-requisito';
        else if (base.de !== 'zero' && ev.valor > avaliar(base, e, rel) + 0.005) motivo = 'o saldo não comporta mais';
      }
      if (motivo) {
        executar("UPDATE eventos SET situacao = 'substituido', motivo = ?, atualizado_em = ? WHERE id = ?", `Substituído pelo envio manual nº ${envioNumero}: ${motivo}.`, agora(), ev.id);
        n++;
      } else aplicar(e, ev.tipo, ev.valor, json(ev.valores, zerados(ente)), relKey);
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

export const contarPorEnte = (itens: { ente: Ente }[]) => ({ ibs: itens.filter((i) => i.ente === 'ibs').length, cbs: itens.filter((i) => i.ente === 'cbs').length });

// Grava o envio e os eventos. Quem chama fecha o dia na hora (D-MG-14).
export function gravarEnvioManual(poc: PocRow, plano: ReturnType<typeof planejarEnvio>, tipos: string[], notaIds: string[], usuario: string) {
  if (!plano.itens.length) throw new ErroHttp(422, 'Nenhum evento pode sair com essa escolha.', plano.bloqueios.map((b) => `${b.nota}${b.id ? ` · ${b.id}` : ''}: ${b.motivo}`));
  return transacao(() => {
    const porEnte = contarPorEnte(plano.itens);
    const env = registrarEnvio(poc, { tipo: 'manual', notaIds, tipos, forcar: plano.forcar, usuario, resumo: { eventos: plano.itens.length, ...porEnte, bloqueios: plano.bloqueios.length } });
    const ids = gravarEventos(poc, plano.itens, { envioId: env.id, usuario });
    const substituidos = substituirPlanejados(poc, plano.itens.map((i) => ({ opId: i.opId, ente: i.ente })), env.numero);
    executar('UPDATE envios SET resumo = ? WHERE id = ?', JSON.stringify({ eventos: ids.length, ...porEnte, bloqueios: plano.bloqueios.length, substituidos }), env.id);
    return { ...env, eventos: ids, ...porEnte, substituidos };
  });
}

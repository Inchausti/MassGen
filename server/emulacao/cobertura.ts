// Plano e painel de cobertura (proposta v4.3, seção 08; D-MG-04, D-MG-05, D-MG-06). O plano dá a cada nota livre o roteiro
// que cobre o tipo ainda não coberto, respeitando o papel do cliente e o que a nota permite; depois de tudo coberto, as
// demais seguem o caminho feliz (RT-A1 ou RT-F1). O painel conta a meta separada por ente e fecha quando cada tipo tem
// pelo menos uma nota entregue e baixada pelo SplitHub. Quando o lote não tem a nota que o tipo pede, o painel diz qual
// XML falta; o MassGen não inventa nota.
import { agora, executar, simular, todos, transacao } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { CATALOGO_IBS, ROTEIRO, ROTEIROS, type Relacionada, type Roteiro } from './catalogo.ts';
import { CATALOGO_CBS } from './catalogo-cbs.ts';
import { casoLigado, situacaoCasos } from './casos.ts';
import { diaBr, notaPorId, obterPoc, operacaoDe, relacionadasDe, rotuloNota, somarDias, type Ente, type ItemPlano, type NotaRow, type PocRow } from './execucao.ts';
import { gravarRoteiro, limitarDefasagem, planejarRoteiro, type PlanoRoteiro } from './plano.ts';

export const META_TIPOS = CATALOGO_IBS.length + CATALOGO_CBS.length; // 24 + 26

const chave = (ente: Ente, tipo: string) => `${ente}:${tipo}`;
const chaveDo = (i: Pick<ItemPlano, 'ente' | 'tipo'>) => chave(i.ente, i.tipo);
const FELIZ: Record<string, string> = { adquirente: 'RT-A1', fornecedor: 'RT-F1' };

const cobertosNaPoc = (pocId: string) =>
  new Set(todos<{ ente: Ente; tipo: string }>("SELECT DISTINCT ente, tipo FROM eventos WHERE poc_id = ? AND situacao <> 'substituido'", pocId).map((e) => chave(e.ente, e.tipo)));

// ---------------------------------------------------------------- o que a nota permite

type Atributo = Relacionada;

function atributos(op: NotaRow, relacionadas: NotaRow[]): Set<Atributo> {
  const a = new Set<Atributo>();
  if (op.cancelada_em) a.add('cancelamento');
  for (const r of relacionadas) if (r.finalidade === 'complementar' || r.finalidade === 'devolucao') a.add(r.finalidade);
  return a;
}

const cabe = (r: Roteiro, op: NotaRow, attrs: Set<Atributo>) => r.lado === op.papel && (!r.precisa || attrs.has(r.precisa));

// ---------------------------------------------------------------- plano automático

export interface OpcoesPlano { refazer?: boolean; intervaloDias?: unknown; defasagem?: unknown }

interface Escolha { op: NotaRow; plano: PlanoRoteiro; novos: string[]; motivo: 'cobre' | 'feliz' | 'caso' }

// Libera as notas cujo plano ainda não saiu: os eventos planejados viram substituídos. Nota com evento já entregue ou
// com envio manual fica como está.
function liberarPlanejados(pocId: string): { notas: number; eventos: number } {
  const historias = todos<{ op: string; fora: number; manuais: number }>(
    `SELECT CASE WHEN n.finalidade IN ('complementar', 'devolucao') AND n.origem_id IS NOT NULL THEN n.origem_id ELSE n.id END AS op,
            SUM(e.situacao <> 'planejado') AS fora, SUM(e.origem = 'manual') AS manuais
       FROM eventos e JOIN notas n ON n.id = e.nota_id WHERE e.poc_id = ? AND e.situacao <> 'substituido' GROUP BY op`, pocId)
    .filter((h) => !h.fora && !h.manuais);
  let eventos = 0;
  for (const h of historias) {
    const docs = [h.op, ...relacionadasDe(notaPorId(h.op)!).map((r) => r.id)];
    eventos += Number(executar(`UPDATE eventos SET situacao = 'substituido', motivo = 'Substituído ao refazer o plano de cobertura.', atualizado_em = ?
      WHERE situacao = 'planejado' AND nota_id IN (${docs.map(() => '?').join(', ')})`, agora(), ...docs).changes);
    executar('UPDATE notas SET roteiro = NULL WHERE id = ?', h.op);
  }
  return { notas: historias.length, eventos };
}

function semEventos(op: NotaRow): boolean {
  const docs = [op.id, ...relacionadasDe(op).map((r) => r.id)];
  return !todos(`SELECT 1 FROM eventos WHERE situacao <> 'substituido' AND nota_id IN (${docs.map(() => '?').join(', ')}) LIMIT 1`, ...docs).length;
}

function montarPlano(poc: PocRow, opcoes: OpcoesPlano, usuario: string) {
  const intervalo = Math.min(30, Math.max(0, Math.round(Number(opcoes.intervaloDias ?? 1) || 0)));
  const defasagem = limitarDefasagem(opcoes.defasagem, poc.defasagem_cbs ?? 0);
  const liberadas = opcoes.refazer ? liberarPlanejados(poc.id) : { notas: 0, eventos: 0 };
  const cobertos = cobertosNaPoc(poc.id);
  const t08 = casoLigado(poc.id, 'T08');
  // T05 e T07 pedem uma operação com dois lançamentos no mesmo dia: o plano abre essa oportunidade num dia para cada caso.
  const vagas = (['T05', 'T07'] as const).filter((c) => casoLigado(poc.id, c)).map((c, i) => ({ caso: c, dia: somarDias(poc.dia, i) }));
  const ops = todos<NotaRow>(
    "SELECT * FROM notas WHERE poc_id = ? AND situacao = 'aceita' AND operacao_id IS NOT NULL AND (finalidade IS NULL OR finalidade NOT IN ('complementar', 'devolucao')) ORDER BY emissao, numero",
    poc.id).filter(semEventos);
  const perfis = ops.map((op) => {
    const rels = relacionadasDe(op);
    return { op, attrs: atributos(op, rels), ausente: op.splithub === 'ausente' };
  }).filter((p) => !p.ausente || t08);
  // Primeiro as notas com o que pouca nota tem (cancelamento, complementar, devolução); depois as comuns; por último as
  // ausentes do SplitHub (T08), que vão pelos dois entes.
  const grupo = (p: (typeof perfis)[number]) => (p.ausente ? 2 : p.attrs.size ? 0 : 1);
  perfis.sort((a, b) => grupo(a) - grupo(b));
  // O que cada roteiro rende num perfil de nota (lado e atributos): se não rende nada novo, nem planeja.
  const rende = new Map<string, Set<string>>();
  const escolhas: Escolha[] = [];
  const semPlano: { notaId: string; nota: string; motivo: string }[] = [];
  for (const p of perfis) {
    const perfil = `${p.op.papel}:${[...p.attrs].sort().join(',')}:${p.ausente}`;
    const opcoesRot = { defasagem, incluirAusentes: p.ausente };
    const candidatos = ROTEIROS.filter((r) => cabe(r, p.op, p.attrs) && (!p.ausente || (r.ibs.length && r.cbs.length)));
    const avaliados: { r: Roteiro; plano: PlanoRoteiro; novos: string[] }[] = [];
    for (const r of candidatos) {
      const ja = rende.get(`${perfil}:${r.id}`);
      if (ja && [...ja].every((k) => cobertos.has(k))) continue;
      const plano = planejarRoteiro(poc, [p.op.id], r.id, intervalo, opcoesRot);
      if (!plano.itens.length) continue;
      const tipos = new Set(plano.itens.map(chaveDo));
      rende.set(`${perfil}:${r.id}`, tipos);
      avaliados.push({ r, plano, novos: [...tipos].filter((k) => !cobertos.has(k)) });
    }
    const melhor = (lista: typeof avaliados) => lista.filter((a) => a.novos.length).sort((a, b) => b.novos.length - a.novos.length)[0];
    // A nota rara usa o roteiro que pede o que ela tem, se ele ainda cobre alguma coisa (D-MG-05: ela é a única que cobre).
    let escolhido = (p.attrs.size ? melhor(avaliados.filter((a) => a.r.precisa && p.attrs.has(a.r.precisa))) : undefined) ?? melhor(avaliados);
    let motivo: Escolha['motivo'] = 'cobre';
    if (!escolhido) {
      const feliz = ROTEIRO.get(FELIZ[p.op.papel ?? ''] ?? '');
      const plano = feliz ? planejarRoteiro(poc, [p.op.id], feliz.id, intervalo, opcoesRot) : undefined;
      if (plano?.itens.length) { escolhido = { r: feliz!, plano, novos: [] }; motivo = 'feliz'; }
    }
    if (!escolhido) { semPlano.push({ notaId: p.op.id, nota: rotuloNota(p.op), motivo: 'nenhum roteiro cabe nesta nota' }); continue; }
    let plano = escolhido.plano;
    if (vagas.length && !p.ausente && escolhido.r.ibs.length >= 2) {
      const vaga = vagas[0];
      const junto = planejarRoteiro(poc, [p.op.id], escolhido.r.id, 0, { ...opcoesRot, inicio: vaga.dia });
      const dias = junto.itens.filter((i) => i.ente === 'ibs').map((i) => i.dia);
      if (junto.itens.length && dias.length >= 2 && new Set(dias).size === 1) { plano = junto; vagas.shift(); motivo = motivo === 'feliz' ? 'caso' : motivo; }
    }
    for (const k of plano.itens.map(chaveDo)) cobertos.add(k);
    escolhas.push({ op: p.op, plano, novos: escolhido.novos, motivo });
  }
  // Grava junto o que tem o mesmo roteiro, intervalo e início: um envio por grupo.
  const grupos = new Map<string, Escolha[]>();
  for (const e of escolhas) {
    const k = `${e.plano.roteiro.id}|${e.plano.intervalo}|${e.plano.inicio}`;
    grupos.set(k, [...(grupos.get(k) ?? []), e]);
  }
  const envios = [...grupos.values()].map((g) => {
    const plano = { ...g[0].plano, itens: g.flatMap((e) => e.plano.itens), bloqueios: [] };
    const r = gravarRoteiro(poc, plano, usuario, { plano: true });
    return {
      numero: r.envio.numero, roteiro: plano.roteiro.id, historia: plano.roteiro.historia, intervalo: plano.intervalo, inicio: plano.inicio, eventos: plano.itens.length,
      notas: g.map((e) => ({ id: e.op.id, rotulo: rotuloNota(e.op), novos: e.novos.map(rotuloTipo), motivo: e.motivo })),
    };
  });
  return { intervalo, defasagem, liberadas, envios, semPlano, notas: escolhas.length, eventos: escolhas.reduce((s, e) => s + e.plano.itens.length, 0), cobertura: cobertura(poc.id) };
}

const ID_TIPO = new Map([...CATALOGO_IBS.map((t) => [chave('ibs', t.n), t.id] as const), ...CATALOGO_CBS.map((t) => [chave('cbs', t.n), t.id] as const)]);
const rotuloTipo = (k: string) => ID_TIPO.get(k) ?? k;

export const previaPlano = (pocId: string, opcoes: OpcoesPlano, usuario: string) => simular(() => montarPlano(obterPoc(pocId), opcoes, usuario));
export function aplicarPlano(pocId: string, opcoes: OpcoesPlano, usuario: string) {
  const r = transacao(() => montarPlano(obterPoc(pocId), opcoes, usuario));
  if (!r.envios.length && !r.liberadas.notas) throw new ErroHttp(422, 'Nenhuma nota livre para o plano: todas já têm roteiro ou eventos.', r.semPlano.map((s) => `${s.nota}: ${s.motivo}`));
  return r;
}

// ---------------------------------------------------------------- troca de roteiro de uma nota (D-MG-04)

export interface OpcoesTroca { roteiro?: unknown; intervaloDias?: unknown; defasagem?: unknown; incluirAusentes?: unknown }

// Os eventos planejados da nota viram substituídos e o roteiro novo entra no lugar. Se a nota já tem história (evento
// entregue ou envio manual), o roteiro novo continua dela: o passo que já aconteceu ou não tem mais saldo fica de fora.
function trocar(poc: PocRow, notaId: string, o: OpcoesTroca, usuario: string) {
  const nota = notaPorId(notaId);
  if (!nota || nota.poc_id !== poc.id) throw new ErroHttp(404, 'Nota não encontrada.');
  const { op, motivo } = operacaoDe(nota);
  if (!op) throw new ErroHttp(422, `Esta nota não segue roteiro: ${motivo}.`);
  const roteiro = String(o.roteiro ?? '');
  if (!ROTEIRO.has(roteiro)) throw new ErroHttp(400, `Roteiro desconhecido: ${roteiro || '(vazio)'}.`);
  const anterior = op.roteiro;
  const docs = [op.id, ...relacionadasDe(op).map((r) => r.id)];
  const lista = docs.map(() => '?').join(', ');
  const substituidos = Number(executar(`UPDATE eventos SET situacao = 'substituido', motivo = ?, atualizado_em = ? WHERE situacao = 'planejado' AND nota_id IN (${lista})`,
    `Substituído pela troca de roteiro${anterior ? ` (${anterior} → ${roteiro})` : ` para ${roteiro}`}.`, agora(), ...docs).changes);
  executar('UPDATE notas SET roteiro = NULL WHERE id = ?', op.id);
  const continuacao = todos(`SELECT 1 FROM eventos WHERE situacao <> 'substituido' AND nota_id IN (${lista}) LIMIT 1`, ...docs).length > 0;
  const plano = planejarRoteiro(poc, [op.id], roteiro, o.intervaloDias ?? 1, { defasagem: o.defasagem as number | undefined, continuar: continuacao, incluirAusentes: !!o.incluirAusentes });
  if (!plano.itens.length) {
    const motivos = [...plano.bloqueios, ...plano.pulados].map((b) => `${b.id ? `${b.id}: ` : ''}${b.motivo}`);
    throw new ErroHttp(422, continuacao ? `Nada do ${roteiro} cabe mais nesta nota.` : `A nota não pode seguir o ${roteiro}.`, motivos);
  }
  const r = gravarRoteiro(poc, plano, usuario, { troca: true, de: anterior, substituidos, continuacao });
  return { ...r, roteiro, de: anterior, substituidos, continuacao, pulados: plano.pulados, defasagem: plano.defasagem, intervalo: plano.intervalo };
}

export const previaTroca = (pocId: string, notaId: string, o: OpcoesTroca, usuario: string) => simular(() => trocar(obterPoc(pocId), notaId, o, usuario));
export const trocarRoteiro = (pocId: string, notaId: string, o: OpcoesTroca, usuario: string) => transacao(() => trocar(obterPoc(pocId), notaId, o, usuario));

// ---------------------------------------------------------------- painel

const LADO: Record<string, string> = { adquirente: 'de entrada', fornecedor: 'de saída' };
const CURTO: Record<Relacionada, string> = { complementar: 'nota complementar', devolucao: 'nota de devolução', cancelamento: 'XML de cancelamento' };

// O XML que falta para um roteiro caber, no texto do painel.
function xmlQueFalta(lado: string, precisa?: Relacionada): string {
  const nota = `uma nota ${LADO[lado]}`;
  if (!precisa) return `uma NF-e ${LADO[lado]}`;
  if (precisa === 'cancelamento') return `o XML do cancelamento de ${nota}`;
  return `uma NF-e ${precisa === 'complementar' ? 'complementar' : 'de devolução'} de ${nota}`;
}

interface Contagem { notas: Set<string>; avisado: Set<string>; recebido: Set<string>; naoRecebido: number; disponivel: number; planejado: string | null; exemplos: Map<string, string> }

export function cobertura(pocId: string) {
  const poc = obterPoc(pocId);
  const evs = todos<{ ente: Ente; tipo: string; nota_id: string; situacao: string; dia: string }>(
    "SELECT ente, tipo, nota_id, situacao, dia FROM eventos WHERE poc_id = ? AND situacao <> 'substituido' ORDER BY dia", pocId);
  const conta = new Map<string, Contagem>();
  for (const e of evs) {
    const k = chave(e.ente, e.tipo);
    const c = conta.get(k) ?? { notas: new Set(), avisado: new Set(), recebido: new Set(), naoRecebido: 0, disponivel: 0, planejado: null, exemplos: new Map() };
    c.notas.add(e.nota_id);
    if (e.situacao === 'avisado' || e.situacao === 'recebido') c.avisado.add(e.nota_id);
    if (e.situacao === 'recebido') c.recebido.add(e.nota_id);
    if (e.situacao === 'nao_recebido') c.naoRecebido++;
    if (e.situacao === 'disponivel') c.disponivel++;
    if (e.situacao === 'planejado' && (!c.planejado || e.dia < c.planejado)) c.planejado = e.dia;
    conta.set(k, c);
  }
  const rotulos = new Map(todos<NotaRow>('SELECT id, modelo, numero, chave FROM notas WHERE poc_id = ?', pocId).map((n) => [n.id, rotuloNota(n)]));
  // O que o lote permite: notas de entrada e de saída, com cancelamento, complementar ou devolução ligados.
  const ops = todos<NotaRow>("SELECT * FROM notas WHERE poc_id = ? AND situacao = 'aceita' AND operacao_id IS NOT NULL AND (finalidade IS NULL OR finalidade NOT IN ('complementar', 'devolucao'))", pocId);
  const tem = new Set<string>();
  for (const op of ops) {
    tem.add(`${op.papel}:`);
    for (const a of atributos(op, relacionadasDe(op))) tem.add(`${op.papel}:${a}`);
  }
  const linha = (ente: Ente, t: { n: string; id: string; mov: string; grupo: string }) => {
    const k = chave(ente, t.n);
    const c = conta.get(k);
    const roteiros = ROTEIROS.filter((r) => r[ente].some((p) => p.tipo === t.n));
    const viavel = roteiros.some((r) => tem.has(`${r.lado}:${r.precisa ?? ''}`));
    // Se um roteiro sem relacionada cobre o tipo, basta a nota do lado dele: a complementar, a devolução e o cancelamento
    // pressupõem essa nota.
    const bastam = roteiros.some((r) => !r.precisa) ? roteiros.filter((r) => !r.precisa) : roteiros;
    const faltas = [...new Set(bastam.map((r) => xmlQueFalta(r.lado, r.precisa)))];
    const curtas = [...new Set(bastam.map((r) => (r.precisa ? CURTO[r.precisa] : `nota ${LADO[r.lado]}`)))];
    const situacao = c?.recebido.size ? 'coberto'
      : c?.avisado.size ? 'não baixado'
        : c?.naoRecebido ? 'não recebido'
          : c?.disponivel ? (ente === 'cbs' ? 'disponível · espera o aviso ou o pedido' : 'disponível · espera o aviso')
            : c?.planejado ? `planejado · dia ${diaBr(c.planejado)}`
              : !viavel ? `falta ${curtas.length === 1 ? curtas[0] : 'nota'}`
                : 'sem nota no plano';
    const exemplos = c ? [...(c.recebido.size ? c.recebido : c.notas)].slice(0, 3).map((id) => ({ id, rotulo: rotulos.get(id) ?? id })) : [];
    return {
      ente, n: t.n, id: t.id, mov: t.mov, grupo: t.grupo, notas: c?.notas.size ?? 0, avisado: c?.avisado.size ?? 0, recebido: c?.recebido.size ?? 0,
      coberto: !!c?.recebido.size, situacao, planejadoEm: c?.planejado ?? null, roteiros: roteiros.map((r) => r.id), exemplos,
      falta: !c && !viavel ? faltas.join(' ou ') : null,
    };
  };
  const ibs = CATALOGO_IBS.map((t) => linha('ibs', t));
  const cbs = CATALOGO_CBS.map((t) => linha('cbs', t));
  // D-MG-05: os tipos que esperam o mesmo XML saem numa frase só.
  const porXml = new Map<string, string[]>();
  for (const l of [...ibs, ...cbs]) if (l.falta) porXml.set(l.falta, [...(porXml.get(l.falta) ?? []), l.id]);
  const faltam = [...porXml].map(([xml, tipos]) => ({
    xml, tipos, texto: `Para cobrir ${tipos.length > 1 ? `${tipos.slice(0, -1).join(', ')} e ${tipos[tipos.length - 1]}` : tipos[0]}, o lote precisa de ${xml}.`,
  }));
  const casos = situacaoCasos(pocId);
  const ligados = casos.filter((c) => c.ligado);
  const proximos = Object.fromEntries(todos<{ ente: Ente; dia: string }>("SELECT ente, MIN(dia) AS dia FROM eventos WHERE poc_id = ? AND situacao = 'planejado' GROUP BY ente", pocId).map((p) => [p.ente, p.dia]));
  const livres = ops.filter(semEventos).filter((op) => op.splithub !== 'ausente' || casoLigado(pocId, 'T08')).length;
  return {
    dia: poc.dia, competencia: poc.competencia, defasagem: poc.defasagem_cbs ?? 0,
    meta: META_TIPOS + ligados.length, recebidos: [...ibs, ...cbs].filter((l) => l.coberto).length + ligados.filter((c) => c.coberto).length,
    porEnte: {
      ibs: { meta: ibs.length, recebidos: ibs.filter((l) => l.coberto).length },
      cbs: { meta: cbs.length, recebidos: cbs.filter((l) => l.coberto).length },
      casos: { meta: ligados.length, recebidos: ligados.filter((c) => c.coberto).length, catalogo: casos.length },
    },
    notasLivres: livres, proximos: { ibs: proximos.ibs ?? null, cbs: proximos.cbs ?? null },
    ibs, cbs, casos, faltam,
  };
}

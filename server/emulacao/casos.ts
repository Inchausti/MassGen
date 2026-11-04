// Casos de transporte e falha (proposta v4.3, seção 07; D-MG-06): opcionais, ligados um a um. Ligar um caso põe ele na meta
// do painel de cobertura e, quando o MassGen precisa provocar a situação, arma a provocação no ente. A provocação sai
// na primeira oportunidade e desarma; "provocar de novo" arma outra vez. O caso fecha quando o SplitHub faz o que a
// seção 07 espera dele, medido pelo que chegou nos entes emulados (pedidos, downloads, solicitações manuais).
import { agora, executar, json, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import type { Ente } from './execucao.ts';

export type Caso = 'T01' | 'T02' | 'T03' | 'T04' | 'T05' | 'T06' | 'T07' | 'T08' | 'T09';

export interface DefCaso {
  id: Caso;
  nome: string;
  ente: 'cbs' | 'ibs' | 'ambos';
  espera: string; // o que o SplitHub precisa fazer (seção 07)
  provoca: string; // o que o MassGen faz quando o caso está ligado
  arma: Ente[]; // os entes em que o MassGen provoca a situação; vazio quando ela nasce do próprio uso
  comoFechar: string;
}

export const CASOS: DefCaso[] = [
  {
    id: 'T01', nome: 'Reentrega na janela de 8 dias', ente: 'cbs', espera: 'Sobrescrever o saldo, não somar', arma: [],
    provoca: 'Nada a provocar: o documento que muda em dois dias volta inteiro no aviso do dia e no pedido da janela.',
    comoFechar: 'Um documento de débitos ou créditos baixado em dois tíquetes, com fotos diferentes.',
  },
  {
    id: 'T02', nome: 'Link assinado expirado antes do download', ente: 'cbs', espera: 'Abrir nova solicitação', arma: ['cbs'],
    provoca: 'O próximo pedido do SplitHub conclui com o link já vencido; o download responde 410.',
    comoFechar: 'Um pedido novo no mesmo endpoint, concluído e baixado.',
  },
  {
    id: 'T03', nome: 'Processamento estourado (APURACAO-408)', ente: 'cbs', espera: 'Tentar de novo dentro do limite do dia', arma: ['cbs'],
    provoca: 'O próximo pedido do SplitHub termina em ERRO APURACAO-408, e o aviso leva o erro no lugar do link.',
    comoFechar: 'Um pedido novo no mesmo endpoint, concluído e baixado.',
  },
  {
    id: 'T04', nome: 'Arquivo Manual que repete lançamentos já entregues', ente: 'ibs', espera: 'Deduplicar pelo ID do lançamento', arma: [],
    provoca: 'Nada a provocar: o Arquivo Manual de um período já entregue traz os mesmos lançamentos do Delta.',
    comoFechar: 'Um Arquivo Manual baixado com um lançamento que já veio num Delta baixado.',
  },
  {
    id: 'T05', nome: 'Operação fatiada em dois arquivos', ente: 'ibs', espera: 'Remontar e só conferir o hash no conjunto', arma: ['ibs'],
    provoca: 'No próximo Delta com uma operação de dois ou mais lançamentos no dia, a operação sai em dois arquivos, com o hash acumulado.',
    comoFechar: 'Todos os arquivos daquele Delta baixados.',
  },
  {
    id: 'T06', nome: 'Dia sem Delta', ente: 'ibs', espera: 'Perceber a falta e pedir o Arquivo Manual', arma: ['ibs'],
    provoca: 'O próximo dia com lançamentos no IBS não gera Delta nem aviso; os lançamentos existem e ficam sem entrega.',
    comoFechar: 'Um Arquivo Manual do dia sem Delta baixado, com todos os lançamentos dele.',
  },
  {
    id: 'T07', nome: 'Hash que não fecha: falta uma linha', ente: 'ibs', espera: 'Recusar o saldo e abrir ocorrência', arma: ['ibs'],
    provoca: 'No próximo Delta com uma operação de dois ou mais lançamentos no dia, a primeira linha do dia some e o hash continua contando com ela.',
    comoFechar: 'Um Arquivo Manual baixado com a linha que faltou.',
  },
  {
    id: 'T08', nome: 'Evento de nota que não está no SplitHub', ente: 'ambos', espera: 'Gravar o movimento e abrir inconsistência (C-01)', arma: [],
    provoca: 'Nada a provocar: marque a nota como ausente no SplitHub e mande os eventos dela com "incluir não importadas".',
    comoFechar: 'Eventos de uma nota ausente no SplitHub recebidos nos dois entes.',
  },
  {
    id: 'T09', nome: 'Webhook sem resposta 2xx', ente: 'ambos', espera: 'O MassGen repete; o SplitHub não pode duplicar ao receber de novo', arma: ['ibs', 'cbs'],
    provoca: 'No próximo aviso de cada ente, o MassGen descarta a primeira resposta 2xx e repete o mesmo aviso.',
    comoFechar: 'Nos dois entes, um aviso repetido (ou reenviado) que terminou em 2xx e teve o arquivo baixado.',
  },
];

export const CASO = new Map(CASOS.map((c) => [c.id, c]));

interface CasoRow { poc_id: string; caso: Caso; ligado: number; armado_ibs: number; armado_cbs: number; atualizado_por: string | null; atualizado_em: string }
interface InjecaoRow { id: number; poc_id: string; caso: Caso; ente: Ente; dia: string; ref_tipo: string | null; ref_id: string | null; detalhe: string; em: string }

const linha = (pocId: string, caso: Caso) => um<CasoRow>('SELECT * FROM casos WHERE poc_id = ? AND caso = ?', pocId, caso);

export const casoLigado = (pocId: string, caso: Caso) => !!linha(pocId, caso)?.ligado;
export const armado = (pocId: string, caso: Caso, ente: Ente) => !!linha(pocId, caso)?.[ente === 'ibs' ? 'armado_ibs' : 'armado_cbs'];

export function desarmar(pocId: string, caso: Caso, ente: Ente): void {
  executar(`UPDATE casos SET ${ente === 'ibs' ? 'armado_ibs' : 'armado_cbs'} = 0, atualizado_em = ? WHERE poc_id = ? AND caso = ?`, agora(), pocId, caso);
}

// O que o MassGen provocou fica registrado, para o painel dizer o que espera do SplitHub.
export function registrarInjecao(pocId: string, caso: Caso, ente: Ente, dia: string, ref: { tipo: string; id: string } | null, detalhe: Record<string, unknown> = {}): void {
  desarmar(pocId, caso, ente);
  executar('INSERT INTO injecoes (poc_id, caso, ente, dia, ref_tipo, ref_id, detalhe, em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    pocId, caso, ente, dia, ref?.tipo ?? null, ref?.id ?? null, JSON.stringify(detalhe), agora());
}

// Ligar põe o caso na meta e arma a provocação; desligar tira e desarma. "rearmar" arma de novo um caso ligado.
export function definirCaso(pocId: string, id: string, dados: { ligado?: unknown; rearmar?: unknown }, usuario: string) {
  const def = CASO.get(id as Caso);
  if (!def) throw new ErroHttp(404, `Caso desconhecido: ${id}. Use T01 a T09.`);
  const atual = linha(pocId, def.id);
  const ligado = dados.ligado === undefined ? !!atual?.ligado : !!dados.ligado;
  if (dados.rearmar && !ligado) throw new ErroHttp(409, `Ligue o ${def.id} antes de provocar de novo.`);
  if (dados.rearmar && !def.arma.length) throw new ErroHttp(409, `O ${def.id} não tem o que provocar: ele nasce do próprio uso.`);
  const armar = (ente: Ente) => (ligado && def.arma.includes(ente) && (dados.rearmar || !atual?.ligado || (ente === 'ibs' ? atual.armado_ibs : atual.armado_cbs)) ? 1 : 0);
  executar(
    `INSERT INTO casos (poc_id, caso, ligado, armado_ibs, armado_cbs, atualizado_por, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (poc_id, caso) DO UPDATE SET ligado = excluded.ligado, armado_ibs = excluded.armado_ibs, armado_cbs = excluded.armado_cbs,
       atualizado_por = excluded.atualizado_por, atualizado_em = excluded.atualizado_em`,
    pocId, def.id, ligado ? 1 : 0, armar('ibs'), armar('cbs'), usuario, agora(),
  );
  return situacaoCasos(pocId).find((c) => c.id === def.id)!;
}

// ---------------------------------------------------------------- quando cada caso fecha

const baixado = 'EXISTS (SELECT 1 FROM cbs_downloads d WHERE d.tiquete_id = t.id)';

function t01(pocId: string): boolean {
  const linhas = todos<{ nota_id: string; endpoint: string; ultimo: string }>(
    `SELECT e.nota_id, t.endpoint, te.tiquete_id, MAX(e.dth_lancto) AS ultimo FROM cbs_tiquete_eventos te
       JOIN cbs_tiquetes t ON t.id = te.tiquete_id JOIN eventos e ON e.id = te.evento_id
      WHERE t.poc_id = ? AND t.endpoint IN ('debitos', 'creditos') AND ${baixado}
      GROUP BY e.nota_id, t.endpoint, te.tiquete_id`, pocId);
  const fotos = new Map<string, Set<string>>();
  for (const l of linhas) fotos.set(`${l.nota_id}:${l.endpoint}`, (fotos.get(`${l.nota_id}:${l.endpoint}`) ?? new Set()).add(l.ultimo));
  return [...fotos.values()].some((s) => s.size >= 2);
}

// T02 e T03: depois do tíquete provocado, um pedido novo no mesmo endpoint, concluído e baixado.
function pedidoDepois(pocId: string, inj: InjecaoRow): boolean {
  const t = um<{ endpoint: string; criado_em: string }>('SELECT endpoint, criado_em FROM cbs_tiquetes WHERE id = ?', inj.ref_id);
  if (!t) return false;
  return !!um(`SELECT 1 FROM cbs_tiquetes t WHERE t.poc_id = ? AND t.endpoint = ? AND t.origem = 'pedido' AND t.estado = 'CONCLUIDA' AND t.id <> ? AND t.criado_em >= ? AND ${baixado}`,
    pocId, t.endpoint, inj.ref_id, t.criado_em);
}

function t04(pocId: string): boolean {
  return !!um(
    `SELECT 1 FROM ibs_arquivo_eventos m JOIN arquivos am ON am.id = m.arquivo_id JOIN solicitacoes sm ON sm.id = am.solicitacao_id
       JOIN ibs_arquivo_eventos x ON x.evento_id = m.evento_id AND x.arquivo_id <> m.arquivo_id JOIN arquivos ad ON ad.id = x.arquivo_id
       JOIN solicitacoes sd ON sd.id = ad.solicitacao_id
      WHERE sm.poc_id = ? AND sm.tipo = 'MANUAL' AND sd.tipo = 'DIFERENCIAL'
        AND EXISTS (SELECT 1 FROM downloads a WHERE a.arquivo_id = am.id) AND EXISTS (SELECT 1 FROM downloads b WHERE b.arquivo_id = ad.id)
      LIMIT 1`, pocId);
}

const t05 = (inj: InjecaoRow) =>
  !um('SELECT 1 FROM arquivos a WHERE a.solicitacao_id = ? AND NOT EXISTS (SELECT 1 FROM downloads d WHERE d.arquivo_id = a.id)', inj.ref_id)
  && !!um('SELECT 1 FROM arquivos WHERE solicitacao_id = ?', inj.ref_id);

const recebidos = (ids: string[]) =>
  ids.length > 0 && um<{ n: number }>(`SELECT COUNT(*) AS n FROM eventos WHERE situacao = 'recebido' AND id IN (${ids.map(() => '?').join(', ')})`, ...ids)!.n === ids.length;

function t08(pocId: string): boolean {
  return !!um(
    `SELECT 1 FROM notas n WHERE n.poc_id = ? AND n.splithub = 'ausente'
        AND EXISTS (SELECT 1 FROM eventos e WHERE e.nota_id = n.id AND e.ente = 'ibs' AND e.situacao = 'recebido')
        AND EXISTS (SELECT 1 FROM eventos e WHERE e.nota_id = n.id AND e.ente = 'cbs' AND e.situacao = 'recebido')`, pocId);
}

function t09(pocId: string, ente: Ente): boolean {
  const repetido = "a.resultado = 'ok' AND (a.tentativas >= 2 OR a.reenvio_de IS NOT NULL)";
  return ente === 'ibs'
    ? !!um(`SELECT 1 FROM avisos a WHERE a.poc_id = ? AND a.ente = 'ibs' AND ${repetido}
              AND EXISTS (SELECT 1 FROM arquivos r JOIN downloads d ON d.arquivo_id = r.id WHERE r.solicitacao_id = a.solicitacao_id)`, pocId)
    : !!um(`SELECT 1 FROM avisos a WHERE a.poc_id = ? AND a.ente = 'cbs' AND ${repetido}
              AND EXISTS (SELECT 1 FROM cbs_downloads d WHERE d.tiquete_id = a.tiquete_id)`, pocId);
}

export interface SituacaoCaso extends DefCaso {
  ligado: boolean;
  armado: Ente[];
  coberto: boolean;
  porEnte?: Partial<Record<Ente, boolean>>;
  provocacoes: { ente: Ente; dia: string; refTipo: string | null; refId: string | null; detalhe: Record<string, unknown>; em: string }[];
  situacao: string;
}

export function situacaoCasos(pocId: string): SituacaoCaso[] {
  const linhas = new Map(todos<CasoRow>('SELECT * FROM casos WHERE poc_id = ?', pocId).map((c) => [c.caso, c]));
  const injecoes = todos<InjecaoRow>('SELECT * FROM injecoes WHERE poc_id = ? ORDER BY id', pocId);
  return CASOS.map((def) => {
    const l = linhas.get(def.id);
    const inj = injecoes.filter((i) => i.caso === def.id);
    let porEnte: SituacaoCaso['porEnte'];
    let coberto: boolean;
    switch (def.id) {
      case 'T01': coberto = t01(pocId); break;
      case 'T02': case 'T03': coberto = inj.some((i) => pedidoDepois(pocId, i)); break;
      case 'T04': coberto = t04(pocId); break;
      case 'T05': coberto = inj.some(t05); break;
      case 'T06': coberto = inj.some((i) => recebidos(json<{ eventos?: string[] }>(i.detalhe, {}).eventos ?? [])); break;
      case 'T07': coberto = inj.some((i) => !!i.ref_id && recebidos([i.ref_id])); break;
      case 'T08': coberto = t08(pocId); break;
      case 'T09': porEnte = { ibs: t09(pocId, 'ibs'), cbs: t09(pocId, 'cbs') }; coberto = !!porEnte.ibs && !!porEnte.cbs; break;
    }
    const armadoEm: Ente[] = l ? (['ibs', 'cbs'] as Ente[]).filter((e) => (e === 'ibs' ? l.armado_ibs : l.armado_cbs)) : [];
    const ligado = !!l?.ligado;
    const meio = porEnte && (porEnte.ibs || porEnte.cbs) ? `coberto ${porEnte.ibs ? 'no IBS' : 'na CBS'}; falta ${porEnte.ibs ? 'a CBS' : 'o IBS'} · ` : '';
    const situacao = coberto ? 'coberto'
      : !ligado ? 'desligado'
        : armadoEm.length ? `${meio}armado · espera a próxima oportunidade ${armadoEm.length === 2 ? 'nos dois entes' : armadoEm[0] === 'ibs' ? 'no IBS' : 'na CBS'}`
          : inj.length ? `${meio}provocado · espera o SplitHub: ${def.espera.charAt(0).toLowerCase()}${def.espera.slice(1)}`
            : `espera o SplitHub: ${def.comoFechar.charAt(0).toLowerCase()}${def.comoFechar.slice(1, -1)}`;
    return {
      ...def, ligado, armado: armadoEm, coberto, porEnte, situacao,
      provocacoes: inj.map((i) => ({ ente: i.ente, dia: i.dia, refTipo: i.ref_tipo, refId: i.ref_id, detalhe: json(i.detalhe, {}), em: i.em })),
    };
  });
}

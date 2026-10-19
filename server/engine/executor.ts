// Envio da massa ao destino e conferência do resultado, registro a registro.
import { agora, executar, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { obter } from '../core/caminhos.ts';
import { conferir, codigoDeErro } from '../core/conferir.ts';
import { conferirDominio } from '../config.ts';
import { dominiosProducaoDo, obterDestino, operacaoPara, type Destino, type Operacao } from '../servicos/destinos.ts';
import { modelosDoPacote } from '../servicos/pacotes.ts';
import { vincular } from '../servicos/cadastros.ts';
import { auditar, usuarioAtual } from '../auditoria.ts';
import { linhaRegistro, obterExecucaoLinha, type Registro } from '../servicos/execucoes.ts';
import {
  aguardarVez, cabecalhosDeAutenticacao, enviarHttp, ErroEnvio, esquecerToken, montarUrl, obterToken, registrar, type Requisicao, type Resposta,
} from './cliente.ts';

interface Controle { pausar: boolean; cancelar: boolean }
const ativos = new Map<string, Controle>();

const esperar = (ms: number, ctl?: Controle) => new Promise<void>((resolve) => {
  const fim = Date.now() + ms;
  const tique = () => (ctl?.cancelar || ctl?.pausar || Date.now() >= fim ? resolve() : setTimeout(tique, Math.min(250, fim - Date.now())));
  tique();
});

function status(execucaoId: string, s: string, etapa: string | null = null, erro: string | null = null): void {
  const extra = s === 'enviando' ? ", iniciado_em = COALESCE(iniciado_em, ?)" : ['concluida', 'cancelada', 'erro'].includes(s) ? ', finalizado_em = ?' : '';
  const params: (string | null)[] = [s, etapa, erro];
  if (extra) params.push(agora());
  executar(`UPDATE execucoes SET status = ?, etapa = ?, erro = COALESCE(?, erro)${extra} WHERE id = ?`, ...params, execucaoId);
}

function atualizarRegistro(id: string, campos: Record<string, string | null>): void {
  const chaves = Object.keys(campos);
  executar(`UPDATE registros SET ${chaves.map((k) => `${k} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`, ...chaves.map((k) => campos[k]), agora(), id);
}

// ---------------------------------------------------------------- montagem da requisição

function idsRemotosDosPais(r: Registro): Record<string, string | null> {
  const saida: Record<string, string | null> = {};
  for (const [rel, paiId] of Object.entries(r.pais)) {
    saida[rel] = um<{ id_remoto: string | null }>('SELECT id_remoto FROM registros WHERE id = ?', paiId)?.id_remoto ?? null;
  }
  return saida;
}

class Bloqueio extends Error {}

// Resolve {{$id}}, {{$remoto.relacao}}, {{$var.x}}, {{$exec.codigo}} e {{campo.do.registro}} no texto.
function resolverTexto(t: string, ctx: { r: Registro; remotos: Record<string, string | null>; destino: Destino; codigo: string }, json_ = false): string {
  return t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, chave: string) => {
    let v: unknown;
    if (chave === '$id') v = ctx.r.idRemoto;
    else if (chave.startsWith('$remoto.')) {
      const rel = chave.slice(8);
      v = ctx.remotos[rel];
      if (!v) throw new Bloqueio(`O pai ${rel} não tem id no destino: ele não foi criado ou foi recusado.`);
    } else if (chave.startsWith('$var.')) v = ctx.destino.variaveis[chave.slice(5)];
    else if (chave === '$exec.codigo') v = ctx.codigo;
    else if (chave in ctx.destino.variaveis) v = ctx.destino.variaveis[chave];
    else v = obter(ctx.r.dados, chave);
    if (v === undefined || v === null) return json_ ? '' : '';
    return json_ ? JSON.stringify(v).slice(1, -1) : encodeURIComponent(String(v));
  });
}

function resolverDados(v: unknown, remotos: Record<string, string | null>): unknown {
  if (typeof v === 'string') {
    const m = v.match(/^\{\{\$remoto\.(\w+)\}\}$/);
    if (m) {
      const id = remotos[m[1]];
      if (!id) throw new Bloqueio(`O pai ${m[1]} não tem id no destino: ele não foi criado ou foi recusado.`);
      return id;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => resolverDados(x, remotos));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolverDados(x, remotos)]));
  return v;
}

async function montar(destino: Destino, op: Operacao, r: Registro, codigo: string, execucaoId: string, comCorpo: boolean, chave?: string, rastreio?: string): Promise<Requisicao> {
  const remotos = idsRemotosDosPais(r);
  const ctx = { r, remotos, destino, codigo };
  const url = montarUrl(destino, resolverTexto(op.rota, ctx));
  const dom = conferirDominio(url, dominiosProducaoDo(destino));
  if (!dom.ok) throw new ErroEnvio(dom.motivo);
  let corpo: string | undefined;
  if (comCorpo) {
    corpo = op.usarCorpo && op.corpo ? resolverTexto(op.corpo, ctx, true) : JSON.stringify(resolverDados(r.dados, remotos));
  }
  const cabecalhos: Record<string, string> = { Accept: 'application/json' };
  for (const [k, v] of Object.entries({ ...destino.cabecalhos, ...op.cabecalhos })) cabecalhos[k] = resolverTexto(String(v), ctx).replace(/%20/g, ' ');
  if (corpo && !Object.keys(cabecalhos).some((k) => k.toLowerCase() === 'content-type')) cabecalhos['Content-Type'] = 'application/json';
  if (chave && destino.idempotencia.cabecalho) cabecalhos[destino.idempotencia.cabecalho] = chave;
  if (rastreio && destino.rastreio?.cabecalho) cabecalhos[destino.rastreio.cabecalho] = rastreio;
  Object.assign(cabecalhos, await cabecalhosDeAutenticacao(destino, { execucaoId }));
  return { metodo: op.metodo, url, cabecalhos, corpo };
}

function esperaDe(res: Resposta, tentativa: number): number {
  const ra = Number(res.cabecalhos['retry-after']);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra, 120) * 1000;
  const reset = Number(res.cabecalhos['ratelimit-reset']);
  if (res.status === 429 && Number.isFinite(reset) && reset > 0) return Math.min(reset, 120) * 1000;
  return Math.min(2 ** (tentativa - 1), 30) * 1000;
}

// Uma chamada com retentativa: 429 espera o Retry-After; 5xx e falha de rede, espera exponencial com a mesma chave.
async function chamar(
  destino: Destino, op: Operacao, r: Registro, ctx: { codigo: string; execucaoId: string; fase: 'envio' | 'conferencia' | 'reenvio'; chave?: string; ctl?: Controle },
  avaliarResultado: (res: Resposta) => { ok: boolean; codigo?: string },
): Promise<Resposta> {
  const maximo = Math.max(1, Number(destino.limites.tentativas) || 4);
  let res: Resposta = { cabecalhos: {}, corpoTexto: '', corpo: undefined, duracaoMs: 0 };
  for (let tentativa = 1; tentativa <= maximo; tentativa++) {
    const rastreio = `MG-${ctx.codigo}-${r.entidade}-${r.indice}-${ctx.fase}-${tentativa}`;
    const req = await montar(destino, op, r, ctx.codigo, ctx.execucaoId, ctx.fase !== 'conferencia', ctx.chave, rastreio);
    await aguardarVez(destino);
    res = await enviarHttp(req, destino.limites.timeoutMs ?? 30000);
    const av = res.status ? avaliarResultado(res) : { ok: false };
    const vaiRepetir = tentativa < maximo && (!res.status || res.status >= 500 || res.status === 429 || (res.status === 401 && tentativa === 1 && destino.autenticacao.tipo === 'oauth2_cc'));
    registrar({
      execucaoId: ctx.execucaoId, destinoId: destino.id, registroId: r.id, operacaoId: op.id, fase: ctx.fase, entidade: r.entidade, tentativa,
      chaveIdempotencia: ctx.chave, resultado: !res.status ? 'erro' : av.ok ? 'ok' : 'divergente', codigoErro: av.codigo ?? codigoDeErro(res.corpo), rastreio,
    }, req, res, destino.autenticacao.tipo === 'chave_api' ? destino.autenticacao.cabecalho : undefined);
    if (!vaiRepetir) break;
    if (res.status === 401) { esquecerToken(destino.id); continue; }
    await esperar(esperaDe(res, tentativa), ctx.ctl);
    if (ctx.ctl?.cancelar) break;
  }
  return res;
}

// ---------------------------------------------------------------- envio de um registro

async function enviarRegistro(destino: Destino, r: Registro, codigo: string, execucaoId: string, idRemotoPath: string, ctl?: Controle, fase: 'envio' | 'reenvio' = 'envio', chaveExtra = ''): Promise<void> {
  const op = operacaoPara(destino.id, r.entidade, 'criar');
  if (!op) {
    atualizarRegistro(r.id, { status: 'erro', resultado: 'erro', diferencas: JSON.stringify([`O destino não tem operação de criar para ${r.entidade}. Cadastre-a em Estrutura de APIs.`]) });
    return;
  }
  atualizarRegistro(r.id, { status: 'enviando' });
  const chave = destino.idempotencia.cabecalho ? `massgen-${codigo}-${r.entidade}-${r.indice}${chaveExtra}` : undefined;
  let res: Resposta;
  try {
    res = await chamar(destino, op, r, { codigo, execucaoId, fase, chave, ctl }, (x) => conferir(r.esperado, x.status, x.corpo));
  } catch (e) {
    const bloqueado = e instanceof Bloqueio;
    atualizarRegistro(r.id, { status: bloqueado ? 'bloqueado' : 'erro', resultado: bloqueado ? 'bloqueado' : 'erro', diferencas: JSON.stringify([(e as Error).message]) });
    return;
  }
  if (!res.status) {
    atualizarRegistro(r.id, { status: 'erro', resultado: 'erro', obtido: null, diferencas: JSON.stringify([res.erro ?? 'Sem resposta do destino.']) });
    return;
  }
  const c = conferir(r.esperado, res.status, res.corpo);
  const sucesso = res.status >= 200 && res.status < 300;
  const idRemoto = sucesso ? obter(res.corpo, idRemotoPath) : undefined;
  atualizarRegistro(r.id, {
    status: 'enviado',
    id_remoto: idRemoto !== undefined && idRemoto !== null ? String(idRemoto) : null,
    obtido: JSON.stringify({ status: res.status, codigo: c.codigo }),
    resultado: c.ok ? 'ok' : 'divergente',
    diferencas: JSON.stringify(c.diferencas),
  });
  if (r.cadastroId && idRemoto && sucesso) vincular(r.cadastroId, destino.id, String(idRemoto), execucaoId);
}

async function conferirRegistro(destino: Destino, r: Registro, codigo: string, execucaoId: string, ctl?: Controle): Promise<void> {
  const conf = r.conferencia!;
  const op = operacaoPara(destino.id, r.entidade, conf.acao ?? 'consultar');
  if (!op) {
    atualizarRegistro(r.id, { status: 'conferido', diferencas: JSON.stringify([...r.diferencas, `Conferência: o destino não tem operação de ${conf.acao ?? 'consultar'} para ${r.entidade}.`]) });
    return;
  }
  const tentativas = Math.max(1, conf.tentativas ?? 1);
  let ultima = conferir(conf.esperado, undefined, undefined);
  let statusObtido: number | undefined;
  for (let i = 1; i <= tentativas; i++) {
    let res: Resposta;
    try {
      res = await chamar(destino, op, r, { codigo, execucaoId, fase: 'conferencia', ctl }, (x) => conferir(conf.esperado, x.status, x.corpo));
    } catch (e) {
      ultima = { ok: false, diferencas: [(e as Error).message] };
      break;
    }
    statusObtido = res.status;
    ultima = conferir(conf.esperado, res.status, res.corpo);
    if (ultima.ok || ctl?.cancelar) break;
    if (i < tentativas) await esperar(conf.intervaloMs ?? 2000, ctl);
  }
  const obtido = { ...(r.obtido ?? {}), conferencia: { status: statusObtido } };
  atualizarRegistro(r.id, {
    status: 'conferido',
    obtido: JSON.stringify(obtido),
    resultado: ultima.ok ? 'ok' : 'divergente',
    diferencas: JSON.stringify(ultima.ok ? [] : ultima.diferencas.map((d) => `Conferência: ${d}`)),
  });
}

// ---------------------------------------------------------------- execução

export function estaAtiva(execucaoId: string): boolean {
  return ativos.has(execucaoId);
}

export function iniciarEnvio(execucaoId: string, opcoes: { reenviarFalhas?: boolean } = {}): void {
  const l = obterExecucaoLinha(execucaoId);
  if (ativos.has(execucaoId)) throw new ErroHttp(409, 'O envio desta execução já está em andamento.');
  if (!l.destino_id) throw new ErroHttp(422, 'A execução não tem destino.');
  const destino = obterDestino(l.destino_id as string);
  if (!destino.ativo) throw new ErroHttp(422, 'O destino está inativo.');
  const dom = conferirDominio(destino.baseUrl, dominiosProducaoDo(destino));
  if (!dom.ok) throw new ErroHttp(422, dom.motivo!);
  if (['concluida', 'cancelada'].includes(l.status as string) && !opcoes.reenviarFalhas) {
    throw new ErroHttp(409, 'Esta execução já terminou. Use "Reenviar falhas" ou gere uma nova.');
  }
  if (opcoes.reenviarFalhas) {
    executar("UPDATE registros SET status = 'gerado', resultado = NULL, diferencas = '[]', obtido = NULL WHERE execucao_id = ? AND status IN ('erro', 'bloqueado')", execucaoId);
  }
  const ctl: Controle = { pausar: false, cancelar: false };
  ativos.set(execucaoId, ctl);
  executar('UPDATE execucoes SET enviado_por = ? WHERE id = ?', usuarioAtual().usuario, execucaoId);
  status(execucaoId, 'enviando', 'Enviando');
  executarEnvio(execucaoId, destino, l.codigo as string, ctl)
    .catch((e) => {
      console.error(e);
      status(execucaoId, 'erro', null, (e as Error).message);
      auditar('execucao.erro', `Execução ${l.codigo} parou com erro: ${(e as Error).message}`, { alvoTipo: 'execucao', alvoId: execucaoId, execucaoId });
    })
    .finally(() => ativos.delete(execucaoId));
}

async function executarEnvio(execucaoId: string, destino: Destino, codigo: string, ctl: Controle): Promise<void> {
  const modelos = destino.pacoteId ? modelosDoPacote(destino.pacoteId) : [];
  const idPath = (entidade: string) => modelos.find((m) => m.nome === entidade)?.idRemoto ?? 'id';
  // Antes do primeiro envio, valida a autenticação uma vez: se falhar, a execução para com o motivo.
  try {
    await cabecalhosDeAutenticacao(destino, { execucaoId });
  } catch (e) {
    status(execucaoId, 'interrompida', null, (e as Error).message);
    auditar('execucao.interromper', `Execução ${codigo} interrompida antes do envio: ${(e as Error).message}`, { alvoTipo: 'execucao', alvoId: execucaoId, execucaoId });
    return;
  }
  const pendentes = todos("SELECT * FROM registros WHERE execucao_id = ? AND status = 'gerado' ORDER BY ordem, indice", execucaoId).map(linhaRegistro);
  for (const [i, r] of pendentes.entries()) {
    if (ctl.cancelar) { status(execucaoId, 'cancelada'); return; }
    if (ctl.pausar) { status(execucaoId, 'pausada', null); return; }
    if (i % 25 === 0) executar('UPDATE execucoes SET etapa = ? WHERE id = ?', `Enviando ${r.entidade}`, execucaoId);
    await enviarRegistro(destino, r, codigo, execucaoId, idPath(r.entidade), ctl);
  }
  status(execucaoId, 'conferindo', 'Conferindo');
  const aConferir = todos(
    "SELECT * FROM registros WHERE execucao_id = ? AND status = 'enviado' AND resultado = 'ok' AND conferencia IS NOT NULL AND id_remoto IS NOT NULL ORDER BY ordem, indice",
    execucaoId,
  ).map(linhaRegistro);
  for (const r of aConferir) {
    if (ctl.cancelar) { status(execucaoId, 'cancelada'); return; }
    if (ctl.pausar) { status(execucaoId, 'pausada', null); return; }
    await conferirRegistro(destino, r, codigo, execucaoId, ctl);
  }
  status(execucaoId, 'concluida');
  const fim = um<{ ok: number; total: number }>("SELECT SUM(resultado = 'ok') AS ok, COUNT(*) AS total FROM registros WHERE execucao_id = ?", execucaoId);
  auditar('execucao.concluir', `Execução ${codigo} concluída: ${fim?.ok ?? 0} de ${fim?.total ?? 0} registros conforme o gabarito`, { alvoTipo: 'execucao', alvoId: execucaoId, execucaoId, detalhes: fim });
}

export function pausar(execucaoId: string): void {
  const c = ativos.get(execucaoId);
  if (!c) throw new ErroHttp(409, 'Não há envio em andamento nesta execução.');
  c.pausar = true;
}

export function cancelar(execucaoId: string): void {
  const c = ativos.get(execucaoId);
  if (c) { c.cancelar = true; return; }
  const l = obterExecucaoLinha(execucaoId);
  if (['pausada', 'interrompida', 'gerada'].includes(l.status as string)) status(execucaoId, 'cancelada');
  else throw new ErroHttp(409, 'Não há envio para cancelar.');
}

// Reenvia um registro isolado, a partir de uma requisição do monitor: mesma chave de idempotência ou uma nova.
export async function reenviarRegistro(requisicaoId: number, novaChave: boolean): Promise<void> {
  const req = um<{ registro_id: string | null; execucao_id: string | null }>('SELECT registro_id, execucao_id FROM requisicoes WHERE id = ?', requisicaoId);
  if (!req?.registro_id || !req.execucao_id) throw new ErroHttp(422, 'Esta requisição não pertence a um registro de massa.');
  if (ativos.has(req.execucao_id)) throw new ErroHttp(409, 'Aguarde o fim do envio em andamento para reenviar um registro.');
  const l = obterExecucaoLinha(req.execucao_id);
  const destino = obterDestino(l.destino_id as string);
  const r = linhaRegistro(um('SELECT * FROM registros WHERE id = ?', req.registro_id)!);
  const modelos = destino.pacoteId ? modelosDoPacote(destino.pacoteId) : [];
  const n = (um<{ n: number }>("SELECT COUNT(*) AS n FROM requisicoes WHERE registro_id = ? AND fase = 'reenvio'", r.id)?.n ?? 0) + 1;
  await enviarRegistro(destino, r, l.codigo as string, req.execucao_id, modelos.find((m) => m.nome === r.entidade)?.idRemoto ?? 'id', undefined, 'reenvio', novaChave ? `-r${n}` : '');
}

// Testar conexão: autenticação e uma leitura configurada no destino.
export async function testarConexao(destinoId: string) {
  const destino = obterDestino(destinoId);
  const etapas: { nome: string; ok: boolean; detalhe: string; ms?: number }[] = [];
  const dom = conferirDominio(destino.baseUrl, dominiosProducaoDo(destino));
  etapas.push({ nome: 'Domínio', ok: dom.ok, detalhe: dom.ok ? `${new URL(destino.baseUrl).host} está na lista permitida.` : dom.motivo! });
  let auth: Record<string, string> = {};
  if (dom.ok) {
    try {
      const inicio = performance.now();
      if (destino.autenticacao.tipo === 'oauth2_cc') {
        const t = await obterToken(destino, { forcar: true });
        etapas.push({ nome: 'Token', ok: true, ms: Math.round(performance.now() - inicio), detalhe: `Token obtido${t.escopos ? `. Escopos: ${Array.isArray(t.escopos) ? t.escopos.join(', ') : String(t.escopos)}` : ''}.` });
      }
      auth = await cabecalhosDeAutenticacao(destino);
      if (destino.autenticacao.tipo !== 'oauth2_cc' && destino.autenticacao.tipo !== 'nenhuma') etapas.push({ nome: 'Credencial', ok: true, detalhe: 'Credencial encontrada no cofre.' });
    } catch (e) {
      etapas.push({ nome: 'Autenticação', ok: false, detalhe: (e as Error).message });
    }
  }
  const teste = destino.teste?.rota ? destino.teste : undefined;
  if (dom.ok && etapas.every((e) => e.ok)) {
    if (!teste) {
      etapas.push({ nome: 'Leitura', ok: true, detalhe: 'Sem chamada de teste configurada: defina uma em Configuração, se quiser.' });
    } else {
      const req: Requisicao = { metodo: teste.metodo ?? 'GET', url: montarUrl(destino, teste.rota!), cabecalhos: { Accept: 'application/json', ...destino.cabecalhos, ...auth } };
      const res = await enviarHttp(req, destino.limites.timeoutMs ?? 30000);
      const ok = !!res.status && res.status < 400;
      registrar({ destinoId: destino.id, fase: 'teste', resultado: ok ? 'ok' : 'erro', codigoErro: codigoDeErro(res.corpo) }, req, res);
      const limites = ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'].filter((h) => res.cabecalhos[h]).map((h) => `${h}: ${res.cabecalhos[h]}`);
      etapas.push({
        nome: 'Leitura', ok, ms: res.duracaoMs,
        detalhe: res.erro ? res.erro : `${req.metodo} ${teste.rota} respondeu ${res.status}${limites.length ? ` · ${limites.join(' · ')}` : ''}.`,
      });
    }
  }
  const resultado = { ok: etapas.every((e) => e.ok), etapas, em: agora() };
  executar('UPDATE destinos SET ultimo_teste = ? WHERE id = ?', JSON.stringify(resultado), destinoId);
  return resultado;
}

export function execucoesAtivas(): string[] {
  return [...ativos.keys()];
}

// Receita Federal emulada (proposta v4.3, seção 03; APIs de Apuração da CBS v2). As rotas ficam em /entes/cbs, com os
// caminhos da documentação: token OAuth 2.0 (client credentials), as quatro solicitações com o HEAD na urlRetorno, a
// situação do tíquete e o link assinado. O SplitHub usa a mesma collection que vai usar contra a Receita Federal; muda a
// URL base e a credencial. Cada chamada que chega fica registrada, sem segredo e sem o link assinado.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config, conferirDominio } from '../config.ts';
import { agora, executar, novoId, todos, um } from '../db.ts';
import { ErroHttp, type Ctx, type Resposta } from '../http.ts';
import { gravarRequisicao, sha256, usuarioAtual } from '../auditoria.ts';
import { enviarHttp } from '../engine/cliente.ts';
import { ENDPOINTS, type Endpoint } from '../emulacao/catalogo-cbs.ts';
import {
  LIMITE_POR_DIA, abrirPedido, assinaturaDe, expirou, marcarProcessando, pedidosNoDia, processarPedido, registrarDownloadCbs, tiquetePorAssinatura,
  type TiqueteRow,
} from '../emulacao/cbs.ts';
import { armado, registrarInjecao } from '../emulacao/casos.ts';
import { obterPoc, type PocRow } from '../emulacao/execucao.ts';
import { T09_DESCARTE, entes, segredoConfere, type ResultadoAviso } from './ibs.ts';

export const PREFIXO_CBS = '/entes/cbs';
export const urlCbs = () => `${config.urlPublica}${PREFIXO_CBS}`;
const TOKEN_SEGUNDOS = 3600;
// Tempo de atendimento do pedido no emulador: curto, para a POC andar; a documentação admite até 240 minutos.
const PROCESSAMENTO_MS = 400;

const responder = (status: number, corpo: unknown): Resposta => ({
  __resposta: true, status, corpo: JSON.stringify(corpo), cabecalhos: { 'content-type': 'application/json; charset=utf-8' },
});
const erro = (status: number, codigoErro: string, mensagemErro: string) => responder(status, { codigoErro, mensagemErro });

const ipDe = (req: IncomingMessage) => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '');
const MASCARA = '••••••';
// O link assinado é segredo temporário (A.4): não vai para o registro de chamadas, nem para o aviso gravado.
const semSegredo = (texto: string) => texto
  .replace(/("(?:client_secret|access_token)"\s*:\s*")[^"]*(")/gi, `$1${MASCARA}$2`)
  .replace(/(\/download\/v2\/)[^"/?\s]+/g, `$1${MASCARA}`);

export const linkAssinado = (t: TiqueteRow) => `${urlCbs()}/download/v2/${assinaturaDe(t)}`;

// ---------------------------------------------------------------- autenticação

function credencialDe(req: IncomingMessage, corpo: Record<string, unknown> | undefined): { id: string; segredo: string } | undefined {
  const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
  if (basic) {
    const [id, ...resto] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    return { id, segredo: resto.join(':') };
  }
  if (corpo?.client_id && corpo?.client_secret) return { id: String(corpo.client_id), segredo: String(corpo.client_secret) };
  return undefined;
}

function pocDoToken(req: IncomingMessage): PocRow | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
  if (!m) return undefined;
  const t = um<{ poc_id: string; expira_em: string }>('SELECT poc_id, expira_em FROM cbs_tokens WHERE token_hash = ?', sha256(m[1].trim()));
  if (!t || t.expira_em < agora()) return undefined;
  return um<PocRow>('SELECT * FROM pocs WHERE id = ?', t.poc_id);
}

type Autenticacao = 'bearer' | 'nenhuma';

function rota(metodo: string, padrao: string, auth: Autenticacao, fn: (ctx: Ctx, poc: PocRow | undefined) => Resposta | Promise<Resposta> | { r: Resposta; poc?: PocRow }): void {
  entes.add(metodo, `${PREFIXO_CBS}${padrao}`, async (ctx) => {
    const inicio = performance.now();
    let poc = auth === 'bearer' ? pocDoToken(ctx.req) : undefined;
    let r: Resposta;
    if (auth === 'bearer' && !poc) r = erro(401, 'APURACAO-401', 'Token ausente, inválido ou vencido. Peça um novo em /token.');
    else {
      try {
        const x = await fn(ctx, poc);
        if ('__resposta' in x) r = x;
        else { r = x.r; poc = x.poc ?? poc; }
      } catch (e) {
        r = e instanceof ErroHttp ? erro(e.status, e.status === 400 ? 'APURACAO-001' : `APURACAO-${e.status}`, e.message) : erro(500, 'APURACAO-500', (e as Error).message);
      }
    }
    executar(
      'INSERT INTO chamadas (poc_id, ente, metodo, rota, status, ip, agente, req_corpo, res_corpo, duracao_ms, em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      poc?.id ?? null, 'cbs', metodo, semSegredo(ctx.req.url ?? ''), r.status, ipDe(ctx.req), String(ctx.req.headers['user-agent'] ?? '').slice(0, 200),
      ctx.corpo === undefined ? null : semSegredo(JSON.stringify(ctx.corpo)).slice(0, 4000),
      typeof r.corpo === 'string' ? semSegredo(r.corpo).slice(0, 4000) : `(arquivo de ${r.corpo.length} bytes)`, Math.round(performance.now() - inicio), agora(),
    );
    return r;
  }, { publico: true });
}

// ---------------------------------------------------------------- token (Receita Integra)

rota('POST', '/token', 'nenhuma', ({ req, corpo }) => {
  const c = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  if (String(c.grant_type ?? '') !== 'client_credentials') return responder(400, { error: 'unsupported_grant_type', error_description: 'Use grant_type=client_credentials.' });
  const cred = credencialDe(req, c);
  const poc = cred ? um<PocRow>('SELECT * FROM pocs WHERE cbs_client_id = ?', cred.id) : undefined;
  if (!poc || !segredoConfere(cred!.segredo, poc.cbs_secret_hash)) return responder(401, { error: 'invalid_client', error_description: 'client_id ou client_secret inválido.' });
  const token = randomBytes(32).toString('base64url');
  executar('DELETE FROM cbs_tokens WHERE expira_em < ?', agora());
  executar('INSERT INTO cbs_tokens (token_hash, poc_id, expira_em, criado_em) VALUES (?, ?, ?, ?)', sha256(token), poc.id, new Date(Date.now() + TOKEN_SEGUNDOS * 1000).toISOString(), agora());
  return { r: responder(200, { access_token: token, token_type: 'Bearer', expires_in: TOKEN_SEGUNDOS }), poc };
});

// ---------------------------------------------------------------- validação da urlRetorno (HEAD)

const LOOPBACK = (h: string) => h === 'localhost' || h === '[::1]' || h.startsWith('127.');

export function validarUrlRetorno(url: string): string | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return 'urlRetorno inválida.'; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK(u.hostname))) return 'urlRetorno precisa ser HTTPS.';
  const dom = conferirDominio(url);
  return dom.ok ? undefined : `urlRetorno recusada pelo MassGen: ${dom.motivo}`;
}

// A Receita Federal faz um HEAD na urlRetorno antes de aceitar (A.3). Fica no monitor, como cada tentativa de aviso.
export async function headUrlRetorno(url: string, rastreio: string | null): Promise<{ ok: boolean; status?: number; motivo?: string }> {
  const motivo = validarUrlRetorno(url);
  if (motivo) return { ok: false, motivo };
  const r = await enviarHttp({ metodo: 'HEAD', url, cabecalhos: {} }, 10000);
  const ok = !!r.status && r.status >= 200 && r.status < 300;
  gravarRequisicao({
    execucao_id: null, destino_id: null, registro_id: null, operacao_id: null, fase: 'head', entidade: 'cbs', metodo: 'HEAD', url, status: r.status ?? null,
    duracao_ms: r.duracaoMs, tentativa: 1, chave_idempotencia: null, req_cabecalhos: '{}', req_corpo: null, res_cabecalhos: JSON.stringify(r.cabecalhos),
    res_corpo: null, erro: r.erro ?? null, codigo_erro: null, resultado: ok ? 'ok' : 'erro', criado_em: agora(), usuario: usuarioAtual().usuario, rastreio, corpo_hash: null,
  });
  return ok ? { ok, status: r.status } : { ok, status: r.status, motivo: r.erro ?? `o HEAD respondeu ${r.status}` };
}

// "Validar e salvar" da tela: a urlRetorno do aviso sem pedido (D-MG-03) passa pelo mesmo HEAD.
export async function cadastrarUrlRetorno(pocId: string, url: unknown) {
  const poc = obterPoc(pocId);
  const u = String(url ?? '').trim();
  if (!u) {
    executar('UPDATE pocs SET cbs_url_retorno = NULL, cbs_url_validada_em = NULL, atualizado_em = ? WHERE id = ?', agora(), poc.id);
    return { urlRetorno: null, validadaEm: null };
  }
  const h = await headUrlRetorno(u, `poc:${poc.id}`);
  if (!h.ok) throw new ErroHttp(400, `A urlRetorno não passou na validação: ${h.motivo}.`);
  const quando = agora();
  executar('UPDATE pocs SET cbs_url_retorno = ?, cbs_url_validada_em = ?, atualizado_em = ? WHERE id = ?', u, quando, agora(), poc.id);
  return { urlRetorno: u, validadaEm: quando, status: h.status };
}

// ---------------------------------------------------------------- solicitações

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Atende o pedido em segundo plano, como a API assíncrona: PENDENTE, EM_PROCESSAMENTO, CONCLUIDA e o aviso.
async function atender(tiqueteId: string): Promise<void> {
  try {
    await esperar(PROCESSAMENTO_MS / 2);
    if (!marcarProcessando(tiqueteId)) return;
    await esperar(PROCESSAMENTO_MS / 2);
    const t = processarPedido(tiqueteId);
    // O erro também vai para a urlRetorno, com o codigoErro no lugar do link (caso T03).
    if (t?.estado === 'CONCLUIDA' || t?.estado === 'ERRO') await avisarTiquete(t.poc_id, t.id);
  } catch (e) {
    // A POC pode ter sido apagada no meio do atendimento.
    if (um('SELECT 1 FROM cbs_tiquetes WHERE id = ?', tiqueteId)) console.error(e);
  }
}

rota('POST', '/apuracao-cbs/v2/:endpoint/:cnpj', 'bearer', async ({ params, corpo }, p) => {
  const poc = p!;
  const endpoint = params.endpoint as Endpoint;
  if (!ENDPOINTS.includes(endpoint)) return erro(404, 'APURACAO-404', `Endpoint desconhecido: ${params.endpoint}. Use debitos, creditos, pagamentos ou recolhimentos.`);
  if (params.cnpj !== poc.cnpj_raiz) return erro(400, 'APURACAO-001', `Parâmetros inválidos para o processamento da solicitação: a credencial é do CNPJ base ${poc.cnpj_raiz}.`);
  const url = String((corpo as Record<string, unknown> | undefined)?.urlRetorno ?? '').trim();
  const motivo = validarUrlRetorno(url);
  if (motivo) return erro(400, 'APURACAO-001', `Parâmetros inválidos para o processamento da solicitação: ${motivo}`);
  if (!poc.limites_relaxados && pedidosNoDia(poc, endpoint) >= LIMITE_POR_DIA) {
    return erro(429, 'APURACAO-429', `Limite de ${LIMITE_POR_DIA} solicitações por dia em /${endpoint} atingido no dia simulado ${poc.dia}.`);
  }
  const head = await headUrlRetorno(url, `poc:${poc.id}`);
  if (!head.ok) return erro(400, 'APURACAO-001', `Parâmetros inválidos para o processamento da solicitação: a urlRetorno não respondeu ao HEAD (${head.motivo}).`);
  const t = abrirPedido(poc, endpoint, url, `CBS emulada · ${poc.cbs_client_id}`);
  void atender(t.id);
  return responder(201, { tiqueteSolicitacao: t.tiquete, tEASegundos: String(Math.max(1, Math.ceil(PROCESSAMENTO_MS / 1000))) });
});

export function situacaoDoTiquete(t: TiqueteRow): Record<string, unknown> {
  if (t.estado === 'CONCLUIDA') return { estado: t.estado, urlAssinada: linkAssinado(t), urlAssinadaExpiraEm: t.expira_em };
  if (t.estado === 'ERRO') return { estado: t.estado, codigoErro: t.codigo_erro, mensagemErro: t.mensagem_erro };
  return { estado: t.estado };
}

rota('GET', '/apuracao-cbs/v2/situacao/:tiquete', 'bearer', ({ params }, p) => {
  const t = um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE tiquete = ? AND poc_id = ?', params.tiquete, p!.id);
  if (!t) return erro(404, 'APURACAO-404', 'Tíquete não encontrado para este contribuinte.');
  return responder(200, situacaoDoTiquete(t));
});

// O link assinado dispensa o token, como a urlAssinada da documentação. Baixar é a prova de recebimento.
rota('GET', '/download/v2/:assinatura', 'nenhuma', ({ params, req }) => {
  const t = tiquetePorAssinatura(params.assinatura);
  if (!t || t.estado !== 'CONCLUIDA' || t.conteudo === null) return erro(404, 'APURACAO-404', 'Link inexistente.');
  const poc = obterPoc(t.poc_id);
  if (t.expirado_em || expirou(t, poc.dia)) return { r: erro(410, 'APURACAO-410', `O link venceu em ${t.expira_em}. Abra uma nova solicitação.`), poc };
  registrarDownloadCbs(t, ipDe(req), String(req.headers['user-agent'] ?? '').slice(0, 200));
  return {
    r: { __resposta: true, status: 200, corpo: t.conteudo, cabecalhos: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${t.tiquete}.json"` } },
    poc,
  };
});

// ---------------------------------------------------------------- aviso na urlRetorno (o MassGen chama o SplitHub)

const corpoDoAviso = (t: TiqueteRow) =>
  t.estado === 'ERRO' ? { codigoErro: t.codigo_erro, mensagemErro: t.mensagem_erro } : { tiqueteSolicitacao: t.tiquete, urlAssinada: linkAssinado(t), urlAssinadaExpiraEm: t.expira_em };

// Avisa a urlRetorno do tíquete. Repete enquanto não vier 2xx; cada tentativa vira uma requisição encadeada no monitor,
// com o link mascarado. O reenvio repete o mesmo aviso, com o mesmo link.
export async function avisarTiquete(pocId: string, tiqueteId: string, opcoes: { reenvioDe?: string } = {}): Promise<ResultadoAviso> {
  const poc = obterPoc(pocId);
  const t = um<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE id = ?', tiqueteId);
  if (!t || t.poc_id !== poc.id) throw new ErroHttp(404, 'Tíquete não encontrado.');
  const url = t.url_retorno;
  if (!url) return { resultado: 'sem_webhook', mensagem: 'O tíquete não tem urlRetorno.' };
  const corpo = JSON.stringify(corpoDoAviso(t));
  const gravado = semSegredo(corpo);
  const id = novoId('av');
  executar(
    'INSERT INTO avisos (id, poc_id, ente, solicitacao_id, tiquete_id, reenvio_de, url, corpo, resultado, criado_por, criado_em, atualizado_em) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, poc.id, 'cbs', t.id, opcoes.reenvioDe ?? null, url, gravado, 'pendente', usuarioAtual().usuario, agora(), agora(),
  );
  const fim = (r: { resultado: 'ok' | 'erro'; status: number | null; tentativas: number; erro?: string; duracao?: number; resposta?: string }): ResultadoAviso => {
    executar('UPDATE avisos SET tentativas = ?, status = ?, resultado = ?, erro = ?, duracao_ms = ?, res_corpo = ?, atualizado_em = ? WHERE id = ?',
      r.tentativas, r.status, r.resultado, r.erro ?? null, r.duracao ?? null, r.resposta?.slice(0, 4000) ?? null, agora(), id);
    const eventos = 'SELECT evento_id FROM cbs_tiquete_eventos WHERE tiquete_id = ?';
    if (r.resultado === 'ok' && t.expirado_em) {
      // T02: o link do aviso já nasceu vencido, e o evento só chega por um pedido novo.
      executar(`UPDATE eventos SET situacao = 'nao_recebido', motivo = ?, atualizado_em = ? WHERE id IN (${eventos}) AND situacao IN ('disponivel', 'avisado', 'nao_recebido')`,
        `O link do tíquete ${t.tiquete.slice(0, 8)}… venceu antes do download (T02). Abra uma nova solicitação.`, agora(), t.id);
    } else if (r.resultado === 'ok') {
      executar(`UPDATE eventos SET situacao = 'avisado', motivo = NULL, atualizado_em = ? WHERE id IN (${eventos}) AND situacao IN ('disponivel', 'nao_recebido')`, agora(), t.id);
    } else {
      executar(`UPDATE eventos SET situacao = 'nao_recebido', motivo = ?, atualizado_em = ? WHERE id IN (${eventos}) AND situacao = 'disponivel'`,
        `Aviso sem 2xx depois de ${r.tentativas} tentativa(s)${r.erro ? `: ${r.erro}` : ''}.`, agora(), t.id);
    }
    return { id, resultado: r.resultado, status: r.status, tentativas: r.tentativas, mensagem: r.erro };
  };
  const dom = conferirDominio(url);
  if (!dom.ok) return fim({ resultado: 'erro', status: null, tentativas: 0, erro: dom.motivo });
  const req = { metodo: 'POST', url, cabecalhos: { 'Content-Type': 'application/json' }, corpo };
  // T09 ligado: o primeiro 2xx deste aviso é descartado, e o mesmo aviso sai de novo.
  const t09 = !opcoes.reenvioDe && armado(poc.id, 'T09', 'cbs');
  if (t09) registrarInjecao(poc.id, 'T09', 'cbs', poc.dia, { tipo: 'aviso', id }, { endpoint: t.endpoint, tiquete: t.tiquete });
  const esperas = [0, ...config.avisoEsperasMs];
  if (t09 && esperas.length < 2) esperas.push(1000);
  let ultimo: Awaited<ReturnType<typeof enviarHttp>> | undefined;
  let n = 0;
  let descartou = false;
  for (const espera of esperas) {
    if (espera) await esperar(espera);
    n++;
    ultimo = await enviarHttp(req, 10000);
    const ok = !!ultimo.status && ultimo.status >= 200 && ultimo.status < 300;
    const descartar = ok && t09 && !descartou;
    if (descartar) descartou = true;
    gravarRequisicao({
      execucao_id: null, destino_id: null, registro_id: null, operacao_id: null, fase: 'aviso', entidade: 'cbs', metodo: 'POST', url, status: ultimo.status ?? null,
      duracao_ms: ultimo.duracaoMs, tentativa: n, chave_idempotencia: null, req_cabecalhos: JSON.stringify(req.cabecalhos),
      req_corpo: gravado, res_cabecalhos: JSON.stringify(ultimo.cabecalhos), res_corpo: ultimo.corpoTexto.slice(0, 4000) || null,
      erro: descartar ? T09_DESCARTE : ultimo.erro ?? null, codigo_erro: null, resultado: ok && !descartar ? 'ok' : 'erro', criado_em: agora(), usuario: usuarioAtual().usuario,
      rastreio: id, corpo_hash: sha256(corpo),
    });
    if (ok && !descartar) return fim({ resultado: 'ok', status: ultimo.status!, tentativas: n, duracao: ultimo.duracaoMs, resposta: ultimo.corpoTexto });
  }
  return fim({
    resultado: 'erro', status: ultimo?.status ?? null, tentativas: n, duracao: ultimo?.duracaoMs, resposta: ultimo?.corpoTexto,
    erro: ultimo?.erro ?? (ultimo?.status ? `HTTP ${ultimo.status}` : undefined),
  });
}

// Nova credencial da CBS emulada: a anterior e os tokens dela deixam de valer na hora.
export function credencialCbs(): { clientId: string; clientSecret: string } {
  return { clientId: `mg-cbs-${randomBytes(6).toString('hex')}`, clientSecret: randomBytes(24).toString('base64url') };
}

export const tiquetesDaPoc = (pocId: string) => todos<TiqueteRow>('SELECT * FROM cbs_tiquetes WHERE poc_id = ? ORDER BY criado_em DESC LIMIT 200', pocId);

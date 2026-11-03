// Comitê Gestor emulado (proposta v4.3, seção 03; MOC v1.10). As rotas ficam em /entes/ibs, públicas para o app e
// autenticadas como no ente: ClientID e ClientSecret no cabeçalho, emitidos por POC. O SplitHub usa a mesma collection
// que vai usar contra o Comitê Gestor; muda a URL base e a credencial.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config, conferirDominio } from '../config.ts';
import { agora, executar, json, novoId, todos, um } from '../db.ts';
import { ErroHttp, Roteador, type Ctx, type Resposta } from '../http.ts';
import { auditar, gravarRequisicao, sha256, usuarioAtual } from '../auditoria.ts';
import { lerSegredoPoc, removerSegredoPoc, salvarSegredoPoc } from '../cofre.ts';
import { enviarHttp, mascararCabecalhos } from '../engine/cliente.ts';
import { zipDoArquivo } from '../emulacao/arquivo-ibs.ts';
import { obterPoc, type PocRow } from '../emulacao/execucao.ts';

export const entes = new Roteador();
export const PREFIXO_IBS = '/entes/ibs';

const responder = (status: number, corpo: unknown, cabecalhos: Record<string, string> = {}): Resposta => ({
  __resposta: true, status, corpo: JSON.stringify(corpo), cabecalhos: { 'content-type': 'application/json; charset=utf-8', ...cabecalhos },
});

export const segredoConfere = (valor: string, hash: string | null): boolean => {
  if (!hash) return false;
  const a = Buffer.from(sha256(valor), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

function autenticar(req: IncomingMessage): PocRow | undefined {
  const id = String(req.headers.clientid ?? '');
  const segredo = String(req.headers.clientsecret ?? '');
  if (!id || !segredo) return undefined;
  const poc = um<PocRow>('SELECT * FROM pocs WHERE ibs_client_id = ?', id);
  return poc && segredoConfere(segredo, poc.ibs_secret_hash) ? poc : undefined;
}

const ipDe = (req: IncomingMessage) => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '');
const CORPO_SENSIVEL = /("tokenContrib"\s*:\s*")[^"]*(")/gi;

// Cada chamada que chega fica registrada (seção 13: o monitor passa a registrar também as chamadas que chegam), sem segredo.
function rota(metodo: string, padrao: string, fn: (ctx: Ctx, poc: PocRow) => Resposta | Promise<Resposta>): void {
  entes.add(metodo, `${PREFIXO_IBS}${padrao}`, async (ctx) => {
    const inicio = performance.now();
    const poc = autenticar(ctx.req);
    let r: Resposta;
    if (!poc) r = responder(401, { resultado: 'ERRO', mensagem: 'ClientID ou ClientSecret inválido.' });
    else {
      try {
        r = await fn(ctx, poc);
      } catch (e) {
        r = responder(e instanceof ErroHttp ? e.status : 500, { resultado: 'ERRO', mensagem: (e as Error).message });
      }
    }
    executar(
      'INSERT INTO chamadas (poc_id, ente, metodo, rota, status, ip, agente, req_corpo, res_corpo, duracao_ms, em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      poc?.id ?? null, 'ibs', metodo, ctx.req.url ?? '', r.status, ipDe(ctx.req), String(ctx.req.headers['user-agent'] ?? '').slice(0, 200),
      ctx.corpo === undefined ? null : JSON.stringify(ctx.corpo).replace(CORPO_SENSIVEL, '$1••••••$2').slice(0, 4000),
      typeof r.corpo === 'string' ? r.corpo.slice(0, 4000) : `(arquivo de ${r.corpo.length} bytes)`, Math.round(performance.now() - inicio), agora(),
    );
    return r;
  }, { publico: true });
}

// Chaves do corpo sem diferença de maiúsculas: o MOC escreve QueroHabilitar na tabela e queroHabilitar no exemplo.
const minusculas = (o: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k.toLowerCase(), v]));

const LOOPBACK = (h: string) => h === 'localhost' || h === '[::1]' || h.startsWith('127.');

export function validarWebhook(url: string): string | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return 'webhookUrl inválida.'; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK(u.hostname))) return 'webhookUrl precisa ser HTTPS.';
  const dom = conferirDominio(url);
  return dom.ok ? undefined : `webhookUrl recusada pelo MassGen: ${dom.motivo}`;
}

// ---------------------------------------------------------------- 5.1 Habilitação do Contribuinte

rota('POST', '/v1/aassist/habilitar', ({ corpo }, poc) => {
  const c = minusculas(corpo);
  if (String(c.querohabilitar ?? '').toUpperCase() !== 'HAB') return responder(400, { habilitado: 'queroHabilitar precisa ser "HAB".' });
  const url = String(c.webhookurl ?? '').trim();
  const motivo = validarWebhook(url);
  if (motivo) return responder(400, { habilitado: motivo });
  const token = typeof c.tokencontrib === 'string' ? c.tokencontrib : '';
  const quando = new Date().toISOString().slice(0, 19);
  executar('UPDATE pocs SET ibs_webhook_url = ?, ibs_habilitado_em = ?, atualizado_em = ? WHERE id = ?', url, quando, agora(), poc.id);
  if (token) salvarSegredoPoc(poc.id, 'ibs_token_contrib', token);
  else removerSegredoPoc(poc.id, 'ibs_token_contrib');
  auditar('poc.ibs_habilitar', `IBS emulado da POC ${poc.nome} habilitado com o webhook ${url}`, {
    alvoTipo: 'poc', alvoId: poc.id, usuario: `IBS emulado · ${poc.ibs_client_id}`, detalhes: { webhookUrl: url, tokenContrib: token ? 'definido' : 'ausente' },
  });
  return responder(200, { habilitado: 'HABILITADO', dataHabilitacao: quando });
});

// ---------------------------------------------------------------- 5.3 Obter Arquivo

// O MOC não define a rota do Obter Arquivo (só os Anexos I e II). Provisória, declarada na collection: pelo nome
// recebido no aviso ou pelo idArq.
rota('GET', '/v1/aassist/arquivo/:arquivo', ({ params, req }, poc) => {
  const p = params.arquivo;
  const a = /^\d+$/.test(p)
    ? um<ArquivoRow>("SELECT * FROM arquivos WHERE poc_id = ? AND ente = 'ibs' AND numero = ?", poc.id, Number(p))
    : um<ArquivoRow>("SELECT * FROM arquivos WHERE poc_id = ? AND ente = 'ibs' AND nome = ?", poc.id, p);
  if (!a) return responder(404, { resultado: 'ERRO', mensagem: 'Arquivo não encontrado.' });
  const s = um<{ situacao: string }>('SELECT situacao FROM solicitacoes WHERE id = ?', a.solicitacao_id);
  if (s && ['EXPIRADA', 'CANCELADA'].includes(s.situacao)) return responder(410, { resultado: 'ERRO', mensagem: `A solicitação está ${s.situacao.toLowerCase()}.` });
  const zip = zipDoArquivo(a.nome, a.conteudo, a.gerado_em);
  registrarDownload(poc.id, a.id, req);
  return { __resposta: true, status: 200, corpo: zip, cabecalhos: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${a.nome}"` } };
});

export interface ArquivoRow { id: string; poc_id: string; solicitacao_id: string; numero: number; parte: number; nome: string; conteudo: string; hash: string; tamanho: number; qtd_operacoes: number; qtd_lancamentos: number; gerado_em: string }

// Baixar é a prova de recebimento (D-MG-09): os eventos do arquivo passam a "recebido".
export function registrarDownload(pocId: string, arquivoId: string, req: IncomingMessage): void {
  executar('INSERT INTO downloads (poc_id, arquivo_id, ip, agente, em) VALUES (?, ?, ?, ?, ?)', pocId, arquivoId, ipDe(req), String(req.headers['user-agent'] ?? '').slice(0, 200), agora());
  executar("UPDATE eventos SET situacao = 'recebido', atualizado_em = ? WHERE arquivo_id = ? AND situacao IN ('disponivel', 'avisado', 'nao_recebido')", agora(), arquivoId);
}

// ---------------------------------------------------------------- 5.4 Listagem de Solicitações de Arquivos

interface SolicitacaoRow { id: string; poc_id: string; numero: number; tipo: string; situacao: string; dia: string; data_solic: string; trans_ini: string; trans_fim: string; validade: string; qtd_oper: number }

const SITUACOES = ['solicitada', 'gerada', 'enviada', 'cancelada', 'expirada', 'todas'];

rota('GET', '/v1/aassist/solicitacao/listar/:filtro', ({ params }, poc) => {
  const [ini, fim, sit = 'todas'] = params.filtro.split('&').map((x) => x.trim());
  const data = /^\d{4}-\d{2}-\d{2}$/;
  if (!data.test(ini ?? '') || !data.test(fim ?? '')) return responder(400, { resultado: 'ERRO', mensagem: 'Use /listar/{data_solic_ini}&{data_solic_fim}&{sit_solic}, com datas AAAA-MM-DD.' });
  if (!SITUACOES.includes(sit.toLowerCase())) return responder(400, { resultado: 'ERRO', mensagem: `sit_solic deve ser ${SITUACOES.join(', ')}.` });
  const linhas = todos<SolicitacaoRow>(
    `SELECT * FROM solicitacoes WHERE poc_id = ? AND ente = 'ibs' AND substr(data_solic, 1, 10) BETWEEN ? AND ? ${sit.toLowerCase() === 'todas' ? '' : 'AND situacao = ?'} ORDER BY numero`,
    ...(sit.toLowerCase() === 'todas' ? [poc.id, ini, fim] : [poc.id, ini, fim, sit.toUpperCase()]));
  const token = lerSegredoPoc(poc.id, 'ibs_token_contrib');
  const itens = linhas.map((s) => {
    const { arquivos, ...resto } = corpoAviso(poc, s, true);
    return { ...resto, arquivos: arquivos.map((a) => ({ idArq: a.idArq, nome: a.nomeArq })) };
  });
  return responder(200, { itens }, token ? { tokenContrib: token } : {});
});

// ---------------------------------------------------------------- 5.2 Notificação de Disponibilização (o MassGen chama o SplitHub)

// No aviso, a situação é a do momento em que o arquivo ficou pronto (GERADA); na listagem, a atual.
export function corpoAviso(poc: PocRow, s: SolicitacaoRow, situacaoAtual = false) {
  const arquivos = todos<{ numero: number; nome: string }>('SELECT numero, nome FROM arquivos WHERE solicitacao_id = ? ORDER BY numero', s.id);
  return {
    tipoSolic: s.tipo, sitSolic: !situacaoAtual && s.situacao === 'ENVIADA' ? 'GERADA' : s.situacao, cnpj: poc.cnpj, idSolic: s.numero, dataHoraSolic: s.data_solic,
    dataHoraTransIni: s.trans_ini, dataHoraTransFim: s.trans_fim, qtdOperSolic: s.qtd_oper, qtdArqVincul: arquivos.length, dataValidSolic: s.validade,
    arquivos: arquivos.map((a) => ({ idArq: a.numero, nomeArq: a.nome })),
  };
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ResultadoAviso { id?: string; resultado: 'ok' | 'erro' | 'sem_webhook'; status?: number | null; tentativas?: number; mensagem?: string }

// Avisa o webhook do SplitHub. Repete enquanto não vier 2xx; cada tentativa vira uma requisição encadeada no monitor.
export async function avisarSolicitacao(pocId: string, solicitacaoId: string, opcoes: { reenvioDe?: string } = {}): Promise<ResultadoAviso> {
  const poc = obterPoc(pocId);
  const s = um<SolicitacaoRow>('SELECT * FROM solicitacoes WHERE id = ?', solicitacaoId);
  if (!s || s.poc_id !== poc.id) throw new ErroHttp(404, 'Solicitação não encontrada.');
  const url = poc.ibs_webhook_url;
  if (!url) return { resultado: 'sem_webhook', mensagem: 'O SplitHub ainda não habilitou o IBS desta POC. O arquivo fica disponível para listar e baixar.' };
  const original = opcoes.reenvioDe ? um<{ corpo: string }>('SELECT corpo FROM avisos WHERE id = ?', opcoes.reenvioDe) : undefined;
  const corpo = original?.corpo ?? JSON.stringify(corpoAviso(poc, s));
  const id = novoId('av');
  executar(
    'INSERT INTO avisos (id, poc_id, ente, solicitacao_id, reenvio_de, url, corpo, resultado, criado_por, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, poc.id, 'ibs', s.id, opcoes.reenvioDe ?? null, url, corpo, 'pendente', usuarioAtual().usuario, agora(), agora(),
  );
  const fim = (r: { resultado: 'ok' | 'erro'; status: number | null; tentativas: number; erro?: string; duracao?: number; resposta?: string }): ResultadoAviso => {
    executar('UPDATE avisos SET tentativas = ?, status = ?, resultado = ?, erro = ?, duracao_ms = ?, res_corpo = ?, atualizado_em = ? WHERE id = ?',
      r.tentativas, r.status, r.resultado, r.erro ?? null, r.duracao ?? null, r.resposta?.slice(0, 4000) ?? null, agora(), id);
    const arquivos = todos<{ id: string }>('SELECT id FROM arquivos WHERE solicitacao_id = ?', s.id).map((a) => a.id);
    const marcas = arquivos.map(() => '?').join(', ');
    if (r.resultado === 'ok') {
      if (s.situacao === 'GERADA') executar("UPDATE solicitacoes SET situacao = 'ENVIADA', atualizado_em = ? WHERE id = ?", agora(), s.id);
      if (arquivos.length) executar(`UPDATE eventos SET situacao = 'avisado', motivo = NULL, atualizado_em = ? WHERE arquivo_id IN (${marcas}) AND situacao IN ('disponivel', 'nao_recebido')`, agora(), ...arquivos);
    } else if (arquivos.length) {
      executar(`UPDATE eventos SET situacao = 'nao_recebido', motivo = ?, atualizado_em = ? WHERE arquivo_id IN (${marcas}) AND situacao = 'disponivel'`,
        `Aviso sem 2xx depois de ${r.tentativas} tentativa(s)${r.erro ? `: ${r.erro}` : ''}.`, agora(), ...arquivos);
    }
    return { id, resultado: r.resultado, status: r.status, tentativas: r.tentativas, mensagem: r.erro };
  };
  const dom = conferirDominio(url);
  if (!dom.ok) return fim({ resultado: 'erro', status: null, tentativas: 0, erro: dom.motivo });
  const token = lerSegredoPoc(poc.id, 'ibs_token_contrib');
  const req = { metodo: 'POST', url, cabecalhos: { 'Content-Type': 'application/json', ...(token ? { tokenContrib: token } : {}) }, corpo };
  const esperas = [0, ...config.avisoEsperasMs];
  let ultimo: Awaited<ReturnType<typeof enviarHttp>> | undefined;
  let n = 0;
  for (const espera of esperas) {
    if (espera) await esperar(espera);
    n++;
    ultimo = await enviarHttp(req, 10000);
    const ok = !!ultimo.status && ultimo.status >= 200 && ultimo.status < 300;
    gravarRequisicao({
      execucao_id: null, destino_id: null, registro_id: null, operacao_id: null, fase: 'aviso', entidade: 'ibs', metodo: 'POST', url, status: ultimo.status ?? null,
      duracao_ms: ultimo.duracaoMs, tentativa: n, chave_idempotencia: null, req_cabecalhos: JSON.stringify(mascararCabecalhos(req.cabecalhos, ['tokenContrib'])),
      req_corpo: corpo, res_cabecalhos: JSON.stringify(ultimo.cabecalhos), res_corpo: ultimo.corpoTexto.slice(0, 4000) || null, erro: ultimo.erro ?? null,
      codigo_erro: null, resultado: ok ? 'ok' : 'erro', criado_em: agora(), usuario: usuarioAtual().usuario, rastreio: id, corpo_hash: sha256(corpo),
    });
    if (ok) return fim({ resultado: 'ok', status: ultimo.status!, tentativas: n, duracao: ultimo.duracaoMs, resposta: ultimo.corpoTexto });
  }
  return fim({
    resultado: 'erro', status: ultimo?.status ?? null, tentativas: n, duracao: ultimo?.duracaoMs, resposta: ultimo?.corpoTexto,
    erro: ultimo?.erro ?? (ultimo?.status ? `HTTP ${ultimo.status}` : undefined),
  });
}

// As tentativas de um aviso, do monitor encadeado.
export function tentativasDoAviso(avisoId: string) {
  return todos<Record<string, unknown>>('SELECT id, tentativa, status, duracao_ms, erro, criado_em, req_cabecalhos, res_corpo FROM requisicoes WHERE rastreio = ? ORDER BY id', avisoId)
    .map((r) => ({ id: r.id, tentativa: r.tentativa, status: r.status, duracaoMs: r.duracao_ms, erro: r.erro, em: r.criado_em, cabecalhos: json(r.req_cabecalhos, {}), resposta: r.res_corpo }));
}

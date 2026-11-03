// POC da apuração assistida (proposta v4.3): o cliente, a competência, o relógio, as notas e o que os entes emulados
// fizeram com cada uma. Os XMLs do cliente ficam só aqui, no banco da POC, e saem com ela (D-MG-12).
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { agora, executar, json, novoId, todos, transacao, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { sha256 } from '../auditoria.ts';
import { lerSegredoPoc } from '../cofre.ts';
import { CAMPOS, TIPO_IBS, type Campo } from '../emulacao/catalogo.ts';
import { linhaMoc, cabecalhoOperacao } from '../emulacao/arquivo-ibs.ts';
import { carregarEstado, obterPoc, rotuloNota, type NotaRow, type PocRow } from '../emulacao/execucao.ts';
import { lerDocumento, raizCnpj, type CancelamentoLido, type NotaLida } from '../emulacao/xml.ts';
import { ehZip, lerZip } from '../emulacao/zip.ts';
import { PREFIXO_IBS, tentativasDoAviso, type ArquivoRow } from '../entes/ibs.ts';

const CNPJ = /^[0-9A-Z]{12}\d{2}$/;
const COMPETENCIA = /^\d{4}-(0[1-9]|1[0-2])$/;

export const urlIbs = () => `${config.urlPublica}${PREFIXO_IBS}`;

function credencial(): { clientId: string; clientSecret: string } {
  return { clientId: `mg-ibs-${randomBytes(6).toString('hex')}`, clientSecret: randomBytes(24).toString('base64url') };
}

function resumo(p: PocRow) {
  const n = um<{ aceitas: number; fora: number; entrada: number; saida: number }>(
    "SELECT SUM(situacao = 'aceita') AS aceitas, SUM(situacao = 'fora') AS fora, SUM(papel = 'adquirente' AND situacao = 'aceita') AS entrada, SUM(papel = 'fornecedor' AND situacao = 'aceita') AS saida FROM notas WHERE poc_id = ?", p.id)!;
  const ev = todos<{ situacao: string; n: number }>("SELECT situacao, COUNT(*) AS n FROM eventos WHERE poc_id = ? GROUP BY situacao", p.id);
  return {
    id: p.id, nome: p.nome, cnpj: p.cnpj, cnpjRaiz: p.cnpj_raiz, competencia: p.competencia, dia: p.dia, ambienteId: p.ambiente_id,
    limitesRelaxados: !!p.limites_relaxados, lancamentosPorArquivo: p.lancamentos_por_arquivo, criadoPor: p.criado_por, criadoEm: p.criado_em,
    notas: { aceitas: n.aceitas ?? 0, fora: n.fora ?? 0, entrada: n.entrada ?? 0, saida: n.saida ?? 0 },
    eventos: Object.fromEntries(ev.map((e) => [e.situacao, e.n])) as Record<string, number>,
    ibs: { url: urlIbs(), clientId: p.ibs_client_id, habilitado: !!p.ibs_habilitado_em, habilitadoEm: p.ibs_habilitado_em, webhookUrl: p.ibs_webhook_url, tokenContrib: !!lerSegredoPoc(p.id, 'ibs_token_contrib') },
  };
}

export const listarPocs = () => todos<PocRow>('SELECT * FROM pocs ORDER BY criado_em DESC').map(resumo);
export const detalharPoc = (id: string) => resumo(obterPoc(id));

export function criarPoc(dados: Record<string, unknown>, usuario: string) {
  const nome = String(dados.nome ?? '').trim();
  const cnpj = String(dados.cnpj ?? '').replace(/[.\-/\s]/g, '').toUpperCase();
  const competencia = String(dados.competencia ?? '').trim();
  const erros: string[] = [];
  if (!nome) erros.push('Dê um nome à POC.');
  if (!CNPJ.test(cnpj)) erros.push('Informe o CNPJ do cliente com 14 caracteres (o raiz identifica o papel do cliente em cada nota).');
  if (!COMPETENCIA.test(competencia)) erros.push('Informe a competência no formato AAAA-MM.');
  if (erros.length) throw new ErroHttp(400, 'Confira os dados da POC.', erros);
  if (um('SELECT 1 FROM pocs WHERE nome = ?', nome)) throw new ErroHttp(409, `Já existe uma POC chamada ${nome}.`);
  const ambienteId = typeof dados.ambienteId === 'string' && dados.ambienteId ? dados.ambienteId : null;
  if (ambienteId && !um('SELECT 1 FROM ambientes WHERE id = ?', ambienteId)) throw new ErroHttp(400, 'Ambiente não encontrado.');
  const id = novoId('poc');
  const cred = credencial();
  executar(
    `INSERT INTO pocs (id, nome, cnpj, cnpj_raiz, competencia, dia, ambiente_id, ibs_client_id, ibs_secret_hash, criado_por, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, nome, cnpj, cnpj.slice(0, 8), competencia, `${competencia}-01`, ambienteId, cred.clientId, sha256(cred.clientSecret), usuario, agora(), agora(),
  );
  // O segredo aparece uma vez, como no Comitê Gestor; o app guarda só o hash (seção 14).
  return { poc: detalharPoc(id), credencial: { ente: 'ibs', url: urlIbs(), ...cred } };
}

export function atualizarPoc(id: string, dados: Record<string, unknown>) {
  const p = obterPoc(id);
  const nome = dados.nome === undefined ? p.nome : String(dados.nome).trim();
  if (!nome) throw new ErroHttp(400, 'Dê um nome à POC.');
  if (nome !== p.nome && um('SELECT 1 FROM pocs WHERE nome = ? AND id <> ?', nome, id)) throw new ErroHttp(409, `Já existe uma POC chamada ${nome}.`);
  const relaxados = dados.limitesRelaxados === undefined ? p.limites_relaxados : dados.limitesRelaxados ? 1 : 0;
  const porArquivo = dados.lancamentosPorArquivo === undefined ? p.lancamentos_por_arquivo : Math.round(Number(dados.lancamentosPorArquivo));
  if (!Number.isFinite(porArquivo) || porArquivo < 1 || porArquivo > 100000) throw new ErroHttp(400, 'Lançamentos por arquivo: de 1 a 100.000.');
  executar('UPDATE pocs SET nome = ?, limites_relaxados = ?, lancamentos_por_arquivo = ?, atualizado_em = ? WHERE id = ?', nome, relaxados, porArquivo, agora(), id);
  return detalharPoc(id);
}

export function novaCredencialIbs(id: string) {
  obterPoc(id);
  const cred = credencial();
  executar('UPDATE pocs SET ibs_client_id = ?, ibs_secret_hash = ?, atualizado_em = ? WHERE id = ?', cred.clientId, sha256(cred.clientSecret), agora(), id);
  return { ente: 'ibs', url: urlIbs(), ...cred };
}

// Apagar a POC leva as notas do cliente, os eventos, os arquivos e os avisos. A trilha de auditoria fica.
export function removerPoc(id: string) {
  const p = obterPoc(id);
  const notas = um<{ n: number }>('SELECT COUNT(*) AS n FROM notas WHERE poc_id = ?', id)!.n;
  executar('DELETE FROM pocs WHERE id = ?', id);
  return { nome: p.nome, notas };
}

// ---------------------------------------------------------------- importação das notas

export interface ArquivoEnviado { nome?: string; conteudo?: string; base64?: boolean }

export interface ResultadoImportacao {
  aceitas: number; fora: number; cancelamentos: number; repetidas: number; ligadas: number;
  itens: { arquivo: string; chave?: string; nota?: string; resultado: 'aceita' | 'fora' | 'cancelamento' | 'repetida' | 'ignorado'; motivo?: string }[];
}

function papelDe(poc: PocRow, n: NotaLida): { papel?: 'adquirente' | 'fornecedor'; motivo?: string } {
  const emit = raizCnpj(n.emitCnpj) === poc.cnpj_raiz;
  const dest = raizCnpj(n.destDoc) === poc.cnpj_raiz;
  if (emit && dest) return { motivo: 'o cliente é emitente e destinatário ao mesmo tempo' };
  if (emit) return { papel: 'fornecedor' };
  if (dest) return { papel: 'adquirente' };
  return { motivo: `o CNPJ raiz ${poc.cnpj_raiz} não está na nota como emitente nem como destinatário` };
}

// O que deixa a nota de fora, na ordem da seção 04.
function motivoFora(poc: PocRow, n: NotaLida): string | undefined {
  if (n.modelo !== '55') return n.modelo === '65' ? 'NFC-e entra na etapa seguinte; por ora, só NF-e (D-MG-10)' : `modelo ${n.modelo}: por ora, só NF-e (D-MG-10)`;
  if (n.ambiente === 'homologacao') return 'nota de homologação';
  if (!n.grupoIbsCbs) return 'a nota não tem o grupo de IBS e CBS';
  if (n.situacaoSefaz && !['100', '150'].includes(n.situacaoSefaz)) return `a nota não está autorizada (cStat ${n.situacaoSefaz})`;
  if (!n.autorizacao) return 'a nota não tem o protocolo de autorização';
  return papelDe(poc, n).motivo;
}

function arquivosDoLote(arquivos: ArquivoEnviado[]): { nome: string; texto?: string; motivo?: string }[] {
  const saida: { nome: string; texto?: string; motivo?: string }[] = [];
  for (const a of arquivos) {
    const nome = String(a.nome ?? 'sem-nome');
    if (typeof a.conteudo !== 'string') { saida.push({ nome, motivo: 'arquivo vazio' }); continue; }
    const bruto = a.base64 ? Buffer.from(a.conteudo, 'base64') : Buffer.from(a.conteudo, 'utf8');
    if (ehZip(bruto)) {
      try {
        for (const e of lerZip(bruto)) {
          if (/\.xml$/i.test(e.nome)) saida.push({ nome: `${nome} › ${e.nome}`, texto: e.dados.toString('utf8') });
          else saida.push({ nome: `${nome} › ${e.nome}`, motivo: 'não é XML' });
        }
      } catch (e) {
        saida.push({ nome, motivo: (e as Error).message });
      }
    } else saida.push({ nome, texto: bruto.toString('utf8') });
  }
  return saida;
}

export function importarNotas(pocId: string, arquivos: unknown, usuario: string): ResultadoImportacao {
  const poc = obterPoc(pocId);
  if (!Array.isArray(arquivos) || !arquivos.length) throw new ErroHttp(400, 'Envie pelo menos um XML ou um ZIP com os XMLs.');
  const r: ResultadoImportacao = { aceitas: 0, fora: 0, cancelamentos: 0, repetidas: 0, ligadas: 0, itens: [] };
  const lidos = arquivosDoLote(arquivos as ArquivoEnviado[]);
  const cancelamentos: { arquivo: string; c: CancelamentoLido; xml: string }[] = [];
  transacao(() => {
    let operacao = um<{ n: number }>('SELECT COALESCE(MAX(operacao_id), 90000000) AS n FROM notas WHERE poc_id = ?', poc.id)!.n;
    for (const a of lidos) {
      if (!a.texto) { r.itens.push({ arquivo: a.nome, resultado: 'ignorado', motivo: a.motivo }); continue; }
      const d = lerDocumento(a.texto);
      if (d.tipo === 'outro') { r.itens.push({ arquivo: a.nome, resultado: 'ignorado', motivo: d.motivo }); continue; }
      if (d.tipo === 'cancelamento') { cancelamentos.push({ arquivo: a.nome, c: d.cancelamento, xml: a.texto }); continue; }
      const n = d.nota;
      if (um('SELECT 1 FROM notas WHERE poc_id = ? AND chave = ?', poc.id, n.chave)) {
        r.repetidas++;
        r.itens.push({ arquivo: a.nome, chave: n.chave, resultado: 'repetida', motivo: 'a nota já está na POC' });
        continue;
      }
      const fora = motivoFora(poc, n);
      const papel = papelDe(poc, n).papel ?? null;
      const abreOperacao = !fora && n.finalidade !== 'complementar' && n.finalidade !== 'devolucao';
      executar(
        `INSERT INTO notas (id, poc_id, chave, modelo, serie, numero, emissao, autorizacao, emit_cnpj, emit_nome, dest_doc, dest_nome, papel, finalidade, ref_chaves,
           v_ibs, v_ibs_uf, v_ibs_mun, v_cbs, situacao, motivo, operacao_id, nome_arquivo, xml, xml_hash, importada_por, importada_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        novoId('nf'), poc.id, n.chave, n.modelo, n.serie ?? null, n.numero ?? null, n.emissao ?? null, n.autorizacao ?? null, n.emitCnpj ?? null, n.emitNome ?? null,
        n.destDoc ?? null, n.destNome ?? null, papel, n.finalidade, JSON.stringify(n.refChaves), n.vIbs, n.vIbsUf, n.vIbsMun, n.vCbs,
        fora ? 'fora' : 'aceita', fora ?? null, abreOperacao ? ++operacao : null, a.nome, a.texto, sha256(a.texto), usuario, agora(),
      );
      if (fora) r.fora++; else r.aceitas++;
      r.itens.push({ arquivo: a.nome, chave: n.chave, nota: rotuloNota({ modelo: n.modelo, numero: n.numero ?? null, chave: n.chave }), resultado: fora ? 'fora' : 'aceita', motivo: fora });
    }
    // Cancelamentos depois das notas: o evento pode vir antes da nota no lote.
    for (const { arquivo, c, xml } of cancelamentos) {
      const nota = um<{ id: string; numero: string | null; modelo: string | null; chave: string }>('SELECT id, numero, modelo, chave FROM notas WHERE poc_id = ? AND chave = ?', poc.id, c.chave);
      if (!nota) { r.itens.push({ arquivo, chave: c.chave, resultado: 'ignorado', motivo: 'cancelamento de uma nota que não está na POC' }); continue; }
      if (!c.autorizado) { r.itens.push({ arquivo, chave: c.chave, resultado: 'ignorado', motivo: `cancelamento sem retorno autorizado (cStat ${c.situacaoSefaz ?? 'ausente'})` }); continue; }
      executar('UPDATE notas SET cancelada_em = ?, cancelamento_xml = ? WHERE id = ?', c.quando ?? agora(), xml, nota.id);
      r.cancelamentos++;
      r.itens.push({ arquivo, chave: c.chave, nota: rotuloNota(nota), resultado: 'cancelamento' });
    }
    // Complementar e devolução se ligam à nota original, quando ela está no lote (agora ou de uma importação anterior).
    const soltas = todos<{ id: string; ref_chaves: string }>("SELECT id, ref_chaves FROM notas WHERE poc_id = ? AND situacao = 'aceita' AND finalidade IN ('complementar', 'devolucao') AND origem_id IS NULL", poc.id);
    for (const s of soltas) {
      for (const ch of json<string[]>(s.ref_chaves, [])) {
        const o = um<{ id: string }>("SELECT id FROM notas WHERE poc_id = ? AND chave = ? AND situacao = 'aceita' AND operacao_id IS NOT NULL", poc.id, ch);
        if (o) { executar('UPDATE notas SET origem_id = ? WHERE id = ?', o.id, s.id); r.ligadas++; break; }
      }
    }
  });
  return r;
}

// ---------------------------------------------------------------- notas e histórico

interface Contagem { nota_id: string; total: number; planejados: number; recebidos: number; pendentes: number }

function notaResumo(n: NotaRow, c?: Contagem) {
  return {
    id: n.id, chave: n.chave, rotulo: rotuloNota(n), modelo: n.modelo, serie: n.serie, numero: n.numero, emissao: n.emissao, autorizacao: n.autorizacao,
    emitente: { doc: n.emit_cnpj, nome: n.emit_nome }, destinatario: { doc: n.dest_doc, nome: n.dest_nome }, papel: n.papel, finalidade: n.finalidade,
    origemId: n.origem_id, canceladaEm: n.cancelada_em, vIbs: n.v_ibs, vIbsUf: n.v_ibs_uf, vIbsMun: n.v_ibs_mun, vCbs: n.v_cbs,
    situacao: n.situacao, motivo: n.motivo, operacaoId: n.operacao_id, roteiro: n.roteiro, nomeArquivo: (n as NotaRow & { nome_arquivo?: string }).nome_arquivo,
    eventos: c ? { total: c.total, planejados: c.planejados, recebidos: c.recebidos, pendentes: c.pendentes } : { total: 0, planejados: 0, recebidos: 0, pendentes: 0 },
  };
}

const COLUNAS_NOTA = 'id, poc_id, chave, modelo, serie, numero, emissao, autorizacao, emit_cnpj, emit_nome, dest_doc, dest_nome, papel, finalidade, ref_chaves, origem_id, cancelada_em, v_ibs, v_ibs_uf, v_ibs_mun, v_cbs, situacao, motivo, operacao_id, roteiro, nome_arquivo';

export function listarNotas(pocId: string, f: { busca?: string; papel?: string; situacao?: string } = {}) {
  obterPoc(pocId);
  const where = ['poc_id = ?'];
  const p: string[] = [pocId];
  if (f.papel) { where.push('papel = ?'); p.push(f.papel); }
  if (f.situacao) { where.push('situacao = ?'); p.push(f.situacao); }
  if (f.busca) { where.push('(chave LIKE ? OR numero LIKE ? OR emit_cnpj LIKE ? OR dest_doc LIKE ? OR emit_nome LIKE ? OR dest_nome LIKE ?)'); p.push(...Array(6).fill(`%${f.busca}%`)); }
  const contagens = new Map(todos<Contagem>(
    `SELECT nota_id, COUNT(*) AS total, SUM(situacao = 'planejado') AS planejados, SUM(situacao = 'recebido') AS recebidos,
            SUM(situacao IN ('disponivel', 'avisado', 'nao_recebido')) AS pendentes
       FROM eventos WHERE poc_id = ? AND situacao <> 'substituido' GROUP BY nota_id`, pocId).map((c) => [c.nota_id, c]));
  return todos<NotaRow>(`SELECT ${COLUNAS_NOTA} FROM notas WHERE ${where.join(' AND ')} ORDER BY situacao, papel, emissao, numero LIMIT 2000`, ...p)
    .map((n) => notaResumo(n, contagens.get(n.id)));
}

interface EventoCompleto {
  id: string; nota_id: string; nota_rel_id: string | null; ente: string; tipo: string; roteiro: string | null; origem: string; envio_id: string | null; forcado: number;
  dia: string; ordem: number; valor: number; valores: string; lancamento_id: number | null; dth_lancto: string | null; hash: string | null; arquivo_id: string | null;
  situacao: string; motivo: string | null; criado_por: string | null; criado_em: string;
}

export function detalharNota(pocId: string, notaId: string) {
  const n = um<NotaRow>(`SELECT ${COLUNAS_NOTA} FROM notas WHERE id = ? AND poc_id = ?`, notaId, pocId);
  if (!n) throw new ErroHttp(404, 'Nota não encontrada.');
  const op = n.origem_id ? um<NotaRow>(`SELECT ${COLUNAS_NOTA} FROM notas WHERE id = ?`, n.origem_id)! : n;
  const relacionadas = todos<NotaRow>(`SELECT ${COLUNAS_NOTA} FROM notas WHERE origem_id = ? ORDER BY emissao`, op.id);
  const evs = todos<EventoCompleto>('SELECT * FROM eventos WHERE nota_id = ? ORDER BY dia, ordem', op.id);
  const envios = new Map(todos<{ id: string; numero: number; tipo: string; criado_por: string; criado_em: string }>(
    'SELECT id, numero, tipo, criado_por, criado_em FROM envios WHERE poc_id = ?', pocId).map((e) => [e.id, e]));
  const arquivos = new Map<string, Record<string, unknown>>();
  const arquivo = (id: string) => {
    if (!arquivos.has(id)) {
      const a = um<ArquivoRow & { solicitacao_id: string }>('SELECT id, numero, nome, hash, tamanho, solicitacao_id, gerado_em, qtd_operacoes, qtd_lancamentos FROM arquivos WHERE id = ?', id)!;
      const s = um<{ numero: number; situacao: string; tipo: string }>('SELECT numero, situacao, tipo FROM solicitacoes WHERE id = ?', a.solicitacao_id);
      const aviso = um<Record<string, unknown>>('SELECT id, status, resultado, tentativas, erro, duracao_ms, criado_em FROM avisos WHERE solicitacao_id = ? ORDER BY criado_em DESC LIMIT 1', a.solicitacao_id);
      const downloads = todos<{ em: string; ip: string }>('SELECT em, ip FROM downloads WHERE arquivo_id = ? ORDER BY id', id);
      arquivos.set(id, {
        id: a.id, idArq: a.numero, nome: a.nome, hash: a.hash, tamanho: a.tamanho, geradoEm: a.gerado_em, operacoes: a.qtd_operacoes, lancamentos: a.qtd_lancamentos,
        solicitacao: s ? { id: a.solicitacao_id, idSolic: s.numero, situacao: s.situacao, tipo: s.tipo } : null,
        aviso: aviso ? { id: aviso.id, status: aviso.status, resultado: aviso.resultado, tentativas: aviso.tentativas, erro: aviso.erro, duracaoMs: aviso.duracao_ms, em: aviso.criado_em } : null,
        downloads: { total: downloads.length, primeiro: downloads[0]?.em ?? null, ultimo: downloads[downloads.length - 1]?.em ?? null },
      });
    }
    return arquivos.get(id);
  };
  const historico = evs.map((e) => {
    const t = TIPO_IBS.get(e.tipo);
    const env = e.envio_id ? envios.get(e.envio_id) : undefined;
    const valores = json<Record<Campo, number>>(e.valores, {} as Record<Campo, number>);
    return {
      id: e.id, ente: e.ente, tipo: t?.id ?? e.tipo, mov: t?.mov, dia: e.dia, valor: e.valor, valores, situacao: e.situacao, motivo: e.motivo, forcado: !!e.forcado,
      origem: e.origem, roteiro: e.roteiro, envio: env ? { numero: env.numero, tipo: env.tipo, por: env.criado_por, em: env.criado_em } : null,
      relacionada: e.nota_rel_id, lancamentoId: e.lancamento_id, hash: e.hash,
      linha: e.lancamento_id ? linhaMoc(e.lancamento_id, e.dth_lancto!, e.tipo, valores) : null,
      arquivo: e.arquivo_id ? arquivo(e.arquivo_id) : null,
    };
  });
  const estado = carregarEstado(op);
  const comPlanejado = carregarEstado(op, '9999-12-31');
  return {
    nota: notaResumo(n), operacao: notaResumo(op), relacionadas: relacionadas.map((r) => notaResumo(r)),
    cabecalhoOperacao: op.operacao_id ? cabecalhoOperacao(op as NotaRow & { operacao_id: number }) : null,
    saldos: CAMPOS.map((c) => ({ campo: c.campo, nome: c.nome, rotulo: c.rotulo, noEnte: estado.saldos[c.campo], comPlanejado: comPlanejado.saldos[c.campo] })),
    historico,
  };
}

export function xmlDaNota(pocId: string, notaId: string) {
  const n = um<{ xml: string; chave: string }>('SELECT xml, chave FROM notas WHERE id = ? AND poc_id = ?', notaId, pocId);
  if (!n) throw new ErroHttp(404, 'Nota não encontrada.');
  return n;
}

// ---------------------------------------------------------------- barramento

export function barramento(pocId: string) {
  const poc = obterPoc(pocId);
  const sols = todos<Record<string, unknown>>("SELECT * FROM solicitacoes WHERE poc_id = ? AND ente = 'ibs' ORDER BY numero DESC LIMIT 200", pocId);
  return {
    ibs: resumo(poc).ibs,
    solicitacoes: sols.map((s) => ({
      id: s.id, idSolic: s.numero, tipo: s.tipo, situacao: s.situacao, dia: s.dia, dataSolic: s.data_solic, validade: s.validade, operacoes: s.qtd_oper,
      arquivos: todos<Record<string, unknown>>('SELECT a.id, a.numero, a.nome, a.tamanho, a.hash, a.qtd_lancamentos, (SELECT COUNT(*) FROM downloads d WHERE d.arquivo_id = a.id) AS downloads FROM arquivos a WHERE a.solicitacao_id = ? ORDER BY a.numero', s.id as string)
        .map((a) => ({ id: a.id, idArq: a.numero, nome: a.nome, tamanho: a.tamanho, hash: a.hash, lancamentos: a.qtd_lancamentos, downloads: a.downloads })),
      avisos: todos<Record<string, unknown>>('SELECT id, reenvio_de, status, resultado, tentativas, erro, duracao_ms, criado_por, criado_em FROM avisos WHERE solicitacao_id = ? ORDER BY criado_em', s.id as string)
        .map((a) => ({ id: a.id, reenvioDe: a.reenvio_de, status: a.status, resultado: a.resultado, tentativas: a.tentativas, erro: a.erro, duracaoMs: a.duracao_ms, por: a.criado_por, em: a.criado_em })),
    })),
    chamadas: todos<Record<string, unknown>>('SELECT id, ente, metodo, rota, status, ip, duracao_ms, em FROM chamadas WHERE poc_id = ? ORDER BY id DESC LIMIT 100', pocId)
      .map((c) => ({ id: c.id, ente: c.ente, metodo: c.metodo, rota: c.rota, status: c.status, ip: c.ip, duracaoMs: c.duracao_ms, em: c.em })),
  };
}

export function obterArquivo(pocId: string, arquivoId: string) {
  const a = um<ArquivoRow>('SELECT * FROM arquivos WHERE id = ? AND poc_id = ?', arquivoId, pocId);
  if (!a) throw new ErroHttp(404, 'Arquivo não encontrado.');
  return a;
}

export function detalharAviso(pocId: string, avisoId: string) {
  const a = um<Record<string, unknown>>('SELECT * FROM avisos WHERE id = ? AND poc_id = ?', avisoId, pocId);
  if (!a) throw new ErroHttp(404, 'Aviso não encontrado.');
  return {
    id: a.id, url: a.url, corpo: json(a.corpo, a.corpo), resultado: a.resultado, status: a.status, tentativas: a.tentativas, erro: a.erro, resposta: a.res_corpo,
    reenvioDe: a.reenvio_de, por: a.criado_por, em: a.criado_em, solicitacaoId: a.solicitacao_id, chamadas: tentativasDoAviso(avisoId as string),
  };
}

export function listarEnvios(pocId: string) {
  obterPoc(pocId);
  return todos<Record<string, unknown>>('SELECT * FROM envios WHERE poc_id = ? ORDER BY numero DESC LIMIT 200', pocId).map((e) => ({
    id: e.id, numero: e.numero, tipo: e.tipo, dia: e.dia, roteiro: e.roteiro, notas: json<string[]>(e.notas, []).length, tipos: json<string[]>(e.tipos, []),
    forcar: !!e.forcar, resumo: json(e.resumo, {}), por: e.criado_por, em: e.criado_em,
  }));
}

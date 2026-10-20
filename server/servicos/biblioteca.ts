// Biblioteca de APIs: collections e environments do Postman guardados como arquivo original, com versão.
// É agnóstica — guarda qualquer collection v2.1, de qualquer sistema — e independente das integrações: a mesma
// collection serve a integrações de ambientes diferentes, cada uma com o seu environment.
// O environment é guardado sem os valores secretos (cada segredo vai para o cofre da versão) e sem os tokens de
// execução, que nunca são guardados.
import { agora, executar, json, novoId, todos, transacao, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import { sha256, usuarioAtual } from '../auditoria.ts';
import { salvarSegredoVersao, segredosDaVersao } from '../cofre.ts';
import { classificarVariavel, lerPostman, normalizarRota } from '../importers/postman.ts';

export type TipoArquivo = 'collection' | 'environment';

interface LinhaArquivo { id: string; tipo: TipoArquivo; nome: string; descricao: string | null; criado_em: string; atualizado_em: string }
interface LinhaVersao {
  id: string; arquivo_id: string; numero: number; nome_arquivo: string | null; conteudo: string; hash: string; resumo: string;
  importado_por: string | null; importado_em: string;
}

type Qualquer = any;

export function detectarTipo(conteudo: Qualquer): TipoArquivo {
  if (conteudo?.info && Array.isArray(conteudo.item)) return 'collection';
  if (Array.isArray(conteudo?.values)) return 'environment';
  throw new ErroHttp(422, 'O arquivo não é uma collection (v2.1) nem um environment do Postman.');
}

function nomeDe(tipo: TipoArquivo, conteudo: Qualquer, nomeArquivo?: string): string {
  const doArquivo = tipo === 'collection' ? conteudo.info?.name : conteudo.name;
  const n = String(doArquivo || nomeArquivo?.replace(/\.(postman_collection|postman_environment)?\.?json$/i, '') || '').trim();
  return n || (tipo === 'collection' ? 'Collection sem nome' : 'Environment sem nome');
}

// Tira do environment os valores secretos (vão para o cofre) e os tokens de execução (descartados).
function limparEnvironment(env: Qualquer): { guardado: Qualquer; segredos: Record<string, string>; descartadas: string[] } {
  const segredos: Record<string, string> = {};
  const descartadas: string[] = [];
  const values = (env.values ?? []).map((v: Qualquer) => {
    const classe = classificarVariavel(String(v?.key ?? ''), v?.type);
    if (classe === 'segredo') {
      if (v.value) segredos[v.key] = String(v.value);
      return { ...v, value: '', type: 'secret' };
    }
    if (classe === 'execucao') {
      if (v.value) descartadas.push(v.key);
      return { ...v, value: '' };
    }
    return v;
  });
  return { guardado: { ...env, values }, segredos, descartadas };
}

function contarExemplos(itens: Qualquer[]): number {
  let n = 0;
  for (const it of itens ?? []) {
    if (Array.isArray(it.item)) n += contarExemplos(it.item);
    else if (Array.isArray(it.response)) n += it.response.length;
  }
  return n;
}

function resumir(tipo: TipoArquivo, guardado: Qualquer, segredos: Record<string, string>, descartadas: string[]) {
  if (tipo === 'collection') {
    const l = lerPostman(guardado);
    return {
      schema: String(guardado.info?.schema ?? ''), requisicoes: l.operacoes.length, pastas: new Set(l.operacoes.map((o) => o.pasta).filter(Boolean)).size,
      variaveis: (guardado.variable ?? []).length, autenticacao: l.autenticacao?.tipo ?? null, exemplos: contarExemplos(guardado.item),
    };
  }
  const values = (guardado.values ?? []) as Qualquer[];
  const base = values.find((v) => classificarVariavel(String(v.key ?? ''), v.type) === 'base');
  return {
    variaveis: values.length, segredos: Object.keys(segredos).sort(), segredosVazios: values.filter((v) => v.type === 'secret' && !segredos[v.key]).map((v) => v.key),
    descartadas, baseUrl: base?.value || null,
  };
}

function versaoResumo(v: LinhaVersao) {
  return {
    id: v.id, arquivoId: v.arquivo_id, numero: v.numero, nomeArquivo: v.nome_arquivo, hash: v.hash, resumo: json(v.resumo, {}),
    importadoPor: v.importado_por, importadoEm: v.importado_em,
  };
}

function iguais(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

// Guarda um arquivo na biblioteca. Mesmo tipo e mesmo nome, ou o arquivoId informado: vira uma versão nova
// daquele item — a menos que nada tenha mudado, e então devolve a versão que já existe.
export function importarArquivo(conteudo: unknown, opcoes: { nomeArquivo?: string; arquivoId?: string } = {}) {
  const tipo = detectarTipo(conteudo);
  let guardado: Qualquer = conteudo;
  let segredos: Record<string, string> = {};
  let descartadas: string[] = [];
  if (tipo === 'environment') ({ guardado, segredos, descartadas } = limparEnvironment(conteudo));
  let resumo;
  try {
    resumo = resumir(tipo, guardado, segredos, descartadas);
  } catch (e) {
    throw new ErroHttp(422, (e as Error).message);
  }
  const texto = JSON.stringify(guardado);
  const hash = sha256(texto);
  const nome = nomeDe(tipo, guardado, opcoes.nomeArquivo);
  const quem = usuarioAtual().usuario;
  return transacao(() => {
    let arq = opcoes.arquivoId
      ? um<LinhaArquivo>('SELECT * FROM api_arquivos WHERE id = ?', opcoes.arquivoId)
      : um<LinhaArquivo>('SELECT * FROM api_arquivos WHERE tipo = ? AND nome = ?', tipo, nome);
    if (opcoes.arquivoId && !arq) throw new ErroHttp(404, 'Item da biblioteca não encontrado.');
    if (arq && arq.tipo !== tipo) throw new ErroHttp(422, `Este item é um ${arq.tipo}; a versão nova precisa ser do mesmo tipo.`);
    const t = agora();
    if (!arq) {
      const id = novoId(tipo === 'collection' ? 'col' : 'env');
      executar('INSERT INTO api_arquivos (id, tipo, nome, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)', id, tipo, nome, t, t);
      arq = um<LinhaArquivo>('SELECT * FROM api_arquivos WHERE id = ?', id)!;
    }
    const ultima = um<LinhaVersao>('SELECT * FROM api_versoes WHERE arquivo_id = ? ORDER BY numero DESC LIMIT 1', arq.id);
    if (ultima && ultima.hash === hash && iguais(segredosDaVersao(ultima.id), segredos)) {
      return { arquivo: { id: arq.id, tipo, nome: arq.nome }, versao: versaoResumo(ultima), nova: false };
    }
    const vid = novoId('ver');
    executar(
      `INSERT INTO api_versoes (id, arquivo_id, numero, nome_arquivo, conteudo, hash, resumo, importado_por, importado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      vid, arq.id, (ultima?.numero ?? 0) + 1, opcoes.nomeArquivo ?? null, texto, hash, JSON.stringify(resumo), quem, t,
    );
    for (const [k, v] of Object.entries(segredos)) salvarSegredoVersao(vid, k, v);
    executar('UPDATE api_arquivos SET atualizado_em = ? WHERE id = ?', t, arq.id);
    return { arquivo: { id: arq.id, tipo, nome: arq.nome }, versao: versaoResumo(um<LinhaVersao>('SELECT * FROM api_versoes WHERE id = ?', vid)!), nova: true };
  });
}

function usoDaVersao(versaoId: string) {
  return todos<{ id: string; nome: string; papel: string; ambiente: string | null }>(
    `SELECT d.id, d.nome, d.papel, a.nome AS ambiente FROM destinos d LEFT JOIN ambientes a ON a.id = d.ambiente_id
     WHERE d.colecao_versao_id = ? OR d.environment_versao_id = ? ORDER BY d.nome`, versaoId, versaoId,
  );
}

export function listarBiblioteca(tipo?: TipoArquivo) {
  const linhas = tipo
    ? todos<LinhaArquivo>('SELECT * FROM api_arquivos WHERE tipo = ? ORDER BY nome', tipo)
    : todos<LinhaArquivo>('SELECT * FROM api_arquivos ORDER BY tipo, nome');
  return linhas.map((a) => {
    const versoes = todos<LinhaVersao>('SELECT * FROM api_versoes WHERE arquivo_id = ? ORDER BY numero DESC', a.id);
    const integracoes = new Map<string, { id: string; nome: string }>();
    for (const v of versoes) for (const u of usoDaVersao(v.id)) integracoes.set(u.id, { id: u.id, nome: u.nome });
    return {
      id: a.id, tipo: a.tipo, nome: a.nome, descricao: a.descricao, versoes: versoes.length,
      ultima: versoes[0] ? versaoResumo(versoes[0]) : null, integracoes: [...integracoes.values()], atualizadoEm: a.atualizado_em,
    };
  });
}

export function detalharArquivo(id: string) {
  const a = um<LinhaArquivo>('SELECT * FROM api_arquivos WHERE id = ?', id);
  if (!a) throw new ErroHttp(404, 'Item da biblioteca não encontrado.');
  const versoes = todos<LinhaVersao>('SELECT * FROM api_versoes WHERE arquivo_id = ? ORDER BY numero DESC', id)
    .map((v) => ({ ...versaoResumo(v), integracoes: usoDaVersao(v.id) }));
  return { id: a.id, tipo: a.tipo, nome: a.nome, descricao: a.descricao, criadoEm: a.criado_em, atualizadoEm: a.atualizado_em, versoes };
}

export function obterVersao(versaoId: string): { id: string; arquivoId: string; tipo: TipoArquivo; nome: string; numero: number; conteudo: Qualquer; nomeArquivo: string | null } {
  const v = um<LinhaVersao & { tipo: TipoArquivo; nome: string }>(
    'SELECT v.*, a.tipo, a.nome FROM api_versoes v JOIN api_arquivos a ON a.id = v.arquivo_id WHERE v.id = ?', versaoId);
  if (!v) throw new ErroHttp(404, 'Versão não encontrada na biblioteca.');
  return { id: v.id, arquivoId: v.arquivo_id, tipo: v.tipo, nome: v.nome, numero: v.numero, conteudo: JSON.parse(v.conteudo), nomeArquivo: v.nome_arquivo };
}

// Para a tela: só o nome, o tipo e o número da versão.
export function rotuloVersao(versaoId: string | null) {
  if (!versaoId) return null;
  const v = um<{ id: string; arquivo_id: string; numero: number; nome: string; tipo: string }>(
    'SELECT v.id, v.arquivo_id, v.numero, a.nome, a.tipo FROM api_versoes v JOIN api_arquivos a ON a.id = v.arquivo_id WHERE v.id = ?', versaoId);
  if (!v) return null;
  const ultima = um<{ n: number }>('SELECT MAX(numero) AS n FROM api_versoes WHERE arquivo_id = ?', v.arquivo_id)?.n ?? v.numero;
  return { id: v.id, arquivoId: v.arquivo_id, nome: v.nome, tipo: v.tipo, numero: v.numero, ultima, desatualizada: v.numero < ultima };
}

// O environment com os segredos de volta, só para uso interno (ligar ou atualizar uma integração). Nunca sai pela API.
export function environmentComSegredos(versaoId: string): Qualquer {
  const v = obterVersao(versaoId);
  if (v.tipo !== 'environment') throw new ErroHttp(422, `${v.nome} não é um environment.`);
  const segredos = segredosDaVersao(versaoId);
  return { ...v.conteudo, values: (v.conteudo.values ?? []).map((x: Qualquer) => (segredos[x.key] !== undefined ? { ...x, value: segredos[x.key] } : x)) };
}

// O arquivo como foi guardado: o environment volta sem os valores secretos.
export function arquivoDaVersao(versaoId: string) {
  const v = obterVersao(versaoId);
  const sufixo = v.tipo === 'collection' ? 'postman_collection' : 'postman_environment';
  const nome = `${v.nome.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || v.tipo}-v${v.numero}.${sufixo}.json`;
  return { nome, conteudo: JSON.stringify(v.conteudo, null, 2) };
}

interface Requisicao { chave: string; nome: string; pasta: string; metodo: string; rota: string; corpo: string | null; cabecalhos: string }

// Sem environment, a rota ainda traz a variável do endereço base ({{base_url}}/v1/...): ela sai para comparar só o caminho.
const BASE_NA_ROTA = /^\/?\{\{\s*(base_?url|url_?base|baseurl|host|api_?url)\s*\}\}/i;

function requisicoes(colecao: Qualquer): Requisicao[] {
  return lerPostman(colecao).operacoes.map((o) => ({
    chave: `${o.pasta}/${o.nome}`, nome: o.nome, pasta: o.pasta, metodo: o.metodo, rota: o.rota.replace(BASE_NA_ROTA, '') || '/', corpo: o.corpo ?? null,
    cabecalhos: JSON.stringify(Object.entries(o.cabecalhos).sort()),
  }));
}

// O que mudou entre duas versões. Collection: requisições novas, removidas e alteradas. Environment: variáveis —
// de segredo, só se mudou, nunca o valor.
export function compararVersoes(deId: string, paraId: string) {
  const de = obterVersao(deId);
  const para = obterVersao(paraId);
  if (de.tipo !== para.tipo) throw new ErroHttp(422, 'Compare duas versões do mesmo tipo.');
  if (de.tipo === 'collection') {
    const a = requisicoes(de.conteudo);
    const b = requisicoes(para.conteudo);
    const casar = (r: Requisicao, lista: Requisicao[]) =>
      lista.find((x) => x.chave === r.chave) ?? lista.find((x) => x.metodo === r.metodo && normalizarRota(x.rota) === normalizarRota(r.rota));
    const novas: Qualquer[] = [];
    const alteradas: Qualquer[] = [];
    let iguais = 0;
    const usadas = new Set<Requisicao>();
    for (const r of b) {
      const antes = casar(r, a.filter((x) => !usadas.has(x)));
      if (!antes) { novas.push({ nome: r.nome, pasta: r.pasta, metodo: r.metodo, rota: r.rota }); continue; }
      usadas.add(antes);
      const mudou = [
        antes.nome !== r.nome || antes.pasta !== r.pasta ? 'nome' : '', antes.metodo !== r.metodo ? 'método' : '', antes.rota !== r.rota ? 'rota' : '',
        antes.corpo !== r.corpo ? 'corpo' : '', antes.cabecalhos !== r.cabecalhos ? 'cabeçalhos' : '',
      ].filter(Boolean);
      if (mudou.length) alteradas.push({ nome: r.nome, pasta: r.pasta, mudou, de: { metodo: antes.metodo, rota: antes.rota, nome: antes.nome }, para: { metodo: r.metodo, rota: r.rota } });
      else iguais++;
    }
    const removidas = a.filter((x) => !usadas.has(x)).map((r) => ({ nome: r.nome, pasta: r.pasta, metodo: r.metodo, rota: r.rota }));
    return { tipo: de.tipo, de: { id: de.id, numero: de.numero }, para: { id: para.id, numero: para.numero }, novas, removidas, alteradas, iguais };
  }
  const va = new Map<string, Qualquer>((de.conteudo.values ?? []).map((v: Qualquer) => [v.key, v]));
  const vb = new Map<string, Qualquer>((para.conteudo.values ?? []).map((v: Qualquer) => [v.key, v]));
  const sa = segredosDaVersao(de.id);
  const sb = segredosDaVersao(para.id);
  const secreta = (v: Qualquer) => v?.type === 'secret';
  const novas = [...vb.keys()].filter((k) => !va.has(k)).map((k) => ({ chave: k, segredo: secreta(vb.get(k)), valor: secreta(vb.get(k)) ? undefined : vb.get(k).value }));
  const removidas = [...va.keys()].filter((k) => !vb.has(k)).map((k) => ({ chave: k, segredo: secreta(va.get(k)) }));
  const alteradas: Qualquer[] = [];
  let iguais = 0;
  for (const [k, v] of vb) {
    const antes = va.get(k);
    if (!antes) continue;
    if (secreta(v) || secreta(antes)) {
      if ((sa[k] ?? '') !== (sb[k] ?? '') || secreta(v) !== secreta(antes)) alteradas.push({ chave: k, segredo: true });
      else iguais++;
    } else if (String(antes.value ?? '') !== String(v.value ?? '')) alteradas.push({ chave: k, segredo: false, de: antes.value, para: v.value });
    else iguais++;
  }
  return { tipo: de.tipo, de: { id: de.id, numero: de.numero }, para: { id: para.id, numero: para.numero }, novas, removidas, alteradas, iguais };
}

export function removerArquivo(id: string): void {
  detalharArquivo(id);
  const uso = um<{ n: number }>(
    `SELECT COUNT(*) AS n FROM destinos d JOIN api_versoes v ON (v.id = d.colecao_versao_id OR v.id = d.environment_versao_id) WHERE v.arquivo_id = ?`, id);
  if (uso && uso.n > 0) throw new ErroHttp(409, 'Há integrações usando este item. Troque a versão delas ou remova-as antes.');
  executar('DELETE FROM api_arquivos WHERE id = ?', id);
}

// Rotas da API do app (/api/...). A interface usa só estas rotas.
// Toda ação que muda algo fica na trilha de auditoria: quem, quando, o quê e em quê. Segredos nunca entram.
import { Roteador, ErroHttp, arquivo, criado, exigir } from './http.ts';
import { config } from './config.ts';
import { todos, um } from './db.ts';
import { auditar, acoesAuditadas, listarAuditoria, verificarIntegridade } from './auditoria.ts';
import {
  aceitarConvite, alterarUsuario, cookieSessao, entrar, eu, gerarLink, identificar, lerConvite, listarUsuarios, preCadastrar, sair, trocarSenha,
} from './usuarios.ts';
import { catalogoGeradores } from './core/geradores.ts';
import { exportarPacote, instalarPacote, listarPacotes, removerPacote } from './servicos/pacotes.ts';
import {
  ACOES, PAPEIS, SEGREDOS_POR_AUTH, aplicarImportacao, aplicarOperacoesDoPacote, atualizarDestino, atualizarOperacao, criarDestino, criarOperacao,
  definirSegredo, detalharDestino, divergencias, historicoImportacoes, integracaoDaBiblioteca, ligarVersoes, listarDestinos, listarOperacoes,
  obterDestino, previaImportacao, removerDestino, removerOperacao, trocarVersoes,
} from './servicos/destinos.ts';
import { atualizarAmbiente, criarAmbiente, detalharAmbiente, listarAmbientes, obterAmbiente, removerAmbiente, TIPOS_AMBIENTE } from './servicos/ambientes.ts';
import {
  arquivoDaVersao, compararVersoes, detalharArquivo, importarArquivo, listarBiblioteca, obterVersao, removerArquivo, type TipoArquivo,
} from './servicos/biblioteca.ts';
import { criarModelo, exemplo, listarModelos, obterModelo, removerModelo, restaurarModelo, salvarModelo } from './servicos/modelos.ts';
import { atualizarCadastro, criarCadastro, desvincular, etiquetasEmUso, listarCadastros, obterCadastro, removerCadastro } from './servicos/cadastros.ts';
import { atualizarCenario, cenarioDoPacote, criarCenario, listarCenarios, obterCenario, removerCenario } from './servicos/cenarios.ts';
import {
  editarRegistro, exportarExecucao, gerarExecucao, listarExecucoes, listarRegistros, obterExecucaoLinha, obterRegistro, removerExecucao,
  resumoExecucao, salvarComoCadastro,
} from './servicos/execucoes.ts';
import { cancelar, estaAtiva, iniciarEnvio, pausar, reenviarRegistro, testarConexao } from './engine/executor.ts';
import { linhaDoTempo, listarRequisicoes, obterRequisicao, painelExecucao } from './servicos/monitor.ts';
import { pacoteDeEvidencias, trilhaDaExecucao } from './servicos/rastreabilidade.ts';
import {
  atualizarPoc, barramento, criarPoc, detalharAviso, detalharNota, detalharPoc, detalharTiquete, importarNotas, listarEnvios, listarNotas, listarPocs,
  novaCredencialCbs, novaCredencialIbs, obterArquivo, obterTiquete, removerPoc, xmlDaNota,
} from './servicos/pocs.ts';
import { CAMPOS, CATALOGO_IBS, ROTEIROS } from './emulacao/catalogo.ts';
import { CAMPOS_CBS, CATALOGO_CBS, DERIVADOS_CBS } from './emulacao/catalogo-cbs.ts';
import { gravarEnvioManual, obterPoc, planejarEnvio } from './emulacao/execucao.ts';
import { aplicarRoteiro, planejarRoteiro } from './emulacao/plano.ts';
import { fecharDia } from './emulacao/relogio.ts';
import { zipDoArquivo } from './emulacao/arquivo-ibs.ts';
import { avisarSolicitacao } from './entes/ibs.ts';
import { avisarTiquete, cadastrarUrlRetorno } from './entes/cbs.ts';
import { colecaoCbs, colecaoIbs } from './entes/colecao.ts';

export const rotas = new Roteador();
rotas.identificar = identificar;
const num = (v: string | null) => (v === null || v === '' ? undefined : Number(v));
const txt = (v: string | null) => v || undefined;

// Diferença entre dois objetos, só nos campos que mudaram (para a trilha).
function mudancas(antes: Record<string, unknown>, depois: Record<string, unknown>, ignorar: string[] = []): Record<string, { de: unknown; para: unknown }> {
  const saida: Record<string, { de: unknown; para: unknown }> = {};
  for (const k of new Set([...Object.keys(antes), ...Object.keys(depois)])) {
    if (ignorar.includes(k)) continue;
    if (JSON.stringify(antes[k]) !== JSON.stringify(depois[k])) saida[k] = { de: antes[k], para: depois[k] };
  }
  return saida;
}

const exe = (id: string) => obterExecucaoLinha(id).codigo as string;

// ---------------------------------------------------------------- geral
rotas.get('/api/saude', () => ({ ok: true }), { publico: true });
rotas.get('/api/config', ({ quem }) => ({
  dominiosPermitidos: config.dominiosPermitidos, dominiosBloqueados: config.dominiosBloqueados, acoes: ACOES, segredosPorAutenticacao: SEGREDOS_POR_AUTH,
  papeis: PAPEIS, tiposAmbiente: TIPOS_AMBIENTE,
  usuario: eu(quem!),
}));

// ---------------------------------------------------------------- sessão, convites e usuários
// Quem está logado (ou null). Pública: a interface usa para decidir entre a tela de login e o app.
// bloqueio: o Cloudflare Access autenticou um e-mail que não tem acesso ao MassGen (a tela mostra o motivo em vez do login).
rotas.get('/api/sessao', ({ req, quem }) => {
  let bloqueio: string | null = null;
  if (!quem) { try { identificar(req); } catch (e) { bloqueio = (e as Error).message; } }
  return { usuario: quem ? eu(quem) : null, cloudflareAccess: config.confiarCloudflareAccess, bloqueio };
}, { publico: true });
rotas.post('/api/sessao', ({ corpo, req }) => {
  const r = entrar(corpo?.email, corpo?.senha, req);
  return { __resposta: true, status: 200, corpo: JSON.stringify({ usuario: r.usuario }), cabecalhos: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookieSessao(r.token) } };
}, { publico: true });
rotas.delete('/api/sessao', ({ req, quem }) => {
  sair(req, quem);
  return { __resposta: true, status: 204, corpo: '', cabecalhos: { 'set-cookie': cookieSessao(null) } };
}, { publico: true });
rotas.post('/api/sessao/senha', ({ corpo, req, quem }) => {
  const token = trocarSenha(quem!, corpo?.atual, corpo?.nova, req);
  return { __resposta: true, status: 200, corpo: JSON.stringify({ ok: true }), cabecalhos: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookieSessao(token) } };
}, { leitorPode: true });
rotas.get('/api/convites/:token', ({ params }) => lerConvite(params.token), { publico: true });
rotas.post('/api/convites/:token', ({ params, corpo, req }) => {
  const r = aceitarConvite(params.token, corpo?.nome, corpo?.senha, req);
  return { __resposta: true, status: 200, corpo: JSON.stringify({ usuario: r.usuario }), cabecalhos: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookieSessao(r.token) } };
}, { publico: true });

const SO_ROOT = { papeis: ['root' as const] };
rotas.get('/api/usuarios', () => listarUsuarios(), SO_ROOT);
rotas.post('/api/usuarios', ({ corpo, quem }) => criado(preCadastrar(quem!, corpo ?? {})), SO_ROOT);
rotas.patch('/api/usuarios/:id', ({ params, corpo, quem }) => alterarUsuario(quem!, params.id, corpo ?? {}), SO_ROOT);
rotas.post('/api/usuarios/:id/link', ({ params, quem }) => gerarLink(quem!, params.id), SO_ROOT);
rotas.get('/api/catalogo/geradores', () => catalogoGeradores());
rotas.get('/api/painel', () => ({
  ambientes: listarAmbientes().map((a) => ({ id: a.id, nome: a.nome, tipo: a.tipo, integracoes: a.integracoes })),
  biblioteca: um<{ n: number }>('SELECT COUNT(*) AS n FROM api_arquivos')!.n,
  destinos: listarDestinos().map((d) => ({ id: d.id, nome: d.nome, tipoAmbiente: d.tipoAmbiente, baseUrl: d.baseUrl, ultimoTeste: d.ultimoTeste, ativo: d.ativo, papel: d.papel, status: d.status, ambiente: d.ambiente })),
  pacotes: listarPacotes().map((p) => ({ id: p.id, nome: p.nome, versao: p.versao, modelos: p.modelos.length })),
  cenarios: um<{ n: number }>('SELECT COUNT(*) AS n FROM cenarios')!.n,
  cadastros: um<{ n: number }>('SELECT COUNT(*) AS n FROM cadastros')!.n,
  execucoes: listarExecucoes(8),
  auditoria: listarAuditoria({ limite: 8 }),
}));

// ---------------------------------------------------------------- auditoria
rotas.get('/api/auditoria', ({ query }) => listarAuditoria({
  acao: txt(query.get('acao')), usuario: txt(query.get('usuario')), alvoId: txt(query.get('alvo')), execucaoId: txt(query.get('execucao')),
  de: txt(query.get('de')), ate: txt(query.get('ate')), antesDe: num(query.get('antesDe')), limite: num(query.get('limite')),
}));
rotas.get('/api/auditoria/acoes', () => acoesAuditadas());
rotas.get('/api/auditoria/integridade', () => {
  const r = verificarIntegridade();
  auditar('auditoria.verificar', `Integridade verificada: auditoria ${r.auditoria.ok ? 'íntegra' : 'com falha'}, requisições ${r.requisicoes.ok ? 'íntegras' : 'com falha'}`, { detalhes: r });
  return r;
});

// ---------------------------------------------------------------- pacotes e modelos
rotas.get('/api/pacotes', () => listarPacotes());
rotas.post('/api/pacotes', ({ corpo }) => {
  const r = instalarPacote(corpo?.conteudo, { sobrescreverModelos: !!corpo?.sobrescrever });
  auditar('pacote.instalar', `Pacote ${corpo.conteudo.nome} ${corpo.conteudo.versao} instalado`, { alvoTipo: 'pacote', alvoId: r.id, detalhes: r });
  return criado(r);
});
rotas.get('/api/pacotes/:id/exportar', ({ params }) => {
  const c = exportarPacote(params.id);
  return arquivo(JSON.stringify(c, null, 2), 'application/json; charset=utf-8', `pacote-${c.id}-${c.versao}.json`);
});
rotas.delete('/api/pacotes/:id', ({ params }) => {
  removerPacote(params.id);
  auditar('pacote.remover', `Pacote ${params.id} removido`, { alvoTipo: 'pacote', alvoId: params.id });
});

rotas.get('/api/modelos', ({ query }) => listarModelos(txt(query.get('pacote'))));
rotas.post('/api/modelos', ({ corpo }) => {
  const m = criarModelo(corpo?.pacoteId, corpo?.definicao);
  auditar('modelo.criar', `Modelo ${m.nome} criado no pacote ${m.pacoteId}`, { alvoTipo: 'modelo', alvoId: m.id });
  return criado(m);
});
rotas.get('/api/modelos/:id', ({ params }) => obterModelo(params.id));
rotas.put('/api/modelos/:id', ({ params, corpo }) => {
  const antes = obterModelo(params.id).definicao;
  const m = salvarModelo(params.id, corpo?.definicao);
  auditar('modelo.alterar', `Modelo ${m.nome} alterado`, { alvoTipo: 'modelo', alvoId: m.id, detalhes: { campos: mudancas(antes as never, m.definicao as never) } });
  return m;
});
rotas.delete('/api/modelos/:id', ({ params }) => {
  const m = obterModelo(params.id);
  removerModelo(params.id);
  auditar('modelo.remover', `Modelo ${m.nome} removido`, { alvoTipo: 'modelo', alvoId: params.id });
});
rotas.post('/api/modelos/:id/restaurar', ({ params }) => {
  const m = restaurarModelo(params.id);
  auditar('modelo.restaurar', `Modelo ${m.nome} restaurado para a versão do pacote`, { alvoTipo: 'modelo', alvoId: m.id });
  return m;
});
rotas.post('/api/modelos/:id/exemplo', ({ params, corpo }) => exemplo(params.id, { definicao: corpo?.definicao, destinoId: corpo?.destinoId, semente: corpo?.semente }), { leitorPode: true });

// ---------------------------------------------------------------- destinos e estrutura de APIs
rotas.get('/api/destinos', ({ query }) => listarDestinos({ ambienteId: txt(query.get('ambiente')) }));
rotas.post('/api/destinos', ({ corpo }) => {
  const d = criarDestino(corpo ?? {});
  auditar('destino.criar', `Integração ${d.nome} criada (${d.papel}, ${d.baseUrl})`, { alvoTipo: 'destino', alvoId: d.id, detalhes: { baseUrl: d.baseUrl, autenticacao: d.autenticacao.tipo, pacote: d.pacoteId, ambiente: d.ambienteId, papel: d.papel, ente: d.ente } });
  return criado(d);
});
rotas.put('/api/destinos/:id/versoes', ({ params, corpo }) => {
  const antes = obterDestino(params.id);
  const r = trocarVersoes(params.id, { colecaoVersaoId: txt(corpo?.colecaoVersaoId), environmentVersaoId: corpo?.environmentVersaoId === null ? null : txt(corpo?.environmentVersaoId) });
  const depois = obterDestino(params.id);
  auditar('destino.versoes', `Integração ${depois.nome} passou para outras versões da biblioteca`, {
    alvoTipo: 'destino', alvoId: params.id,
    detalhes: { colecao: { de: antes.colecaoVersaoId, para: depois.colecaoVersaoId }, environment: { de: antes.environmentVersaoId, para: depois.environmentVersaoId }, resumo: r.resumo },
  });
  return { ...r, destino: detalharDestino(params.id) };
});
rotas.get('/api/destinos/:id', ({ params }) => detalharDestino(params.id));
rotas.put('/api/destinos/:id', ({ params, corpo }) => {
  const antes = obterDestino(params.id);
  const d = atualizarDestino(params.id, corpo ?? {});
  auditar('destino.alterar', `Destino ${d.nome} alterado`, { alvoTipo: 'destino', alvoId: d.id, detalhes: mudancas(antes as never, d as never, ['atualizadoEm', 'ultimoTeste']) });
  return d;
});
rotas.delete('/api/destinos/:id', ({ params }) => {
  const d = obterDestino(params.id);
  removerDestino(params.id);
  auditar('destino.remover', `Destino ${d.nome} removido`, { alvoTipo: 'destino', alvoId: params.id });
});
rotas.put('/api/destinos/:id/segredos', ({ params, corpo }) => {
  const chave = String(corpo?.chave ?? '');
  const removido = corpo?.valor === null || corpo?.valor === '';
  definirSegredo(params.id, chave, corpo?.valor ?? null);
  auditar('destino.segredo', `Segredo ${chave} ${removido ? 'removido' : 'definido'} no destino ${obterDestino(params.id).nome}`, { alvoTipo: 'destino', alvoId: params.id, detalhes: { chave, acao: removido ? 'removido' : 'definido' } });
  return detalharDestino(params.id);
});
rotas.post('/api/destinos/:id/testar', async ({ params }) => {
  const r = await testarConexao(params.id);
  auditar('destino.testar', `Teste de conexão de ${obterDestino(params.id).nome}: ${r.ok ? 'ok' : 'falhou'}`, { alvoTipo: 'destino', alvoId: params.id, detalhes: r });
  return r;
});
rotas.get('/api/destinos/:id/operacoes', ({ params }) => listarOperacoes(params.id));
rotas.post('/api/destinos/:id/operacoes', ({ params, corpo }) => {
  const o = criarOperacao(params.id, corpo ?? {});
  auditar('operacao.criar', `Operação ${o.nome} (${o.metodo} ${o.rota}) criada`, { alvoTipo: 'destino', alvoId: params.id, detalhes: o });
  return criado(o);
});
rotas.post('/api/destinos/:id/operacoes-padrao', ({ params }) => {
  const n = aplicarOperacoesDoPacote(params.id);
  auditar('operacao.padrao', `${n} operação(ões) padrão do pacote aplicada(s)`, { alvoTipo: 'destino', alvoId: params.id });
  return { criadas: n };
});
rotas.get('/api/destinos/:id/divergencias', ({ params }) => divergencias(params.id));
rotas.get('/api/destinos/:id/importacoes', ({ params }) => historicoImportacoes(params.id));
rotas.put('/api/operacoes/:id', ({ params, corpo }) => {
  const antes = um<Record<string, unknown>>('SELECT * FROM operacoes WHERE id = ?', params.id);
  const o = atualizarOperacao(params.id, corpo ?? {});
  auditar('operacao.alterar', `Operação ${o.nome} alterada`, { alvoTipo: 'destino', alvoId: o.destinoId, detalhes: { antes: { metodo: antes?.metodo, rota: antes?.rota, entidade: antes?.entidade, acao: antes?.acao }, depois: o } });
  return o;
});
rotas.delete('/api/operacoes/:id', ({ params }) => {
  const o = exigir(um<{ nome: string; destino_id: string }>('SELECT nome, destino_id FROM operacoes WHERE id = ?', params.id), 'Operação não encontrada.');
  removerOperacao(params.id);
  auditar('operacao.remover', `Operação ${o.nome} removida`, { alvoTipo: 'destino', alvoId: o.destino_id });
});

rotas.post('/api/importacao/postman/previa', ({ corpo }) => {
  const p = previaImportacao(corpo?.colecao, corpo?.ambiente, txt(corpo?.destinoId), txt(corpo?.pacoteId));
  // A prévia nunca devolve os valores dos segredos.
  return { ...p, leitura: { ...p.leitura, segredos: Object.keys(p.leitura.segredos) } };
});
// Aplica a importação e guarda os dois arquivos na biblioteca de APIs, ligando a integração às versões.
rotas.post('/api/importacao/postman/aplicar', ({ corpo }) => {
  const r = aplicarImportacao(corpo?.colecao, corpo?.ambiente, {
    destinoId: txt(corpo?.destinoId), nome: corpo?.nome, tipoAmbiente: corpo?.tipoAmbiente, pacoteId: txt(corpo?.pacoteId), baseUrl: txt(corpo?.baseUrl),
    ambienteId: txt(corpo?.ambienteId), papel: txt(corpo?.papel) as never, ente: txt(corpo?.ente),
  });
  const col = importarArquivo(corpo?.colecao, { nomeArquivo: txt(corpo?.nomeColecao) });
  const env = corpo?.ambiente ? importarArquivo(corpo.ambiente, { nomeArquivo: txt(corpo?.nomeAmbiente) }) : undefined;
  ligarVersoes(r.destinoId, col.versao.id, env ? env.versao.id : undefined);
  for (const x of [col, env]) {
    if (x?.nova) auditar('biblioteca.importar', `${x.arquivo.tipo === 'collection' ? 'Collection' : 'Environment'} ${x.arquivo.nome} v${x.versao.numero} guardado na biblioteca`, { alvoTipo: 'biblioteca', alvoId: x.arquivo.id, detalhes: { versao: x.versao.numero, hash: x.versao.hash, nomeArquivo: x.versao.nomeArquivo } });
  }
  auditar('importacao.postman', `Collection "${r.resumo.colecao}" importada: ${r.resumo.operacoes} operações, ${r.resumo.ligadas} ligadas a entidades`, { alvoTipo: 'destino', alvoId: r.destinoId, detalhes: { ...r.resumo, colecaoVersao: col.versao.id, environmentVersao: env?.versao.id } });
  return { ...r, biblioteca: { colecao: { arquivoId: col.arquivo.id, numero: col.versao.numero, nova: col.nova }, environment: env ? { arquivoId: env.arquivo.id, numero: env.versao.numero, nova: env.nova } : null } };
});

// ---------------------------------------------------------------- ambientes
rotas.get('/api/ambientes', () => listarAmbientes());
rotas.post('/api/ambientes', ({ corpo }) => {
  const a = criarAmbiente(corpo ?? {});
  auditar('ambiente.criar', `Ambiente ${a.nome} criado (${a.tipo})`, { alvoTipo: 'ambiente', alvoId: a.id, detalhes: a });
  return criado(a);
});
rotas.get('/api/ambientes/:id', ({ params }) => detalharAmbiente(params.id));
rotas.put('/api/ambientes/:id', ({ params, corpo }) => {
  const antes = obterAmbiente(params.id);
  const a = atualizarAmbiente(params.id, corpo ?? {});
  auditar('ambiente.alterar', `Ambiente ${a.nome} alterado`, { alvoTipo: 'ambiente', alvoId: a.id, detalhes: mudancas(antes as never, a as never, ['atualizadoEm']) });
  return a;
});
rotas.delete('/api/ambientes/:id', ({ params }) => {
  const a = obterAmbiente(params.id);
  removerAmbiente(params.id);
  auditar('ambiente.remover', `Ambiente ${a.nome} removido`, { alvoTipo: 'ambiente', alvoId: params.id });
});
rotas.post('/api/ambientes/:id/integracoes', ({ params, corpo }) => {
  const r = integracaoDaBiblioteca(params.id, {
    nome: txt(corpo?.nome), papel: txt(corpo?.papel) as never, ente: txt(corpo?.ente), colecaoVersaoId: txt(corpo?.colecaoVersaoId),
    environmentVersaoId: txt(corpo?.environmentVersaoId) ?? null, baseUrl: txt(corpo?.baseUrl), pacoteId: corpo?.pacoteId === null ? null : txt(corpo?.pacoteId),
  });
  const d = obterDestino(r.destinoId);
  auditar('destino.criar', `Integração ${d.nome} ligada ao ambiente ${obterAmbiente(params.id).nome} pela biblioteca (${d.papel})`, {
    alvoTipo: 'destino', alvoId: d.id, detalhes: { ambiente: params.id, papel: d.papel, ente: d.ente, colecaoVersao: d.colecaoVersaoId, environmentVersao: d.environmentVersaoId, resumo: r.resumo },
  });
  return criado({ ...r, destino: detalharDestino(d.id) });
});

// ---------------------------------------------------------------- biblioteca de APIs
rotas.get('/api/biblioteca', ({ query }) => listarBiblioteca(txt(query.get('tipo')) as TipoArquivo | undefined));
rotas.post('/api/biblioteca', ({ corpo }) => {
  const r = importarArquivo(corpo?.conteudo, { nomeArquivo: txt(corpo?.nomeArquivo), arquivoId: txt(corpo?.arquivoId) });
  if (r.nova) {
    auditar('biblioteca.importar', `${r.arquivo.tipo === 'collection' ? 'Collection' : 'Environment'} ${r.arquivo.nome} v${r.versao.numero} guardado na biblioteca`, {
      alvoTipo: 'biblioteca', alvoId: r.arquivo.id, detalhes: { versao: r.versao.numero, hash: r.versao.hash, nomeArquivo: r.versao.nomeArquivo, resumo: r.versao.resumo },
    });
  }
  return criado(r);
});
rotas.get('/api/biblioteca/comparar', ({ query }) => compararVersoes(String(query.get('de') ?? ''), String(query.get('para') ?? '')));
rotas.get('/api/biblioteca/versoes/:id/arquivo', ({ params }) => {
  const f = arquivoDaVersao(params.id);
  const v = obterVersao(params.id);
  auditar('biblioteca.baixar', `${v.nome} v${v.numero} baixado da biblioteca`, { alvoTipo: 'biblioteca', alvoId: v.arquivoId });
  return arquivo(f.conteudo, 'application/json; charset=utf-8', f.nome);
});
rotas.get('/api/biblioteca/:id', ({ params }) => detalharArquivo(params.id));
rotas.delete('/api/biblioteca/:id', ({ params }) => {
  const a = detalharArquivo(params.id);
  removerArquivo(params.id);
  auditar('biblioteca.remover', `${a.nome} removido da biblioteca`, { alvoTipo: 'biblioteca', alvoId: params.id });
});

// ---------------------------------------------------------------- cadastros mestres
rotas.get('/api/cadastros', ({ query }) => listarCadastros({
  entidade: txt(query.get('entidade')), busca: txt(query.get('busca')), etiqueta: txt(query.get('etiqueta')), pacoteId: txt(query.get('pacote')),
}));
rotas.get('/api/cadastros-etiquetas', () => etiquetasEmUso());
rotas.post('/api/cadastros', async ({ corpo }) => {
  const c = await criarCadastro(corpo ?? {});
  auditar('cadastro.criar', `Cadastro ${c.rotulo} (${c.entidade}) criado`, { alvoTipo: 'cadastro', alvoId: c.id });
  return criado(c);
});
rotas.get('/api/cadastros/:id', ({ params }) => obterCadastro(params.id));
rotas.put('/api/cadastros/:id', async ({ params, corpo }) => {
  const antes = obterCadastro(params.id);
  const c = await atualizarCadastro(params.id, corpo ?? {});
  auditar('cadastro.alterar', `Cadastro ${c.rotulo} alterado (versão ${c.versao})`, { alvoTipo: 'cadastro', alvoId: c.id, detalhes: mudancas(antes.dados, c.dados) });
  return c;
});
rotas.delete('/api/cadastros/:id', ({ params }) => {
  const c = obterCadastro(params.id);
  removerCadastro(params.id);
  auditar('cadastro.remover', `Cadastro ${c.rotulo} removido`, { alvoTipo: 'cadastro', alvoId: params.id });
});
rotas.delete('/api/cadastros/:id/vinculos/:destino', ({ params }) => {
  desvincular(params.id, params.destino);
  auditar('cadastro.desvincular', `Vínculo do cadastro com o destino ${params.destino} removido`, { alvoTipo: 'cadastro', alvoId: params.id });
  return obterCadastro(params.id);
});

// ---------------------------------------------------------------- cenários e execuções
rotas.get('/api/cenarios', () => listarCenarios());
rotas.post('/api/cenarios', ({ corpo }) => {
  const c = criarCenario(corpo ?? {});
  auditar('cenario.criar', `Cenário ${c.nome} criado`, { alvoTipo: 'cenario', alvoId: c.id, detalhes: c.definicao });
  return criado(c);
});
rotas.post('/api/cenarios/do-pacote', ({ corpo }) => {
  const c = cenarioDoPacote(corpo?.pacoteId, corpo?.cenarioId, txt(corpo?.destinoId));
  auditar('cenario.criar', `Cenário ${c.nome} criado a partir do pacote ${c.pacoteId}`, { alvoTipo: 'cenario', alvoId: c.id, detalhes: c.definicao });
  return criado(c);
});
rotas.get('/api/cenarios/:id', ({ params }) => obterCenario(params.id));
rotas.put('/api/cenarios/:id', ({ params, corpo }) => {
  const antes = obterCenario(params.id);
  const c = atualizarCenario(params.id, corpo ?? {});
  auditar('cenario.alterar', `Cenário ${c.nome} alterado`, { alvoTipo: 'cenario', alvoId: c.id, detalhes: mudancas(antes as never, c as never, ['atualizadoEm']) });
  return c;
});
rotas.delete('/api/cenarios/:id', ({ params }) => {
  const c = obterCenario(params.id);
  removerCenario(params.id);
  auditar('cenario.remover', `Cenário ${c.nome} removido`, { alvoTipo: 'cenario', alvoId: params.id });
});
rotas.post('/api/cenarios/:id/gerar', async ({ params, corpo }) => {
  const e = await gerarExecucao(params.id, { semente: corpo?.semente === '' ? undefined : num(corpo?.semente ?? null), dataReferencia: txt(corpo?.dataReferencia), destinoId: txt(corpo?.destinoId) });
  auditar('execucao.gerar', `Execução ${e.codigo} gerada: ${e.total} registros do cenário ${e.cenarioNome} (semente ${e.semente})`, {
    alvoTipo: 'execucao', alvoId: e.id as string, execucaoId: e.id as string,
    detalhes: { semente: e.semente, dataReferencia: e.dataReferencia, destino: e.destinoNome, pacote: e.pacoteId, pacoteVersao: e.pacoteVersao, modelosHash: e.modelosHash, total: e.total },
  });
  return criado(e);
});

rotas.get('/api/execucoes', () => listarExecucoes(200));
rotas.get('/api/execucoes/:id', ({ params }) => ({ ...resumoExecucao(params.id), ativa: estaAtiva(params.id) }));
rotas.delete('/api/execucoes/:id', ({ params }) => {
  const codigo = exe(params.id);
  removerExecucao(params.id);
  auditar('execucao.remover', `Execução ${codigo} apagada com os registros e requisições`, { alvoTipo: 'execucao', alvoId: params.id, execucaoId: params.id });
});
rotas.get('/api/execucoes/:id/registros', ({ params, query }) => listarRegistros(params.id, {
  entidade: txt(query.get('entidade')), status: txt(query.get('status')), resultado: txt(query.get('resultado')), busca: txt(query.get('busca')),
  pagina: num(query.get('pagina')), tamanho: num(query.get('tamanho')),
}));

function acaoDeEnvio(acao: string, rotulo: string, fn: (id: string) => void) {
  return ({ params }: { params: Record<string, string> }) => {
    fn(params.id);
    const r = resumoExecucao(params.id);
    auditar(`execucao.${acao}`, `${rotulo} da execução ${r.codigo} para ${r.destinoNome ?? 'destino'}`, { alvoTipo: 'execucao', alvoId: params.id, execucaoId: params.id, detalhes: { pendentes: r.pendentes, total: r.total } });
    return r;
  };
}
rotas.post('/api/execucoes/:id/enviar', acaoDeEnvio('enviar', 'Envio iniciado', (id) => iniciarEnvio(id)));
rotas.post('/api/execucoes/:id/retomar', acaoDeEnvio('retomar', 'Envio retomado', (id) => iniciarEnvio(id)));
rotas.post('/api/execucoes/:id/reenviar-falhas', acaoDeEnvio('reenviar_falhas', 'Reenvio das falhas', (id) => iniciarEnvio(id, { reenviarFalhas: true })));
rotas.post('/api/execucoes/:id/pausar', acaoDeEnvio('pausar', 'Pausa', pausar));
rotas.post('/api/execucoes/:id/cancelar', acaoDeEnvio('cancelar', 'Cancelamento', cancelar));
rotas.post('/api/execucoes/:id/repetir', async ({ params }) => {
  const l = obterExecucaoLinha(params.id);
  if (!l.cenario_id) throw new ErroHttp(409, 'O cenário desta execução foi apagado.');
  const e = await gerarExecucao(l.cenario_id as string, { semente: l.semente as number, dataReferencia: l.data_referencia as string, destinoId: l.destino_id as string });
  auditar('execucao.repetir', `Execução ${e.codigo} gerada repetindo ${l.codigo} (mesma semente ${l.semente})`, { alvoTipo: 'execucao', alvoId: e.id as string, execucaoId: e.id as string, detalhes: { origem: l.codigo } });
  return criado(e);
});
rotas.get('/api/execucoes/:id/painel', ({ params }) => painelExecucao(params.id));
rotas.get('/api/execucoes/:id/trilha', ({ params }) => trilhaDaExecucao(params.id));
rotas.get('/api/execucoes/:id/exportar', ({ params, query }) => {
  const formato = query.get('formato') === 'csv' ? 'csv' : 'json';
  const e = exportarExecucao(params.id, formato, txt(query.get('entidade')));
  auditar('execucao.exportar', `Massa da execução ${exe(params.id)} exportada (${e.nome})`, { alvoTipo: 'execucao', alvoId: params.id, execucaoId: params.id });
  return arquivo(e.corpo, e.tipo, e.nome);
});
rotas.get('/api/execucoes/:id/rastreabilidade', ({ params }) => {
  const codigo = exe(params.id);
  auditar('execucao.evidencias', `Pacote de evidências da execução ${codigo} baixado`, { alvoTipo: 'execucao', alvoId: params.id, execucaoId: params.id });
  const p = pacoteDeEvidencias(params.id);
  return arquivo(JSON.stringify(p, null, 2), 'application/json; charset=utf-8', `massgen-evidencias-${codigo}.json`);
});

rotas.get('/api/registros/:id', ({ params }) => ({ ...obterRegistro(params.id), linhaDoTempo: linhaDoTempo(params.id) }));
rotas.patch('/api/registros/:id', async ({ params, corpo }) => {
  const antes = obterRegistro(params.id);
  const r = await editarRegistro(params.id, corpo?.dados);
  auditar('registro.editar', `Registro ${r.rotulo} editado antes do envio`, { alvoTipo: 'registro', alvoId: r.id, execucaoId: r.execucaoId, detalhes: mudancas(antes.dados, r.dados) });
  return r;
});
rotas.post('/api/registros/:id/salvar-cadastro', async ({ params, corpo }) => {
  const c = await salvarComoCadastro(params.id, corpo?.etiquetas ?? []);
  const r = obterRegistro(params.id);
  auditar('registro.salvar_cadastro', `Registro ${r.rotulo} salvo como cadastro mestre`, { alvoTipo: 'cadastro', alvoId: c.id, execucaoId: r.execucaoId });
  return criado(c);
});

// ---------------------------------------------------------------- monitor
rotas.get('/api/requisicoes', ({ query }) => listarRequisicoes({
  execucaoId: txt(query.get('execucao')), destinoId: txt(query.get('destino')), registroId: txt(query.get('registro')), fase: txt(query.get('fase')),
  faixa: txt(query.get('faixa')), entidade: txt(query.get('entidade')), codigo: txt(query.get('codigo')), busca: txt(query.get('busca')),
  depoisDe: num(query.get('depoisDe')), antesDe: num(query.get('antesDe')), limite: num(query.get('limite')),
}));
rotas.get('/api/requisicoes/:id', ({ params }) => obterRequisicao(Number(params.id)));
rotas.post('/api/requisicoes/:id/reenviar', async ({ params, corpo }) => {
  const original = exigir(um<{ registro_id: string; execucao_id: string; rastreio: string }>('SELECT registro_id, execucao_id, rastreio FROM requisicoes WHERE id = ?', Number(params.id)), 'Requisição não encontrada.');
  await reenviarRegistro(Number(params.id), !!corpo?.novaChave);
  const ultima = todos<{ id: number }>('SELECT id FROM requisicoes WHERE registro_id = ? ORDER BY id DESC LIMIT 1', original.registro_id)[0];
  const r = obterRequisicao(ultima.id);
  auditar('requisicao.reenviar', `Registro reenviado ${corpo?.novaChave ? 'com chave de idempotência nova' : 'com a mesma chave'} (origem ${original.rastreio ?? `#${params.id}`})`, {
    alvoTipo: 'registro', alvoId: original.registro_id, execucaoId: original.execucao_id, detalhes: { requisicaoOrigem: Number(params.id), requisicaoNova: ultima.id, status: r.status },
  });
  return r;
});

// ---------------------------------------------------------------- POC da apuração assistida (v4.3, etapas 1 e 2: IBS e CBS)
rotas.get('/api/catalogo/eventos', () => ({
  campos: CAMPOS,
  camposCbs: CAMPOS_CBS,
  derivadosCbs: DERIVADOS_CBS.map(({ calcular: _, ...d }) => d),
  ibs: CATALOGO_IBS.map((t) => ({ id: t.id, n: t.n, mov: t.mov, grupo: t.grupo, lado: t.lado, efeito: t.efeito, precisa: t.precisa, relacionada: t.relacionada ?? null, unico: t.unico ?? null, parcial: !!t.parcial, nota: t.nota ?? null })),
  cbs: CATALOGO_CBS.map((t) => ({
    id: t.id, n: t.n, mov: t.mov, grupo: t.grupo, lado: t.lado, endpoint: t.endpoint, efeito: t.efeito, precisa: t.precisa, relacionada: t.relacionada ?? null,
    variantes: t.variantes ? Object.keys(t.variantes) : null, unico: t.unico ?? null, parcial: !!t.parcial, pagamento: t.pagamento ?? null, nota: t.nota ?? null,
  })),
  roteiros: ROTEIROS,
}));
rotas.get('/api/pocs', () => listarPocs());
rotas.post('/api/pocs', ({ corpo, quem }) => {
  const r = criarPoc(corpo ?? {}, quem!.usuario);
  auditar('poc.criar', `POC ${r.poc.nome} criada (CNPJ raiz ${r.poc.cnpjRaiz}, competência ${r.poc.competencia}); credenciais do IBS e da CBS emulados emitidas`, {
    alvoTipo: 'poc', alvoId: r.poc.id, detalhes: { competencia: r.poc.competencia, cnpjRaiz: r.poc.cnpjRaiz, clientIds: Object.fromEntries(r.credenciais.map((c) => [c.ente, c.clientId])) },
  });
  return criado(r);
});
rotas.get('/api/pocs/:id', ({ params }) => detalharPoc(params.id));
rotas.put('/api/pocs/:id', ({ params, corpo }) => {
  const antes = detalharPoc(params.id);
  const p = atualizarPoc(params.id, corpo ?? {});
  auditar('poc.alterar', `POC ${p.nome} alterada`, { alvoTipo: 'poc', alvoId: p.id, detalhes: mudancas(antes as never, p as never, ['eventos', 'eventosPorEnte', 'notas', 'ibs', 'cbs']) });
  return p;
});
rotas.delete('/api/pocs/:id', ({ params }) => {
  const r = removerPoc(params.id);
  auditar('poc.remover', `POC ${r.nome} apagada com ${r.notas} nota(s) do cliente, os eventos, os arquivos e os avisos`, { alvoTipo: 'poc', alvoId: params.id, detalhes: r });
}, SO_ROOT);
rotas.post('/api/pocs/:id/credencial-ibs', ({ params }) => {
  const c = novaCredencialIbs(params.id);
  auditar('poc.credencial', `Credencial nova do IBS emulado na POC ${obterPoc(params.id).nome}; a anterior deixou de valer`, { alvoTipo: 'poc', alvoId: params.id, detalhes: { clientId: c.clientId } });
  return c;
});
rotas.post('/api/pocs/:id/credencial-cbs', ({ params }) => {
  const c = novaCredencialCbs(params.id);
  auditar('poc.credencial', `Credencial nova da CBS emulada na POC ${obterPoc(params.id).nome}; a anterior e os tokens dela deixaram de valer`, { alvoTipo: 'poc', alvoId: params.id, detalhes: { ente: 'cbs', clientId: c.clientId } });
  return c;
});
// "Validar e salvar": a urlRetorno do aviso sem pedido passa pelo mesmo HEAD do pedido.
rotas.put('/api/pocs/:id/cbs/url-retorno', async ({ params, corpo }) => {
  const r = await cadastrarUrlRetorno(params.id, corpo?.urlRetorno);
  auditar('poc.cbs_url_retorno', r.urlRetorno ? `urlRetorno da CBS emulada validada e salva: ${r.urlRetorno}` : 'urlRetorno da CBS emulada removida; o aviso sem pedido para', {
    alvoTipo: 'poc', alvoId: params.id, detalhes: r,
  });
  return r;
});
// Uma collection por ente: ?ente=cbs dá a da Receita Federal emulada; sem ente, a do Comitê Gestor.
rotas.get('/api/pocs/:id/collection', ({ params, query }) => {
  const p = obterPoc(params.id);
  const ente = query.get('ente') === 'cbs' ? 'cbs' : 'ibs';
  const c = ente === 'cbs' ? colecaoCbs(detalharPoc(p.id).cbs.url, p.cbs_client_id, p.cnpj_raiz) : colecaoIbs(detalharPoc(p.id).ibs.url, p.ibs_client_id);
  return arquivo(JSON.stringify(c, null, 2), 'application/json; charset=utf-8', `massgen-${ente}-emulado-${p.nome.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.postman_collection.json`);
});

rotas.get('/api/pocs/:id/notas', ({ params, query }) => listarNotas(params.id, { busca: txt(query.get('busca')), papel: txt(query.get('papel')), situacao: txt(query.get('situacao')) }));
rotas.post('/api/pocs/:id/notas', ({ params, corpo, quem }) => {
  const r = importarNotas(params.id, corpo?.arquivos, quem!.usuario);
  auditar('poc.importar', `${r.aceitas} nota(s) aceita(s), ${r.fora} de fora, ${r.cancelamentos} cancelamento(s) e ${r.repetidas} repetida(s) na POC ${obterPoc(params.id).nome}`, {
    alvoTipo: 'poc', alvoId: params.id, detalhes: { aceitas: r.aceitas, fora: r.fora, cancelamentos: r.cancelamentos, repetidas: r.repetidas, ligadas: r.ligadas, arquivos: r.itens.length },
  });
  return criado(r);
});
rotas.get('/api/pocs/:id/notas/:nota', ({ params }) => detalharNota(params.id, params.nota));
rotas.get('/api/pocs/:id/notas/:nota/xml', ({ params }) => {
  const n = xmlDaNota(params.id, params.nota);
  auditar('poc.xml', `XML da nota ${n.chave} baixado`, { alvoTipo: 'poc', alvoId: params.id });
  return arquivo(n.xml, 'application/xml; charset=utf-8', `${n.chave}.xml`);
});

// Envio sob demanda (seção 09). "forçar" só para root (D-MG-13); executar fecha o dia na hora (D-MG-14).
const forcarPermitido = (forcar: unknown, papel?: string) => {
  if (forcar && papel !== 'root') throw new ErroHttp(403, 'Só root pode forçar a ordem e o saldo.');
  return !!forcar;
};
rotas.post('/api/pocs/:id/envios/previa', ({ params, corpo, quem }) => planejarEnvio(obterPoc(params.id), corpo?.notaIds, corpo?.tipos, forcarPermitido(corpo?.forcar, quem!.papel)));
rotas.post('/api/pocs/:id/envios', async ({ params, corpo, quem }) => {
  const poc = obterPoc(params.id);
  const forcar = forcarPermitido(corpo?.forcar, quem!.papel);
  const plano = planejarEnvio(poc, corpo?.notaIds, corpo?.tipos, forcar);
  const env = gravarEnvioManual(poc, plano, plano.itens.map((i) => i.id).filter((x, i, a) => a.indexOf(x) === i), (corpo?.notaIds ?? []).map(String), quem!.usuario);
  auditar('poc.envio', `Envio manual nº ${env.numero} na POC ${poc.nome}: ${env.ibs} evento(s) do IBS e ${env.cbs} da CBS no dia ${poc.dia}${forcar ? ', forçado' : ''}`, {
    alvoTipo: 'poc', alvoId: poc.id, detalhes: { numero: env.numero, eventos: env.eventos.length, ibs: env.ibs, cbs: env.cbs, bloqueios: plano.bloqueios.length, substituidos: env.substituidos, forcar, dia: poc.dia },
  });
  const fechamento = await fecharDia(poc.id);
  return criado({ envio: { id: env.id, numero: env.numero, substituidos: env.substituidos }, itens: plano.itens, bloqueios: plano.bloqueios, fechamento });
});
rotas.get('/api/pocs/:id/envios', ({ params }) => listarEnvios(params.id));
rotas.post('/api/pocs/:id/roteiros/previa', ({ params, corpo }) => {
  const r = planejarRoteiro(obterPoc(params.id), corpo?.notaIds, String(corpo?.roteiro ?? ''), corpo?.intervaloDias ?? 1);
  return { roteiro: r.roteiro.id, intervalo: r.intervalo, itens: r.itens, bloqueios: r.bloqueios };
});
rotas.post('/api/pocs/:id/roteiros', ({ params, corpo, quem }) => {
  const poc = obterPoc(params.id);
  const r = aplicarRoteiro(poc, corpo?.notaIds, String(corpo?.roteiro ?? ''), corpo?.intervaloDias, quem!.usuario);
  auditar('poc.roteiro', `${String(corpo?.roteiro)} aplicado a ${new Set(r.itens.map((i) => i.opId)).size} nota(s) da POC ${poc.nome}: ${r.itens.length} evento(s) planejado(s) até ${r.ultimoDia}`, {
    alvoTipo: 'poc', alvoId: poc.id, detalhes: { envio: r.envio.numero, roteiro: corpo?.roteiro, eventos: r.itens.length, bloqueios: r.bloqueios.length },
  });
  return criado(r);
});

rotas.post('/api/pocs/:id/relogio/fechar', async ({ params, corpo }) => {
  const antes = obterPoc(params.id).dia;
  const r = await fecharDia(params.id, txt(corpo?.ate ?? null));
  const tiquetes = r.cbs.flatMap((c) => c.tiquetes);
  auditar('poc.relogio', `Relógio da POC ${obterPoc(params.id).nome} foi de ${antes} a ${r.dia}: ${r.processados.length} Delta(s) do IBS e ${tiquetes.length} aviso(s) sem pedido da CBS`, {
    alvoTipo: 'poc', alvoId: params.id, detalhes: {
      de: antes, para: r.dia, deltas: r.processados.map((p) => ({ dia: p.dia, idSolic: p.idSolic, arquivos: p.arquivos.length, aviso: p.aviso?.resultado })),
      cbs: r.cbs.map((c) => ({ dia: c.dia, eventos: c.eventos, tiquetes: c.tiquetes.map((t, i) => ({ endpoint: t.endpoint, documentos: t.documentos, aviso: c.avisos[i]?.resultado })) })),
    },
  });
  return r;
});

rotas.get('/api/pocs/:id/barramento', ({ params }) => barramento(params.id));
rotas.get('/api/pocs/:id/arquivos/:arquivo', ({ params, query }) => {
  const a = obterArquivo(params.id, params.arquivo);
  if (query.get('baixar') === 'zip') return arquivo(zipDoArquivo(a.nome, a.conteudo, a.gerado_em), 'application/zip', a.nome);
  return { id: a.id, idArq: a.numero, nome: a.nome, hash: a.hash, tamanho: a.tamanho, geradoEm: a.gerado_em, conteudo: JSON.parse(a.conteudo) };
});
rotas.get('/api/pocs/:id/avisos/:aviso', ({ params }) => detalharAviso(params.id, params.aviso));
// "Reenviar aviso" repete o mesmo aviso e o mesmo arquivo, sem evento novo (T09). Na CBS, o mesmo tíquete e o mesmo link.
rotas.post('/api/pocs/:id/avisos/:aviso/reenviar', async ({ params }) => {
  const a = detalharAviso(params.id, params.aviso);
  const r = a.tiqueteId
    ? await avisarTiquete(params.id, a.tiqueteId as string, { reenvioDe: params.aviso })
    : await avisarSolicitacao(params.id, a.solicitacaoId as string, { reenvioDe: params.aviso });
  auditar('poc.aviso_reenviar', `Aviso ${params.aviso} reenviado ${a.tiqueteId ? 'à urlRetorno da CBS' : 'ao webhook do IBS'}: ${r.resultado}${r.status ? ` (${r.status})` : ''}`, {
    alvoTipo: 'poc', alvoId: params.id, detalhes: { ente: a.ente, ...r },
  });
  return r;
});
rotas.get('/api/pocs/:id/tiquetes/:tiquete', ({ params }) => detalharTiquete(params.id, params.tiquete));
rotas.get('/api/pocs/:id/tiquetes/:tiquete/arquivo', ({ params }) => {
  const t = obterTiquete(params.id, params.tiquete);
  if (!t.conteudo) throw new ErroHttp(409, 'O tíquete ainda não tem arquivo.');
  return arquivo(t.conteudo, 'application/json; charset=utf-8', `${t.endpoint}-${t.tiquete}.json`);
});
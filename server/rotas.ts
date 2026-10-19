// Rotas da API do app (/api/...). A interface usa só estas rotas.
// Toda ação que muda algo fica na trilha de auditoria: quem, quando, o quê e em quê. Segredos nunca entram.
import { Roteador, ErroHttp, arquivo, criado, exigir } from './http.ts';
import { config } from './config.ts';
import { todos, um } from './db.ts';
import { auditar, acoesAuditadas, listarAuditoria, usuarioAtual, verificarIntegridade } from './auditoria.ts';
import { catalogoGeradores } from './core/geradores.ts';
import { exportarPacote, instalarPacote, listarPacotes, removerPacote } from './servicos/pacotes.ts';
import {
  ACOES, SEGREDOS_POR_AUTH, aplicarImportacao, aplicarOperacoesDoPacote, atualizarDestino, atualizarOperacao, criarDestino, criarOperacao,
  definirSegredo, detalharDestino, divergencias, historicoImportacoes, listarDestinos, listarOperacoes, obterDestino, previaImportacao,
  removerDestino, removerOperacao,
} from './servicos/destinos.ts';
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

export const rotas = new Roteador();
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
rotas.get('/api/saude', () => ({ ok: true }));
rotas.get('/api/config', () => ({
  dominiosPermitidos: config.dominiosPermitidos, dominiosBloqueados: config.dominiosBloqueados, acoes: ACOES, segredosPorAutenticacao: SEGREDOS_POR_AUTH,
  usuario: usuarioAtual(),
}));
rotas.get('/api/catalogo/geradores', () => catalogoGeradores());
rotas.get('/api/painel', () => ({
  destinos: listarDestinos().map((d) => ({ id: d.id, nome: d.nome, tipoAmbiente: d.tipoAmbiente, baseUrl: d.baseUrl, ultimoTeste: d.ultimoTeste, ativo: d.ativo })),
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
rotas.post('/api/modelos/:id/exemplo', ({ params, corpo }) => exemplo(params.id, { definicao: corpo?.definicao, destinoId: corpo?.destinoId, semente: corpo?.semente }));

// ---------------------------------------------------------------- destinos e estrutura de APIs
rotas.get('/api/destinos', () => listarDestinos());
rotas.post('/api/destinos', ({ corpo }) => {
  const d = criarDestino(corpo ?? {});
  auditar('destino.criar', `Destino ${d.nome} criado (${d.tipoAmbiente}, ${d.baseUrl})`, { alvoTipo: 'destino', alvoId: d.id, detalhes: { baseUrl: d.baseUrl, autenticacao: d.autenticacao.tipo, pacote: d.pacoteId } });
  return criado(d);
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
rotas.post('/api/importacao/postman/aplicar', ({ corpo }) => {
  const r = aplicarImportacao(corpo?.colecao, corpo?.ambiente, {
    destinoId: txt(corpo?.destinoId), nome: corpo?.nome, tipoAmbiente: corpo?.tipoAmbiente, pacoteId: txt(corpo?.pacoteId), baseUrl: txt(corpo?.baseUrl),
  });
  auditar('importacao.postman', `Collection "${r.resumo.colecao}" importada: ${r.resumo.operacoes} operações, ${r.resumo.ligadas} ligadas a entidades`, { alvoTipo: 'destino', alvoId: r.destinoId, detalhes: r.resumo });
  return r;
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

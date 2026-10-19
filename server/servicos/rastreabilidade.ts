// Rastreabilidade de uma execução: o retrato do que gerou a massa, cada registro com o gabarito,
// cada requisição (mascarada, com hash e código de rastreio) e a trilha de auditoria.
import { agora, json, todos } from '../db.ts';
import { listarAuditoria, usuarioAtual, verificarIntegridade } from '../auditoria.ts';
import { linhaRegistro, obterExecucaoLinha, resumoExecucao } from './execucoes.ts';

export function trilhaDaExecucao(execucaoId: string) {
  obterExecucaoLinha(execucaoId);
  return listarAuditoria({ execucaoId, limite: 500 }).reverse();
}

export function pacoteDeEvidencias(execucaoId: string) {
  const resumo = resumoExecucao(execucaoId);
  const rastreios = new Map<string, string[]>();
  const requisicoes = todos<Record<string, unknown>>('SELECT * FROM requisicoes WHERE execucao_id = ? ORDER BY id', execucaoId).map((q) => {
    if (q.registro_id && q.rastreio) {
      const l = rastreios.get(q.registro_id as string) ?? [];
      l.push(q.rastreio as string);
      rastreios.set(q.registro_id as string, l);
    }
    return {
      id: q.id, rastreio: q.rastreio, fase: q.fase, registroId: q.registro_id, entidade: q.entidade, metodo: q.metodo, url: q.url,
      status: q.status, duracaoMs: q.duracao_ms, tentativa: q.tentativa, chaveIdempotencia: q.chave_idempotencia, codigoErro: q.codigo_erro,
      resultado: q.resultado, erro: q.erro, em: q.criado_em, usuario: q.usuario, corpoHash: q.corpo_hash, hashAnterior: q.hash_anterior, hash: q.hash,
      requisicao: { cabecalhos: json(q.req_cabecalhos, {}), corpo: json(q.req_corpo, q.req_corpo) },
      resposta: { cabecalhos: json(q.res_cabecalhos, {}), corpo: json(q.res_corpo, q.res_corpo) },
    };
  });
  const registros = todos('SELECT * FROM registros WHERE execucao_id = ? ORDER BY ordem, indice', execucaoId).map(linhaRegistro).map((r) => ({
    id: r.id, entidade: r.entidade, indice: r.indice, rotulo: r.rotulo, perfil: r.perfil, caso: r.caso, cadastroId: r.cadastroId,
    idRemoto: r.idRemoto, status: r.status, esperado: r.esperado, conferencia: r.conferencia, obtido: r.obtido, resultado: r.resultado,
    diferencas: r.diferencas, avisos: r.avisos, rastreios: rastreios.get(r.id) ?? [], dados: r.dados,
  }));
  return {
    documento: 'Pacote de evidências do MassGen',
    geradoEm: agora(),
    geradoPor: usuarioAtual().usuario,
    execucao: {
      codigo: resumo.codigo, cenario: resumo.cenarioNome, definicao: resumo.cenario, semente: resumo.semente, dataReferencia: resumo.dataReferencia,
      pacote: resumo.pacoteId, pacoteVersao: resumo.pacoteVersao, modelosHash: resumo.modelosHash, destino: resumo.destinoRetrato,
      criadoPor: resumo.criadoPor, criadoEm: resumo.criadoEm, enviadoPor: resumo.enviadoPor, iniciadoEm: resumo.iniciadoEm, finalizadoEm: resumo.finalizadoEm,
      status: resumo.status,
    },
    resultado: { total: resumo.total, ok: resumo.ok, divergentes: resumo.divergentes, bloqueados: resumo.bloqueados, erros: resumo.erros },
    integridade: verificarIntegridade(),
    trilha: trilhaDaExecucao(execucaoId),
    registros,
    requisicoes,
    comoVerificar: 'Cada requisição guarda o hash da anterior (hashAnterior) e o próprio (hash = sha256(hashAnterior | conteúdo)). corpoHash é o sha256 do corpo enviado. A verificação completa roda no app, em Auditoria > Verificar integridade.',
  };
}

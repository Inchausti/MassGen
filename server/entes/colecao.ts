// Collections dos entes emulados, para o time do SplitHub (D-MG-12), uma por ente: a do Comitê Gestor segue o MOC v1.10;
// a da Receita Federal, as APIs de Apuração da CBS v2. Mudam só a URL e a credencial; o que a documentação ainda não
// define e o emulador precisou decidir vai declarado na descrição. Sem scripts.
import { CATALOGO_IBS } from '../emulacao/catalogo.ts';
import { CATALOGO_CBS } from '../emulacao/catalogo-cbs.ts';
import { ERRO_408, JANELA_DIAS, LIMITE_POR_DIA, VALIDADE_HORAS } from '../emulacao/cbs.ts';
import { MANUAIS_POR_DIA } from './ibs.ts';

const url = (caminho: string) => ({ raw: `{{baseUrl}}${caminho}`, host: ['{{baseUrl}}'], path: caminho.split('/').filter(Boolean) });
const json = (o: unknown) => ({ mode: 'raw', raw: JSON.stringify(o, null, 2), options: { raw: { language: 'json' } } });
const credenciais = [{ key: 'clientid', value: '{{clientId}}' }, { key: 'clientsecret', value: '{{clientSecret}}' }];

const PROVISORIOS = [
  'Rota do Obter Arquivo: o MOC não define. O MassGen usa GET /v1/aassist/arquivo/{nomeArq} (ou o idArq no lugar do nome).',
  'Formato: o arquivo vem em ZIP, como os nomes do exemplo do webhook; dentro, um JSON com o header do Anexo I.',
  'Hash do extrato_cc (Pendência 1 do MOC): SHA-1 do hash anterior concatenado ao JSON da linha, lançamento a lançamento.',
  'MOV (Pendência 2 do MOC): texto da movimentação, exato como nos exemplos do Anexo II.',
  'Datas do Processamento Diário: o arquivo do dia D sai às 01:30 de D+1, com validade de 90 dias.',
  'Nova Solicitação (Arquivo Manual): GET com corpo, como o MOC; quem não consegue mandar corpo num GET pode mandar os mesmos campos na query. Datas AAAA-MM-DD.',
  `Regras do Arquivo Manual: ${MANUAIS_POR_DIA} por dia e ${MANUAIS_POR_DIA} por competência no mesmo dia (a POC pode relaxar), período numa única competência, sem sobreposição com outra manual ativa e só até o dia simulado. Sai no Processamento Diário seguinte, com o mesmo formato do Delta e tiposolicitacao "solicitação manual"; período sem lançamento gera um arquivo vazio.`,
  'Recusas da Nova Solicitação, que o MOC não codifica: 400 (dados), 409 (sobreposição) e 429 (limite do dia). Cancelamento: 404 (não existe) e 409 (já processada ou não é manual). O corpo segue { resultado, mensagem }.',
  'Validade da solicitação manual: vazia enquanto SOLICITADA; 90 dias a partir da geração.',
  'Casos de transporte e falha da POC (ligados um a um na tela): T05 fatia uma operação em dois arquivos do Delta; T06 pula o Delta de um dia; T07 tira uma linha do Delta e mantém o hash acumulado com ela; T09 descarta o primeiro 2xx do próximo aviso e repete o mesmo aviso.',
  'Documentos: NF-e, NFC-e, CT-e e NFS-e abrem operação. O Anexo I não traz o modelo; no CT-e e na NFS-e, o CNPJ_ADQUIRENTE é o do tomador. Sem CNPJ do adquirente (NFC-e ao consumidor, tomador pessoa física), o campo não vem, como o Anexo I permite (0-1).',
  'CHAVE_ACESSO da NFS-e: o Anexo I dá C(44), e a chave da NFS-e do padrão nacional tem 50 dígitos. A NFS-e está no piloto desde a Etapa 2 (jun/2026); o MassGen manda a chave inteira, como a CBS (string(50)).',
  ...CATALOGO_IBS.filter((t) => t.nota).map((t) => `${t.id} (${t.mov}): ${t.nota}`),
];

export function colecaoIbs(baseUrl: string, clientId: string | null) {
  return {
    info: {
      name: 'MassGen · Comitê Gestor emulado (IBS)',
      description: [
        'API de Integração com a Apuração Assistida do IBS (MOC v1.10), servida pelo MassGen para a POC.',
        'Troque baseUrl e a credencial para usar a mesma collection contra o Comitê Gestor.',
        '', 'Decisões do emulador onde o MOC ainda não define:', ...PROVISORIOS.map((p) => `- ${p}`),
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: baseUrl },
      { key: 'clientId', value: clientId ?? '' },
      { key: 'clientSecret', value: '', description: 'Mostrado uma vez, ao criar a POC ou gerar uma credencial nova.' },
      { key: 'webhookUrl', value: 'https://splithub.exemplo/webhook/ibs' },
      { key: 'tokenContrib', value: '' },
      { key: 'nomeArq', value: '' },
      { key: 'dataIni', value: '' },
      { key: 'dataFim', value: '' },
      { key: 'cnpj', value: '' },
      { key: 'idSolic', value: '' },
    ],
    item: [
      {
        name: '5.1 Habilitação do Contribuinte',
        request: {
          method: 'POST', header: [...credenciais, { key: 'Content-Type', value: 'application/json' }],
          body: json({ queroHabilitar: 'HAB', webhookUrl: '{{webhookUrl}}', tokenContrib: '{{tokenContrib}}' }), url: url('/v1/aassist/habilitar'),
          description: 'Registra a webhookUrl (HTTPS) e o tokenContrib, que volta no cabeçalho de cada notificação.',
        },
      },
      {
        name: '5.3 Obter Arquivo',
        request: { method: 'GET', header: credenciais, url: url('/v1/aassist/arquivo/{{nomeArq}}'), description: 'Rota provisória do emulador. Baixar o arquivo é a prova de recebimento na POC.' },
      },
      {
        name: '5.4 Listagem de Solicitações de Arquivos',
        request: { method: 'GET', header: credenciais, url: url('/v1/aassist/solicitacao/listar/{{dataIni}}&{{dataFim}}&todas'), description: 'Datas AAAA-MM-DD; situação solicitada, gerada, enviada, cancelada, expirada ou todas.' },
      },
      {
        name: '5.5 Nova Solicitação (Arquivo Manual)',
        request: {
          method: 'GET', header: [...credenciais, { key: 'Content-Type', value: 'application/json' }],
          body: json({ cnpj: '{{cnpj}}', dataTransacaoIni: '{{dataIni}}', dataTransacaoFim: '{{dataFim}}' }), url: url('/v1/aassist/solicitacao/incluir'),
          description: 'Pede os lançamentos de um período (uma competência). A solicitação nasce SOLICITADA e o arquivo sai no próximo Processamento Diário, avisado no webhook como MANUAL.',
        },
      },
      {
        name: '5.6 Cancelamento de Solicitação',
        request: { method: 'DELETE', header: credenciais, url: url('/v1/aassist/solicitacao/cancelamento/{{idSolic}}'), description: 'Só a solicitação manual ainda SOLICITADA pode ser cancelada.' },
      },
      {
        name: '5.2 Notificação de Disponibilização (o MassGen chama o SplitHub)',
        request: {
          method: 'POST', header: [{ key: 'tokenContrib', value: '{{tokenContrib}}' }, { key: 'Content-Type', value: 'application/json' }],
          body: json({
            tipoSolic: 'DIFERENCIAL', sitSolic: 'GERADA', cnpj: '12345678000190', idSolic: 9001, dataHoraSolic: '2026-11-15T01:30:00Z',
            dataHoraTransIni: '2026-11-14T00:00:00Z', dataHoraTransFim: '2026-11-14T23:59:59.999Z', qtdOperSolic: 2, qtdArqVincul: 1,
            dataValidSolic: '2027-02-13T01:30:00Z', arquivos: [{ idArq: 1001, nomeArq: 'aassist_2026-11_14_detalhada_1001_parte001.zip' }],
          }),
          url: { raw: '{{webhookUrl}}', host: ['{{webhookUrl}}'] },
          description: 'Exemplo do que o webhook do SplitHub recebe depois de cada Processamento Diário. Serve para testar o endpoint do SplitHub.',
        },
      },
    ],
  };
}

// ---------------------------------------------------------------- Receita Federal emulada (CBS)

const PROVISORIOS_CBS = [
  `Aviso sem pedido (D-MG-03): a cada dia fechado no relógio da POC, um tíquete por endpoint que mudou, avisado na urlRetorno validada na tela da POC. A documentação só prevê o aviso do pedido.`,
  'Códigos de erro que a documentação não traz: APURACAO-401 (token ausente ou vencido), APURACAO-404 (endpoint, tíquete ou link inexistente), APURACAO-410 (link vencido) e APURACAO-429 (limite diário). APURACAO-001 segue a documentação.',
  `Limite: ${LIMITE_POR_DIA} solicitações por dia simulado em cada endpoint; a POC pode relaxar o limite.`,
  `Janela: ${JANELA_DIAS} dias até o pedido, ou desde o dia 1 do mês na primeira coleta do endpoint. O documento entra pelo atualizacao, a última mudança dele.`,
  `Link assinado: GET /download/v2/{assinatura}, sem token, válido por ${VALIDADE_HORAS} horas no relógio da POC. O reenvio do aviso repete o mesmo link. Baixar é a prova de recebimento.`,
  'Atendimento do pedido: PENDENTE, EM_PROCESSAMENTO e CONCLUIDA em menos de um segundo; tEASegundos "1". A documentação admite até 240 minutos.',
  `Aviso de erro: o corpo é o da documentação, { codigoErro, mensagemErro } (por exemplo ${ERRO_408.codigo}), sem o tíquete. Para saber qual pedido falhou, use uma urlRetorno por pedido (um identificador na query serve) ou consulte /situacao/{tiquete}.`,
  'Casos de transporte e falha da POC (ligados um a um na tela): T02 conclui o próximo pedido com o link já vencido (o download responde 410); T03 termina o próximo pedido em ERRO APURACAO-408; T09 descarta o primeiro 2xx do próximo aviso e repete o mesmo aviso.',
  'Horários: os eventos de um dia fechado entram com o atualizacao a partir das 10:00 desse dia; o arquivo do aviso sem pedido sai às 23:00.',
  'tipo do pagamento: 1 PCONT, 2 RAD e 3 split. A enumeração não foi publicada.',
  'Pagamento em atraso: multa de 10% e juros de 1% do principal, arredondados ao real, só para ilustrar.',
  'numeroDARF: o formato do exemplo da documentação, com o ano, o dia do ano e a ordem do evento.',
  'Recolhimento: vencimento no último dia do mês seguinte ao período de apuração.',
  'documento (A.9): NF-e 55, NFC-e 65 e CT-e 57, como a tabela. A NFS-e não tem modelo no leiaute: vai 91, e não 92 (NFS-e Via), que a documentação não explica. A chave da NFS-e tem 50 dígitos e cabe no string(50).',
  ...CATALOGO_CBS.filter((t) => t.nota).map((t) => `${t.id} (${t.mov}): ${t.nota}`),
];

const bearer = [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }];
const ENDPOINTS_CBS: [string, string][] = [
  ['debitos', 'Débitos'], ['creditos', 'Créditos'], ['pagamentos', 'Pagamentos'], ['recolhimentos', 'Recolhimentos'],
];

export function colecaoCbs(baseUrl: string, clientId: string | null, cnpj8: string) {
  return {
    info: {
      name: 'MassGen · Receita Federal emulada (CBS)',
      description: [
        'APIs de Apuração da CBS v2, servidas pelo MassGen para a POC: token OAuth 2.0, as quatro solicitações, a situação do tíquete e o link assinado.',
        'Troque baseUrl e a credencial para usar a mesma collection contra a Receita Federal.',
        '', 'Decisões do emulador onde a documentação ainda não define:', ...PROVISORIOS_CBS.map((p) => `- ${p}`),
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: baseUrl },
      { key: 'clientId', value: clientId ?? '' },
      { key: 'clientSecret', value: '', description: 'Mostrado uma vez, ao criar a POC ou gerar uma credencial nova.' },
      { key: 'accessToken', value: '', description: 'O access_token do /token; vale 3.600 segundos.' },
      { key: 'cnpj8', value: cnpj8 },
      { key: 'urlRetorno', value: 'https://splithub.exemplo/retorno/cbs' },
      { key: 'tiquete', value: '' },
      { key: 'urlAssinada', value: '' },
    ],
    item: [
      {
        name: 'Token (client credentials)',
        request: {
          method: 'POST', header: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
          body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'client_id', value: '{{clientId}}' }, { key: 'client_secret', value: '{{clientSecret}}' }] },
          url: url('/token'),
          description: 'Também aceita a credencial no cabeçalho Authorization: Basic. Copie o access_token para a variável accessToken.',
        },
      },
      ...ENDPOINTS_CBS.map(([endpoint, nome]) => ({
        name: `Solicitar ${nome}`,
        request: {
          method: 'POST', header: [...bearer, { key: 'Content-Type', value: 'application/json' }], body: json({ urlRetorno: '{{urlRetorno}}' }),
          url: url(`/apuracao-cbs/v2/${endpoint}/{{cnpj8}}`),
          description: 'A Receita Federal emulada faz um HEAD na urlRetorno antes de aceitar; sem 2xx, responde 400 APURACAO-001. Aceito, devolve 201 com o tiqueteSolicitacao e avisa a urlRetorno quando o arquivo fica pronto.',
        },
      })),
      {
        name: 'Situação da solicitação',
        request: { method: 'GET', header: bearer, url: url('/apuracao-cbs/v2/situacao/{{tiquete}}'), description: 'PENDENTE, EM_PROCESSAMENTO, CONCLUIDA (com urlAssinada e urlAssinadaExpiraEm) ou ERRO (com codigoErro e mensagemErro).' },
      },
      {
        name: 'Baixar o arquivo (link assinado)',
        request: { method: 'GET', header: [], url: { raw: '{{urlAssinada}}', host: ['{{urlAssinada}}'] }, description: 'Sem token. Baixar é a prova de recebimento na POC.' },
      },
      {
        name: 'Aviso na urlRetorno (o MassGen chama o SplitHub)',
        request: {
          method: 'POST', header: [{ key: 'Content-Type', value: 'application/json' }],
          body: json({ tiqueteSolicitacao: '00000000-0000-4000-8000-000000000000', urlAssinada: `${baseUrl}/download/v2/exemplo`, urlAssinadaExpiraEm: '2026-11-17T02:00:00Z' }),
          url: { raw: '{{urlRetorno}}', host: ['{{urlRetorno}}'] },
          description: 'Exemplo do que a urlRetorno recebe quando o arquivo fica pronto, do pedido ou do aviso sem pedido. Com falha, o corpo traz codigoErro e mensagemErro.',
        },
      },
    ],
  };
}

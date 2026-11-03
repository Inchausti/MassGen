// Collection do Comitê Gestor emulado, para o time do SplitHub (D-MG-12). É a do MOC v1.10 com a URL do MassGen;
// o que o MOC ainda não define e o emulador precisou decidir vai declarado na descrição. Sem scripts.
import { CATALOGO_IBS } from '../emulacao/catalogo.ts';

const url = (caminho: string) => ({ raw: `{{baseUrl}}${caminho}`, host: ['{{baseUrl}}'], path: caminho.split('/').filter(Boolean) });
const json = (o: unknown) => ({ mode: 'raw', raw: JSON.stringify(o, null, 2), options: { raw: { language: 'json' } } });
const credenciais = [{ key: 'clientid', value: '{{clientId}}' }, { key: 'clientsecret', value: '{{clientSecret}}' }];

const PROVISORIOS = [
  'Rota do Obter Arquivo: o MOC não define. O MassGen usa GET /v1/aassist/arquivo/{nomeArq} (ou o idArq no lugar do nome).',
  'Formato: o arquivo vem em ZIP, como os nomes do exemplo do webhook; dentro, um JSON com o header do Anexo I.',
  'Hash do extrato_cc (Pendência 1 do MOC): SHA-1 do hash anterior concatenado ao JSON da linha, lançamento a lançamento.',
  'MOV (Pendência 2 do MOC): texto da movimentação, exato como nos exemplos do Anexo II.',
  'Datas do Processamento Diário: o arquivo do dia D sai às 01:30 de D+1, com validade de 90 dias.',
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

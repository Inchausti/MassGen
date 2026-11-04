# MassGen

Emulador da **apuração assistida** da CBS e do IBS para as POCs do SplitHub (proposta v4.3). As notas do cliente entram no SplitHub da POC e no MassGen. O MassGen faz o papel dos entes diante do SplitHub: monta o barramento de cada nota pela documentação deles, avisa o webhook e serve os arquivos, com o histórico de cada nota. Nada chama a Receita Federal, o Comitê Gestor ou o SplitHub de produção.

Os dois entes estão prontos: o **Comitê Gestor emulado (IBS)**, pelo MOC v1.10, e a **Receita Federal emulada (CBS)**, pelas APIs de Apuração da CBS v2. Por cima deles, o **plano e o painel de cobertura** fecham os 59 tipos com um lote só: os 24 do IBS, os 26 da CBS e os 9 casos de transporte e falha. Veja [POC da apuração assistida](#poc-da-apuração-assistida).

O gerador de massa genérico das versões anteriores continua no app, fora do menu (D-MG-01): veja [Gerador genérico](#gerador-genérico-fora-do-menu).

Roda na sua máquina, sem infraestrutura: um servidor Node e um banco SQLite num arquivo. Para o time usar junto, o mesmo app roda numa VM: veja [Hospedar para o time](#hospedar-para-o-time).

## Como rodar

Precisa do **Node.js 24 ou mais novo**. Nada mais: o banco é o SQLite embutido no Node, e o TypeScript roda sem compilação.

```bash
npm install
cp .env.example .env
```

No `.env`, ponha o seu e-mail em `MASSGEN_ROOTS`. Depois:

```bash
npm start
```

O `npm start` compila a interface e sobe o servidor. O terminal mostra a linha `Primeiro acesso de <seu e-mail>: http://localhost:3000/convite/...`. Abra o link, defina o nome e a senha, e o app abre. Veja [Usuários e acesso](#usuários-e-acesso).

### Testar sem sandbox

Uma API falsa, com as regras do SplitHub, roda junto:

```bash
npm run mock
```

Ela fica em http://localhost:8089, com `client_id` **massgen** e `client_secret` **massgen-segredo**. O comprador cadastrado é o CNPJ **11222333000181**. Crie um destino com o pacote SplitHub apontando para ela e rode o cenário C-01.

## POC da apuração assistida

Cada POC é um cliente e uma competência. O caminho, pelo menu **POCs**:

1. **Nova POC:** nome, CNPJ do cliente (aceita o alfanumérico) e competência. O app mostra **uma vez** as duas credenciais:
   - a do Comitê Gestor emulado: a URL base (`<MASSGEN_URL_PUBLICA>/entes/ibs`), o `clientid` e o `clientsecret`;
   - a da Receita Federal emulada: a URL base (`<MASSGEN_URL_PUBLICA>/entes/cbs`), o `client_id` e o `client_secret`.

   Elas vão para o cofre do SplitHub da POC; o MassGen guarda só o hash. Perdeu uma? *Barramento › Gerar credencial nova* no painel do ente (a anterior para de valer na hora).
2. **Notas:** importe os mesmos XMLs que o SplitHub da POC importou, soltos ou num ZIP, até 18 MB por vez. Entram NF-e autorizadas de produção com o grupo de IBS e CBS (D-MG-10); o resto fica de fora, com o motivo. O CNPJ raiz diz se a nota é de entrada ou de saída. O XML de cancelamento marca a nota; a complementar e a de devolução se ligam à original. Na CBS, cada nota é um documento.
3. **Habilitação (IBS):** o SplitHub da POC chama `POST /entes/ibs/v1/aassist/habilitar` com a credencial, a `webhookUrl` (HTTPS; `http` só em `localhost`) e o `tokenContrib`, como faria com o Comitê Gestor. A `webhookUrl` passa pela trava de domínios (`ALLOWED_DESTINATION_DOMAINS`).
4. **Pedido (CBS):** a CBS não tem habilitação. O SplitHub pega o token em `POST /entes/cbs/token` e pede cada endpoint (débitos, créditos, pagamentos, recolhimentos) com a `urlRetorno`, como faria com a Receita Federal. A `urlRetorno` passa pela mesma trava e pelo `HEAD`, que precisa de 2xx. A resposta é o tíquete; o MassGen atende, avisa a `urlRetorno` com o link assinado, e o SplitHub baixa o JSON por ele. Veja as [rotas](#rotas-da-receita-federal-emulada-cbs).
5. **Roteiros:** marque notas e *Aplicar roteiro* (RT-A1 a RT-A9, RT-F1 a RT-F8). Os roteiros com IBS e CBS soltam os eventos dos dois entes nos mesmos dias, a menos que haja **defasagem**: com +2, a CBS começa dois dias depois do IBS; com −2, dois dias antes. O padrão fica em *Configuração › Defasagem da CBS* (de −30 a 30), e o roteiro e o plano aceitam outro valor. RT-A7, RT-A8, RT-A9 e RT-F8 são só da CBS. A prévia mostra cada evento no dia em que vai sair, com o ente. Os eventos ficam *planejados*.
6. **Cobertura:** a aba mostra **quantos dos tipos o SplitHub já recebeu** (por exemplo, *16 de 59 tipos recebidos*), com uma tabela por ente (IBS, CBS) e outra dos casos de transporte e falha. Cada tipo traz as notas no plano, quantas foram avisadas e recebidas, e a situação: *coberto*, *não baixado*, *não recebido*, *disponível*, *planejado* (com o dia) ou o XML que falta. O tipo só conta quando o SplitHub baixa um arquivo com ele.
   - ***Montar plano*** dá a cada nota livre o roteiro que cobre o que ainda falta (D-MG-04): as notas com cancelamento, complementar ou devolução vão antes, porque só elas abrem certos tipos; a nota que não acrescenta tipo novo segue o caminho feliz (RT-A1 ou RT-F1). A prévia roda o plano e desfaz, então mostra exatamente o que o botão grava: os envios, as notas e o que cada uma acrescenta. ***Refazer plano*** libera antes as notas que só têm eventos planejados por roteiro.
   - **O que o lote não cobre** vem numa frase por XML (D-MG-05), como *Para cobrir E-IBS-19 e E-IBS-20, o lote precisa de uma NF-e de devolução de uma nota de entrada.* O MassGen nunca inventa uma nota.
7. **Casos de transporte e falha (T01 a T09):** na aba *Cobertura › Transporte e falha*, cada caso começa desligado. Ligar põe o caso na meta; com os nove ligados, a meta é 59. O que o SplitHub precisa fazer e o que fecha cada caso estão na tabela.
   - **O MassGen provoca, uma vez, na próxima oportunidade:** T02 (o pedido da CBS conclui com o link vencido; o download responde 410), T03 (o pedido da CBS termina em `ERRO APURACAO-408`, e o aviso leva o erro), T05 (uma operação do Delta sai em dois arquivos), T06 (um dia com lançamentos no IBS fica sem Delta e sem aviso), T07 (a primeira linha do dia some do Delta e o hash continua contando com ela) e T09 (a primeira resposta 2xx do aviso é descartada e o mesmo aviso se repete, em cada ente). *Provocar de novo* arma o caso outra vez.
   - **Nascem do uso:** T01 (o documento da CBS que muda em dois dias volta em dois tíquetes), T04 (o Arquivo Manual de um período já entregue repete os lançamentos do Delta) e T08 (abaixo).
   - *Barramento › Casos provocados pelo MassGen* lista onde cada provocação caiu.
8. **Nota fora do SplitHub (T08):** na aba *Notas*, marque as notas que o SplitHub não importou e use *Fora do SplitHub*. Elas não saem por roteiro nem por envio, a menos que você marque **Incluir não importadas**. O plano só as usa com o T08 ligado.
9. **Enviar eventos (sob demanda):** escolha as notas e os tipos, agrupados por ente: E-IBS-01 a E-IBS-24 e os 26 da CBS (E-CBS-D01 a D07, C01 a C12, P01 a P04, R01 a R03), com o percentual nos parciais. O que falta antes entra sozinho como pré-requisito (D-MG-13); a prévia mostra o que entra e o que não cabe, com o motivo. *Executar e enviar* fecha o dia simulado na hora (D-MG-14). Só root pode **forçar** (ignorar ordem, unicidade, saldo e data) para testar a reação do SplitHub.
10. **Relógio:** *Fechar o dia* processa os dois entes. No IBS, gera o Delta com os eventos planejados, gera o Arquivo Manual que o SplitHub pediu e avisa o webhook. Na CBS, com a `urlRetorno` validada, abre um tíquete por endpoint que mudou e avisa sem pedido (D-MG-03); sem ela, os eventos esperam o pedido. Depois passa ao dia seguinte. *Fechar até* faz isso dia a dia até a data. O relógio não volta. Embaixo do dia, o próximo dia com evento planejado em cada ente.

   > **Fechar vários dias de uma vez pode deixar um link vencer.** O link da CBS vale 48 horas no relógio da POC. Se o *Fechar até* passa dessas 48 horas antes de o SplitHub baixar, o link dos primeiros dias vence e os eventos ficam *não recebido*. É a regra, e vale testar. Para a POC andar sem isso, feche um dia por vez enquanto o SplitHub baixa. O que venceu volta por pedido.

   **Avanço automático (D-MG-07):** em *Configuração › Relógio automático*, o relógio anda sozinho, um dia simulado a cada intervalo.
   - **Ligar:** escolha o intervalo, em minutos reais por dia simulado (de 1 minuto a 24 horas), e a data de parada. A data de parada já vem com o último dia da competência; vazia, o relógio não para. O primeiro passo sai depois de um intervalo inteiro. Com 5 minutos, uma competência de 30 dias anda em duas horas e meia.
   - **Cada passo é o *Fechar o dia*,** nos dois entes: o Delta e o Arquivo Manual do IBS, as fotos e o aviso sem pedido da CBS. Entram a defasagem da CBS e os casos ligados.
   - **Um dia por passo:** o SplitHub tem o intervalo inteiro para baixar antes de o relógio andar de novo, e o link de 48 horas não vence no caminho.
   - **Pausar e retomar,** no relógio do cabeçalho ou na Configuração. Pausar no meio de um passo deixa o dia dele fechar inteiro, com os avisos; o seguinte não sai. Retomar volta a contar o intervalo desde o clique. Depois do dia de parada, o relógio pausa sozinho e diz por quê.
   - **Comando conta como passo:** se você fecha o dia na mão (*Fechar o dia*, *Fechar até*, *Executar e enviar*), o passo seguinte não fecha de novo o mesmo dia. Ele espera um intervalo inteiro e fecha o dia em que o relógio está.
   - **Reinício do servidor:** o relógio volta sozinho, assim que o app está no ar. O passo que venceu com o servidor fora sai uma vez só; os intervalos perdidos não viram vários dias de uma vez. Se o servidor caiu logo depois de fechar um dia, esse dia não fecha de novo.
   - **Tela:** o cabeçalho mostra o estado e o próximo passo, com a hora, a contagem e o dia que ele fecha. Enquanto o relógio roda, a página se atualiza sozinha.
   - **Trilha:** registra quem ligou, pausou, retomou e mudou o intervalo. Cada passo entra como *relógio automático (ligado por …)*.
   - **Intervalo mínimo:** 1 minuto. `MASSGEN_RELOGIO_MIN_SEG` muda esse mínimo; os testes usam 1 segundo.
11. **Barramento:** um painel por ente.
   - **IBS:** a credencial, a habilitação, e as solicitações com os arquivos (o JSON do Anexo I e o ZIP). Cada solicitação diz se é Delta ou Arquivo Manual (com o período) e qual caso foi provocado nela.
   - **Arquivo Manual:** o SplitHub pede em `GET /v1/aassist/solicitacao/incluir`, com `cnpj`, `dataTransacaoIni` e `dataTransacaoFim`, e cancela em `DELETE /v1/aassist/solicitacao/cancelamento/{idSolic}` enquanto a solicitação está *SOLICITADA*. Veja as [regras](#decisões-do-emulador-onde-o-moc-ainda-não-define-ibs).
   - **CBS:** a credencial, a `urlRetorno` do aviso sem pedido (*Validar e salvar* faz o mesmo `HEAD` do pedido; *Desligar* volta a só pedido), e os tíquetes. Cada tíquete traz a origem (pedido ou sem pedido), a janela, o estado, o link com a validade e os downloads, e o JSON.
   - **Nos dois:** os avisos com cada tentativa e o *Reenviar aviso* (na CBS, o mesmo tíquete e o mesmo link), e as chamadas que o SplitHub fez, com o ente. *Baixar a collection* entrega a collection do Postman de cada ente com a URL e o client id da POC, sem segredo e sem scripts (D-MG-12).

   O link assinado e os segredos aparecem mascarados em todo lugar.
12. **Histórico da nota:** os eventos dos dois entes na ordem dos dias. Cada evento traz a origem (roteiro, envio, pré-requisito), a situação (*planejado, disponível, avisado, recebido, não recebido, substituído*), o efeito nos campos, o aviso e os downloads.
   - **Trocar roteiro (D-MG-04):** qualquer nota troca de roteiro. Os eventos planejados viram *substituídos* e o roteiro novo entra no lugar. Se a nota já tem história, o roteiro novo continua dela: o passo que já aconteceu ou que não tem mais saldo fica de fora, e a prévia diz qual.
   - **IBS:** o efeito nos sete campos do extrato e a linha que saiu no arquivo. Quando o mesmo lançamento veio no Delta e num Arquivo Manual (T04, T06, T07), a gaveta do evento lista todos os arquivos.
   - **CBS:** a foto do documento como ficou depois do evento e os tíquetes que a levaram. Os saldos da foto vêm com os calculados do lado do documento: saldo devedor no débito; a apropriar e saldo credor no crédito.

   O download pelo SplitHub é a prova de recebimento, nos dois entes.
13. **Fim da POC:** *Configuração › Apagar a POC* (só root) leva as notas do cliente, os eventos, os arquivos, os tíquetes e os avisos. A trilha de auditoria fica. Os XMLs do cliente nunca vão para o Git.

### Rotas da Receita Federal emulada (CBS)

Em `<MASSGEN_URL_PUBLICA>/entes/cbs`:

| Rota | O que faz |
|---|---|
| `POST /token` | OAuth 2.0, *client credentials*, no formulário ou em Basic. O `access_token` vale 3.600 segundos. |
| `POST /apuracao-cbs/v2/{endpoint}/{cnpj8}` | Pede `debitos`, `creditos`, `pagamentos` ou `recolhimentos` do CNPJ base da POC, com `{ "urlRetorno": ... }`. Responde 201 com `tiqueteSolicitacao` e `tEASegundos`. |
| `GET /apuracao-cbs/v2/situacao/{tiquete}` | `PENDENTE`, `EM_PROCESSAMENTO`, `CONCLUIDA` ou `ERRO`; concluído, traz o link e a validade. |
| `GET /download/v2/{assinatura}` | O link assinado, sem token. Baixar é a prova de recebimento. |
| `POST <urlRetorno>` | O MassGen avisa o SplitHub com o tíquete, o link e a validade. |

### Decisões do emulador onde o MOC ainda não define (IBS)

Ficam declaradas na collection e valem até o Comitê Gestor publicar:

- **Obter Arquivo:** `GET /v1/aassist/arquivo/{nomeArq}` (ou o `idArq`). O arquivo vem em ZIP, com o JSON do Anexo I dentro.
- **Hash do `extrato_cc`:** SHA-1 do hash anterior concatenado ao JSON da linha, lançamento a lançamento. Na operação fatiada, o cabeçalho se repete e o hash segue acumulado.
- **Processamento Diário:** o arquivo do dia D sai às 01:30 de D+1, com validade de 90 dias; vencido sem download, a solicitação expira e o evento fica *não recebido*.
- **MOV:** o texto exato dos exemplos do Anexo II. As leituras nossas de base de valor (E-IBS-07, 16, 18, 20, 22 e 24) aparecem na tela de envio e na collection.
- **Nova Solicitação (Arquivo Manual):** um `GET` com corpo, como o MOC; quem não consegue mandar corpo num `GET` pode mandar os mesmos campos na query. Datas no formato AAAA-MM-DD.
- **Regras do Arquivo Manual:** 2 por dia e 2 por competência no mesmo dia (*Configuração › Limites relaxados* tira o limite); o período fica numa competência só, não passa do dia simulado e não se sobrepõe a outra manual ativa (a cancelada não conta). Sai no Processamento Diário seguinte, no mesmo formato do Delta, com `tiposolicitacao` "solicitação manual"; um período sem lançamento gera um arquivo vazio. A validade fica vazia enquanto a solicitação está *SOLICITADA* e vai a 90 dias na geração.
- **Recusas que o MOC não codifica:** na Nova Solicitação, 400 (dados), 409 (sobreposição) e 429 (limite do dia); no Cancelamento, 404 (não existe) e 409 (já processada ou não é manual). O corpo segue `{ resultado, mensagem }`.

### Decisões do emulador onde a documentação da CBS ainda não define

Ficam declaradas na collection da CBS e valem até a Receita Federal publicar:

- **Aviso sem pedido (D-MG-03):** a documentação só prevê o aviso do pedido. Aqui, cada dia fechado abre um tíquete por endpoint que mudou, com os eventos desse dia, e avisa a `urlRetorno` validada na tela da POC. O arquivo sai às 23:00 do dia.
- **Códigos de erro:** `APURACAO-001` segue a documentação. Os outros são nossos: `APURACAO-401` (token ausente ou vencido), `APURACAO-404` (endpoint, tíquete ou link inexistente), `APURACAO-410` (link vencido) e `APURACAO-429` (limite diário).
- **Limite:** 4 pedidos por dia simulado em cada endpoint. *Configuração › Limites relaxados* tira o limite.
- **Janela do pedido:** 8 dias até o pedido, ou desde o dia 1 do mês na primeira coleta do endpoint. O documento entra pelo `atualizacao`, a última mudança dele, com a foto inteira.
- **Link assinado:** `GET /download/v2/{assinatura}`, sem token, válido por 48 horas no relógio da POC. O reenvio do aviso repete o mesmo link. Vencido sem download, os eventos que nenhum outro tíquete levou ficam *não recebido*.
- **Atendimento:** `PENDENTE`, `EM_PROCESSAMENTO` e `CONCLUIDA` em menos de um segundo, com `tEASegundos` "1". A documentação admite até 240 minutos.
- **Aviso de erro:** o corpo é o da documentação, `{ codigoErro, mensagemErro }` (por exemplo `APURACAO-408`, no T03), sem o tíquete. Para saber qual pedido falhou, o SplitHub usa uma `urlRetorno` por pedido (um identificador na query serve) ou consulta `/situacao/{tiquete}`.
- **Horários:** os eventos de um dia fechado entram com o `atualizacao` a partir das 10:00 desse dia.
- **Tipo do pagamento:** 1 PCONT, 2 RAD e 3 split. A enumeração não foi publicada.
- **Pagamento em atraso:** multa de 10% e juros de 1% do principal, só para ilustrar.
- **`numeroDARF`:** o formato do exemplo da documentação, com o ano, o dia do ano e a ordem do evento.
- **Recolhimento:** vencimento no último dia do mês seguinte ao período de apuração.
- **Leituras nossas por tipo:** aparecem na tela de envio e na collection.

## Gerador genérico (fora do menu)

As telas do gerador de massa (*Pacotes, Modelos, Cadastros, Cenários* e *Execuções*) saíram do menu na v4 (D-MG-01), mas as rotas continuam: `/pacotes`, `/modelos`, `/cadastros`, `/cenarios` e `/execucoes`. O núcleo não conhece nenhum domínio: entidades, regras e cenários são configuração, organizada em **pacotes**. O primeiro pacote é o do **SplitHub** (fornecedores, contratos e documentos fiscais, pelo docs da API v1.7.0).

1. **Ambiente e integrações** — em *Ambientes*, crie o ambiente do sistema testado (por exemplo, *SplitHub — Sandbox*). Guarde as collections e os environments em *Biblioteca de APIs* e ligue cada integração ao ambiente com o papel dela. Também dá para importar do Postman ou preencher à mão em *Integrações › Nova integração*. As credenciais vão para a aba *Segredos* (cofre). Use *Testar conexão*.
2. **Estrutura de APIs** — cada operação ligada a uma entidade e a uma ação (`criar`, `consultar`…). O que a collection não tem vem do pacote. As divergências entre a collection e o modelo aparecem ali.
3. **Modelos e cadastros** — ajuste os modelos do pacote (campos, geradores, regras, perfis, casos de borda) e veja um exemplo antes de salvar. Salve empresas, contratos e o que mais quiser como cadastros mestres.
4. **Cenário** — parta de um cenário pronto do pacote (C-01 a C-05) e ajuste as quantidades, os perfis, os cadastros e os casos de borda. *Gerar massa* cria a execução, sem enviar nada.
5. **Execução** — revise a massa, envie e acompanhe:
   - **Monitor de requisições:** o que foi enviado e o que voltou, com o esperado ao lado. Dá para reenviar e copiar como curl.
   - **Conferência:** o resultado de cada registro contra o gabarito.
   - **Rastreabilidade:** o retrato da execução, a trilha e o pacote de evidências.

Para desenvolver com recarga automática: `npm run dev` (servidor em 3000, interface em 5173).

## Usuários e acesso

O app pede login: e-mail e senha. Ninguém se cadastra sozinho.

| Papel | O que faz |
|---|---|
| **Root** | Tudo, inclusive gerenciar usuários. |
| **Operador** | Configura destinos, modelos e cenários, e envia massa. Não gerencia usuários. |
| **Leitor** | Só consulta. Não altera nada nem envia. |

- **Roots:** os e-mails de `MASSGEN_ROOTS`, no `.env`. Na subida, cada root que ainda não tem senha recebe no console um **link de primeiro acesso**, válido por 24 horas. Só quem vê o console do servidor vê o link. Perdeu ou venceu? Reinicie o app: sai um link novo, e o anterior para de valer.
- **Os demais:** um root faz o pré-cadastro em **Usuários** (e-mail, nome e papel). O app mostra um **link de convite**, válido por 7 dias, uma vez só: copie-o ou abra-o num e-mail para a pessoa. Ela abre o link, define o nome e a senha, e entra.
- **Senha:** pelo menos 10 caracteres. Cada um troca a sua na barra lateral. Quem esqueceu pede a um root um **link de nova senha** (24 horas). Gerar outro link invalida o anterior.
- **Sessão:** 12 horas (`MASSGEN_SESSAO_HORAS`), num cookie `HttpOnly` e `SameSite=Lax`, também `Secure` quando `MASSGEN_URL_PUBLICA` é `https`. Cinco senhas erradas seguidas, para o mesmo e-mail e IP, bloqueiam o login por 15 minutos.
- **Desativar** alguém derruba as sessões abertas na hora. Ninguém desativa a si mesmo, e o último root ativo não perde o papel.
- **Guardados só em hash:** a senha (scrypt) e os tokens de sessão e de convite (SHA-256). Nenhum dos dois entra na trilha.

## Ambientes, integrações e biblioteca de APIs

Desde a v3.0 o app trabalha por **ambiente de teste**. Um ambiente é um sistema testado num tipo de ambiente — sandbox, homologação ou desenvolvimento — e reúne as integrações dele. As próximas etapas levam para o ambiente os dados mestre e os contextos de massa.

- **Integração:** uma API ligada ao ambiente, com um papel. No papel **cliente**, o app chama a API do sistema testado, como um cliente faria. No papel **ente emulado**, o app faz o papel de um terceiro que o sistema integra (por exemplo, Receita Federal ou Comitê Gestor do IBS) e entrega os eventos dele nas rotas que o sistema expõe. Enquanto o sistema não expõe essas rotas, a integração fica *Aguardando rota*. Ente emulado não recebe a massa de um cenário.
- **Biblioteca de APIs:** guarda collections e environments do Postman como arquivo original, com versão, de qualquer sistema. Importar o mesmo arquivo de novo não cria versão; um arquivo diferente vira a versão seguinte, e a tela compara duas versões (requisições ou variáveis novas, removidas e alteradas). A mesma collection serve a integrações de ambientes diferentes, cada uma com o seu environment.
- **Segredos do environment:** o valor de cada segredo vai para o cofre da versão, e o arquivo guardado fica sem ele. Tokens de execução (`access_token` e afins) não são guardados. Ao ligar uma integração, os segredos passam do cofre da biblioteca para o cofre dela.
- **Trocar de versão:** a integração mostra quando há uma versão mais nova na biblioteca. Trocar reaplica a importação: as operações importadas são substituídas, e as editadas à mão ficam.
- **Migração da v2.0:** na primeira subida da v3.0, cada destino vai para o ambiente do seu pacote e do seu tipo (*SplitHub — Sandbox*, por exemplo), criado na hora se não existir.

## Destinos e a trava de produção

O app só envia para domínios da lista `ALLOWED_DESTINATION_DOMAINS`, no `.env` (veja o `.env.example`). Por padrão, só `localhost`. Para um sandbox, inclua o domínio dele e reinicie.

Endereços de produção são sempre recusados: os do `BLOCKED_DESTINATION_DOMAINS` e os que o pacote declara como produção.

## Rastreabilidade e auditoria

- **Trilha de auditoria:** cada ação fica registrada — destino, segredo, importação, modelo, cenário, geração, envio, pausa, reenvio. Cada registro diz quem fez, em que máquina, quando e em quê. Segredos nunca entram na trilha.
- **Quem fez:** o e-mail de quem entrou no app. Com o Cloudflare Access ligado e `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true`, é o e-mail que o Access autenticou (cabeçalho `Cf-Access-Authenticated-User-Email`), desde que esteja cadastrado. Sem a variável, esse cabeçalho é ignorado, porque qualquer um poderia forjá-lo.
- **Acessos:** logins, tentativas que falharam, bloqueios, convites, trocas de papel e desativações também entram na trilha (ações `usuario.*`).
- **Cada chamada ao destino** fica gravada: método, URL, cabeçalhos e corpos com token e segredos mascarados, status, tempo, tentativa, chave de idempotência, quem disparou e o hash do corpo enviado.
- **Código de rastreio:** cada chamada leva o cabeçalho `X-MassGen-Rastreio` (`MG-<execução>-<entidade>-<n>-<fase>-<tentativa>`), para achar a chamada nos logs do destino.
- **Integridade:** a trilha e as requisições são encadeadas por hash (SHA-256). A verificação, em Auditoria, aponta a primeira linha alterada ou removida.
- **Pacote de evidências:** cada execução gera um JSON com o retrato do que produziu a massa (cenário, semente, pacote, hash dos modelos, destino), os registros com o gabarito, as requisições e a trilha.

## Hospedar para o time

Para o time usar o mesmo MassGen, ele roda numa **VM Linux sempre ligada**, com disco persistente: aqui, uma VM **Always Free** da Oracle Cloud. O **Cloudflare Tunnel** liga a VM ao Cloudflare sem abrir nenhuma porta de entrada, e o Cloudflare cuida do HTTPS. O login é o do próprio app. O **Cloudflare Access** é uma camada opcional, na frente de tudo. O banco continua o SQLite em `data/`.

```
navegador → Cloudflare (HTTPS) → Cloudflare Tunnel → cloudflared, na VM → MassGen em 127.0.0.1:3000 (login do app) → sandboxes
```

### O domínio fica num lugar só

O endereço do app é o `MASSGEN_URL_PUBLICA`, no `.env` da VM, por exemplo `https://massgen.split.com`. Os links de convite saem dele, e os comandos do passo 6 tiram dele o hostname do túnel. Para trocar de domínio, mude essa linha e refaça o passo 6.

**O domínio precisa ser seu e estar no Cloudflare.** Para usar `massgen.split.com`, a zona `split.com` precisa estar na sua conta do Cloudflare, com os *nameservers* do Cloudflare. O passo 6 cria nela o registro `massgen`. Se a zona for de outra pessoa ou empresa, o túnel não consegue publicar o endereço: use um subdomínio de um domínio que você controla.

### Por que não GitHub Pages nem o plano gratuito do Render

- **GitHub Pages** só serve arquivos estáticos. O MassGen precisa de um servidor: é ele que chama as APIs dos sandboxes, guarda as credenciais cifradas no cofre e grava a trilha de auditoria. O navegador não faz isso sozinho, por causa do CORS e porque os segredos não podem ir para a tela.
- **Render, plano gratuito:** o disco é efêmero. A cada deploy ou reinício, `data/` some, e com ela o banco, a chave do cofre, os usuários e a trilha. Disco persistente só existe nos planos pagos. Além disso, o serviço dorme depois de 15 minutos sem acesso, e um envio longo seria interrompido.

### O que precisa

- **Uma conta na Oracle Cloud (Free Tier).** O cadastro pede um cartão para confirmar a identidade, mas os recursos *Always Free* não são cobrados.
- **Um domínio com DNS no Cloudflare.** A conta gratuita do Cloudflare serve. Sem domínio, só para um teste, há o túnel rápido (veja [Instalar com um comando](#instalar-com-um-comando-passos-2-a-7)).
- **Os e-mails dos roots**, para o `MASSGEN_ROOTS`.

### 1. Criar a VM na Oracle Cloud

1. Crie a conta em [signup.cloud.oracle.com](https://signup.cloud.oracle.com). A **home region** é escolhida uma vez só, e os recursos gratuitos só existem nela: prefira **Brazil East (São Paulo)** ou **Brazil Southeast (Vinhedo)**.
2. No menu, abra **Compute › Instances › Create instance** e preencha:

   | Campo | Valor |
   |---|---|
   | Name | `massgen` |
   | Image | **Canonical Ubuntu 24.04** |
   | Shape | **Ampere › VM.Standard.A1.Flex**, com **1 OCPU e 6 GB** de memória. O Always Free cobre até 4 OCPUs e 24 GB no total. |
   | Networking | crie uma VCN nova com sub-rede **pública** e marque **Assign a public IPv4 address**. O IP serve para o SSH e para a VM sair para a internet. |
   | Add SSH keys | gere o par e baixe a chave privada, ou cole a sua chave pública |
   | Boot volume | o padrão. O Always Free cobre até 200 GB. |

   O painel marca o que é *Always Free-eligible*. Confira antes de criar.
3. Se aparecer **Out of capacity for shape VM.Standard.A1.Flex**, tente outro *availability domain* ou outro horário. Passar a conta para **Pay As You Go** dá mais capacidade e continua sem custo dentro dos limites gratuitos.
4. **Não abra portas.** A *security list* padrão da VCN só libera o SSH (22). Não acrescente 80 nem 443: o túnel sai da VM, ninguém entra por ela. Se quiser, restrinja a regra do 22 ao IP de quem administra.
5. Entre na VM com o IP público que aparece na instância:

   ```bash
   ssh -i caminho/da/chave-privada ubuntu@IP-PUBLICO
   ```

A Oracle pode recuperar instâncias Always Free ociosas: CPU, rede e memória baixas por 7 dias seguidos. Contas *Pay As You Go* não passam por isso. O backup diário (passo 9) é a garantia de volta.

### Instalar com um comando (passos 2 a 7)

O `deploy/instalar.sh` faz os passos 2 a 7 de uma vez e, rodado de novo, atualiza (passo 10). Os passos 2 a 7, mais abaixo, são o que ele faz: servem para quem prefere fazer à mão ou precisa depurar.

**Antes, no painel do Cloudflare:**

1. Em **Networking › Tunnels › Create a tunnel**, crie o túnel com o nome `massgen`.
2. Na tela seguinte, escolha **Debian** e **arm64** e copie o comando de instalação, que traz o token. Não rode o comando na VM: o instalador pede o token e cuida disso.
3. No túnel, abra a aba **Routes** › **Add route** › **Published application** e preencha:
   - **Subdomain:** `massgen`;
   - **Domain:** o seu domínio;
   - **Service URL:** `http://127.0.0.1:3000`. Use `127.0.0.1`, não `localhost`.

   O endereço resultante é o do `--url`.

**Na VM**, pelo SSH do passo 1:

```bash
curl -fsSLo instalar.sh https://raw.githubusercontent.com/Inchausti/MassGen/main/deploy/instalar.sh
sudo bash instalar.sh --url https://massgen.split.com --roots voce@empresa.com.br --dominios-permitidos webhook.poc.exemplo.com.br
```

O instalador:

- confere as entradas antes de mexer na máquina;
- pede o token do túnel, sem mostrá-lo na tela;
- instala os pacotes e o Node 24, acerta o fuso, cria o usuário `massgen`, clona o app em `/opt/massgen` e compila a interface;
- escreve o `.env`, com `MASSGEN_HOST=127.0.0.1`;
- sobe o `massgen.service`, o timer do backup e o túnel;
- faz o primeiro backup do banco e confere o endereço pela internet.

No fim, ele mostra os links de primeiro acesso dos roots (passo 7).

| Opção | O que faz |
|---|---|
| `--url` | O endereço do app, `MASSGEN_URL_PUBLICA`. É o hostname público do túnel. |
| `--roots` | Os e-mails dos roots, separados por vírgula. |
| `--dominios-permitidos` | `ALLOWED_DESTINATION_DOMAINS`. Ponha o domínio do webhook do SplitHub da POC: sem ele na lista, o MassGen não consegue avisá-lo. |
| `--tunel` | `painel` (o padrão), `rapido` ou `nenhum`. Sem a opção, um túnel já instalado fica como está. |
| `--refazer-tunel` | Troca o túnel instalado: outro modo, ou um token novo. |
| `--ref`, `--repo`, `--fuso` | A branch (padrão `main`), a origem do clone e o fuso (padrão `America/Sao_Paulo`). |

**O token do túnel** fica em `/etc/cloudflared/massgen-tunel.env`, legível só pelo root, e o `deploy/massgen-tunel.service` o lê de lá. Com o `cloudflared service install <token>` do painel, ele ficaria na linha de comando, à vista no `ps` e no `systemctl cat`.

**Sem domínio, só para um teste:** use `--tunel rapido` no lugar do `--url`. O Cloudflare sorteia um endereço `*.trycloudflare.com`, que muda sempre que a VM ou o túnel reiniciam. Depois de um reinício, rode o instalador de novo: ele lê o endereço novo e atualiza o `.env`. O túnel rápido serve para conferir a instalação, não para a POC: o SplitHub da POC cadastra o endereço, e o Cloudflare não garante a disponibilidade desses túneis.

A CI (`.github/workflows/verificar-implantacao.yml`, job *Instalador*) roda o instalador numa máquina limpa, em x64 e ARM, a cada push no `main`. Ela cobre:

- as entradas inválidas;
- a primeira instalação;
- a segunda vez, sem mudança e sem reinício;
- a atualização por um commit novo, com backup antes;
- o túnel rápido.

### 2. Preparar a VM

```bash
sudo apt update && sudo apt install -y git sqlite3 curl gettext-base
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version
dpkg --print-architecture
sudo timedatectl set-timezone America/Sao_Paulo
sudo useradd --system --create-home --home-dir /var/lib/massgen --shell /usr/sbin/nologin massgen
```

O `node --version` precisa mostrar v24 ou mais, e a arquitetura, `arm64` (Ampere). O NodeSource e o repositório do `cloudflared` têm pacotes para `arm64`. O fuso define a hora do backup diário. O `gettext-base` traz o `envsubst`, usado no passo 6.

### 3. Instalar o app

```bash
sudo mkdir -p /opt/massgen && sudo chown massgen:massgen /opt/massgen
sudo -u massgen git clone https://github.com/Inchausti/MassGen.git /opt/massgen
cd /opt/massgen
sudo -u massgen -H npm ci
sudo -u massgen -H npm run build
sudo -u massgen mkdir -p data
```

### 4. Configurar o `.env`

```bash
sudo -u massgen cp .env.example .env
sudo -u massgen chmod 600 .env
sudo -u massgen nano .env
```

| Variável | Na VM | O que faz |
|---|---|---|
| `MASSGEN_URL_PUBLICA` | `https://massgen.split.com` | O endereço do app, e o único lugar com o domínio. Monta os links de primeiro acesso e de convite. |
| `MASSGEN_ROOTS` | os e-mails dos roots | Separados por vírgula. Cada um recebe um link de primeiro acesso no console. |
| `MASSGEN_HOST` | `127.0.0.1` | Endereço de escuta. **Padrão: vazio, que escuta em todas as interfaces.** Com `127.0.0.1`, só o `cloudflared`, na mesma VM, alcança o app. Use `127.0.0.1`, não `localhost`, que pode resolver para `::1`. |
| `PORT` | `3000` | Porta do app. |
| `MASSGEN_COOKIE_SEGURO` | vazio | Vazio: o cookie de sessão só anda por HTTPS, porque a URL pública é `https`. |
| `MASSGEN_SESSAO_HORAS` | `12` | Duração da sessão. |
| `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS` | `false` | `true` só com o Cloudflare Access na frente (passo 8). |
| `ALLOWED_DESTINATION_DOMAINS` | os sandboxes | Domínios dos sandboxes que o time vai usar, como `api.sandbox.exemplo.com.br,*.hml.exemplo.com.br`. Tire `localhost` e `127.0.0.1` se a API falsa não rodar na VM: assim ninguém aponta um destino para serviços da própria VM. |
| `BLOCKED_DESTINATION_DOMAINS` | produção | Domínios sempre recusados. |
| `MASSGEN_DATA_DIR` | `data` | Pasta do banco e da chave do cofre. Se mudar, mude também o `ReadWritePaths` do `massgen.service`. |
| `MASSGEN_MASTER_KEY` | vazio | Vazio: o app cria `data/master.key`. |
| `MASSGEN_AVISO_ESPERAS_MS` | `2000,5000` | Esperas entre as tentativas do aviso ao webhook do SplitHub da POC. Com o padrão, são três tentativas. |

### 5. Subir como serviço (systemd)

```bash
sudo cp deploy/massgen.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now massgen
curl -s http://127.0.0.1:3000/api/saude
```

O `curl` deve responder `{"ok":true}`. O serviço roda `node server/main.ts` com o usuário `massgen`, carrega o `.env` e reinicia sozinho se cair. Os logs ficam em `journalctl -u massgen -f`. Se o Node não estiver em `/usr/bin/node` (confira com `command -v node`), ajuste o `ExecStart`.

### 6. Cloudflare Tunnel

Instale o `cloudflared` pelo repositório do Cloudflare:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

Crie o túnel. O `login` mostra um link: abra-o em qualquer navegador e escolha a zona do domínio. Se a zona não aparecer na lista, o domínio não está na sua conta do Cloudflare (veja [O domínio fica num lugar só](#o-domínio-fica-num-lugar-só)).

```bash
cloudflared tunnel login
cloudflared tunnel create massgen
```

O `create` mostra o UUID do túnel e grava `~/.cloudflared/<UUID>.json`. Tire o domínio do `.env`, aponte o DNS e gere a configuração a partir do modelo:

```bash
export TUNEL_ID=COLE-AQUI-O-UUID
export DOMINIO="$(sudo sed -n 's#^MASSGEN_URL_PUBLICA=https://\([^/]*\).*#\1#p' /opt/massgen/.env)"
echo "Túnel $TUNEL_ID para $DOMINIO"
cloudflared tunnel route dns massgen "$DOMINIO"
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/"$TUNEL_ID".json /etc/cloudflared/
envsubst '$DOMINIO $TUNEL_ID' < /opt/massgen/deploy/cloudflared/config.yml | sudo tee /etc/cloudflared/config.yml
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cloudflared service install
sudo systemctl status cloudflared
curl -s "https://$DOMINIO/api/saude"
```

O `echo` precisa mostrar o UUID e o domínio. Se o domínio sair vazio, o `MASSGEN_URL_PUBLICA` do `.env` não começa com `https://`. O último `curl` deve responder `{"ok":true}`, já pela internet.

Prefere criar o túnel pelo painel (**Networking › Tunnels**)? É o caminho do instalador (`--tunel painel`). O hostname público é configurado lá, na aba **Routes** do túnel: o mesmo domínio, apontando para `http://127.0.0.1:3000`. Nesse caso, o `config.yml` não é usado, e a camada opcional do Access no `cloudflared` (passo 8, item 3) também é ligada no painel. À mão, sem o instalador, o painel dá um comando `cloudflared service install <token>`.

### 7. Primeiro acesso dos roots

```bash
sudo journalctl -u massgen --no-pager | grep "Primeiro acesso"
```

Cada root tem uma linha `Primeiro acesso de <e-mail>: https://<domínio>/convite/<token>`. Mande cada link só para o dono, por um canal privado: quem abre o link define a senha daquela conta. O link vale por 24 horas e funciona uma vez.

Venceu ou se perdeu? `sudo systemctl restart massgen` e rode o `grep` de novo: sai um link novo para cada root que ainda não definiu a senha.

Depois, um root convida o resto do time em **Usuários**.

### 8. Cloudflare Access (opcional)

O login do app já protege o MassGen. O Access acrescenta uma barreira antes dele e o login com a conta da empresa. Siga [deploy/cloudflare-access.md](deploy/cloudflare-access.md). Em resumo:

1. Crie uma aplicação **Self-hosted** para o domínio.
2. Crie uma política *Allow* com os e-mails de quem usa o MassGen.
3. Descomente o bloco `originRequest` em `/etc/cloudflared/config.yml`, cole o *AUD tag* e reinicie o `cloudflared`.
4. Para o e-mail do Access valer como login do app, ligue `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true` e reinicie o MassGen.

**As rotas dos entes emulados (`/entes/*`) não passam pelo login de ninguém:** o SplitHub da POC as chama de máquina para máquina, com o `clientid` e o `clientsecret` da POC, como chamaria o Comitê Gestor. Com o Access na frente, crie uma segunda aplicação só para o caminho `/entes/*`, com uma política *Bypass* restrita ao IP de saída do SplitHub da POC (ou um *Service Token* que ele envie). Nunca *Everyone*. A interface e o `/api` continuam atrás da política *Allow*.

### 9. Backup e restauração

O `deploy/backup.sh` grava um `.tar.gz` com:

- **`massgen.db`:** cópia consistente, feita pelo `.backup` do `sqlite3`, porque o banco está em modo WAL e um `cp` com o app gravando pode sair corrompido. A cópia passa por um `integrity_check`. Os usuários e as sessões estão nele.
- **`master.key`:** a chave do cofre.
- **`.env`:** a configuração do app.

O timer roda o backup todo dia às 3h e guarda 14 dias (`MASSGEN_BACKUP_RETENCAO_DIAS`).

```bash
sudo mkdir -p /var/backups/massgen
sudo chown massgen:massgen /var/backups/massgen
sudo chmod 700 /var/backups/massgen
sudo cp deploy/massgen-backup.service deploy/massgen-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now massgen-backup.timer
sudo systemctl start massgen-backup.service
ls -l /var/backups/massgen
```

O `start` faz o primeiro backup na hora, para conferir. Os logs ficam em `journalctl -u massgen-backup`.

**O backup traz a chave junto com o cofre:** quem tiver o arquivo abre as credenciais dos sandboxes. Mantenha-o só para o usuário `massgen`. Um backup no mesmo disco não sobrevive à perda da VM: copie-o para fora com acesso restrito ou cifrado, por exemplo com `age` ou `gpg`.

**Restaurar** (na mesma VM, ou numa nova depois dos passos 1 a 6):

```bash
sudo systemctl stop massgen
cd /opt/massgen
sudo -u massgen mv data "data.antes-da-restauracao-$(date +%F)"
sudo -u massgen mkdir data
sudo -u massgen tar -xzf /var/backups/massgen/massgen-AAAA-MM-DD_HHMMSS.tar.gz -C data massgen.db master.key
sudo systemctl start massgen
```

Mover a pasta `data` inteira importa: um `massgen.db-wal` antigo ao lado do banco restaurado o corromperia. Se a chave estiver no `.env` (`MASSGEN_MASTER_KEY`), o backup não traz `master.key`: extraia só o `massgen.db`. O `.env` do backup fica para conferência. Restaure-o só se a chave estiver nele ou se a VM for nova. Depois, em **Auditoria**, use *Verificar integridade*. O time entra com as mesmas senhas: os usuários voltam com o banco.

### 10. Atualizar

Com o instalador:

```bash
sudo bash /opt/massgen/deploy/instalar.sh
```

Ele faz o backup antes, puxa o `main`, recompila e só reinicia o que mudou. Se algum arquivo de `deploy/` mudou, ele o copia para o systemd. Sem opções, o `.env` e o túnel ficam como estão.

À mão:

```bash
cd /opt/massgen
sudo systemctl start massgen-backup.service
sudo -u massgen git pull
sudo -u massgen -H npm ci
sudo -u massgen -H npm run build
sudo systemctl restart massgen
```

O backup antes da atualização é a garantia de volta. As migrações do banco rodam sozinhas na subida. Avise o time antes: envios em andamento no reinício ficam como *interrompidos*. Se algum arquivo de `deploy/` mudou, copie-o de novo para `/etc/systemd/system/` e rode `sudo systemctl daemon-reload`. Se o modelo do `cloudflared` mudou, refaça o `envsubst` do passo 6.

## Estrutura

```
server/
  emulacao/    apuração assistida: leitura dos XMLs, catálogo dos 24 tipos do IBS, roteiros, motor, arquivo do Anexo I, relógio
    catalogo-cbs.ts  os 26 tipos da CBS, os campos da foto e os três calculados
    arquivo-cbs.ts   a foto do débito e do crédito, os registros de pagamento e recolhimento, o JSON de cada endpoint
    cbs.ts           tíquetes da CBS: seleção pela janela ou pelo dia, link assinado, vencimento, download
    cobertura.ts     plano automático, troca de roteiro e painel de cobertura dos 59 tipos, com o XML que falta
    casos.ts         os casos de transporte e falha (T01 a T09): ligar, armar, provocar e quando cada um fecha
    relogio-automatico.ts  o relógio que anda sozinho (D-MG-07): um dia por passo, pausa, data de parada e retomada na subida
  entes/       rotas dos entes emulados (/entes/ibs e /entes/cbs) e as collections do Postman
    cbs.ts           Receita Federal emulada: token, pedido, situação, download, urlRetorno e aviso
  core/        núcleo genérico: geradores, regras (JSONata), geração, conferência
  engine/      envio: autenticação, limite de taxa, idempotência, retentativa, registro
  servicos/    POCs e notas; pacotes, destinos, modelos, cadastros, cenários, execuções, monitor
  importers/   collection e environment do Postman
  auditoria.ts trilha de auditoria e cadeia de hash
  usuarios.ts  login, sessões, convites e papéis
packs/         pacotes de domínio (splithub.json)
mock/          API falsa no estilo do SplitHub
web/           interface (React + Vite)
tests/         testes do núcleo e de ponta a ponta; ibs, cbs e cobertura são as três etapas da apuração assistida
deploy/        instalador de um comando, systemd, backup, túneis do Cloudflare e Cloudflare Access, para hospedar numa VM
.github/       verificação da implantação num Linux de verdade (x64 e ARM)
```

## Testes

```bash
npm test
```

Os testes de ponta a ponta sobem o app e a API falsa e conferem:

- a etapa 1 da apuração assistida, com um SplitHub falso que recebe o webhook e baixa os arquivos: a importação dos XMLs, a habilitação, o RT-A1 e o RT-F1 dia a dia, o envio sob demanda com o pré-requisito e o saldo, o forçar, o aviso que falha e o reenvio, o fatiamento com o hash acumulado, a substituição do planejado e o fim da POC;
- a etapa 2 ([tests/cbs.test.ts](tests/cbs.test.ts)), com um SplitHub falso que responde ao `HEAD`, recebe o aviso e baixa o link:
  - o catálogo dos 26 tipos e a conta de saldo do estudo;
  - o token, no formulário e em Basic;
  - os pedidos recusados;
  - o RT-A1 e o RT-F1 nos dois entes, com a coleta pela janela e o histórico nos dois entes;
  - o limite diário;
  - o aviso sem pedido, com a validação da `urlRetorno` e o envio sob demanda;
  - o aviso que falha e o reenvio com o mesmo link;
  - o link vencido e a volta pelo pedido;
  - os roteiros só da CBS, com multa e juros;
  - a collection e o fim da POC;
- a etapa 3 ([tests/cobertura.test.ts](tests/cobertura.test.ts)), com um lote fictício de valores redondos e um SplitHub falso que baixa o que chega, pede de novo quando o link vence ou o processamento estoura e pede o Arquivo Manual quando falta algo:
  - o lote fecha os **59 tipos**: os 24 do IBS, os 26 da CBS e os 9 casos, cada um entregue e baixado;
  - o plano automático e a prévia que não grava;
  - a defasagem entre os entes, pela POC e pelo roteiro;
  - o XML que falta, numa frase por XML (D-MG-05);
  - os casos desligados por padrão, armados ao ligar, e cada provocação: o fatiamento (T05), o dia sem Delta (T06), a linha que falta (T07), o 2xx descartado (T09), o `APURACAO-408` (T03) e o link vencido (T02);
  - a nota fora do SplitHub, que só sai com "incluir não importadas" (T08);
  - as regras do Arquivo Manual, o cancelamento e a entrega no Processamento Diário seguinte (T04, T06, T07);
  - a troca de roteiro de uma nota que já tem história;
  - as collections dos dois entes;
- o relógio automático ([tests/relogio.test.ts](tests/relogio.test.ts)), com o intervalo de 1 segundo e um SplitHub falso que baixa o que chega:
  - um dia por passo nos dois entes, com a defasagem da CBS, os avisos e nenhum link vencido;
  - a data de parada;
  - quem ligou, pausou e retomou, na trilha;
  - o dia fechado por comando, que o passo não fecha de novo;
  - o reinício do servidor, inclusive depois de uma queda entre o fechamento do dia e a anotação do passo;
  - a POC apagada com o relógio rodando;
- o primeiro acesso do root, o convite, os papéis, a sessão vencida, a desativação e o bloqueio de login;
- o cenário C-01 e os casos de borda do C-05;
- a idempotência;
- a importação do Postman;
- a rastreabilidade, com o e-mail de quem fez;
- a detecção de adulteração;
- o Cloudflare Access: o e-mail só vale com `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true`, só para quem está cadastrado, e o app escuta só no `MASSGEN_HOST`.

A cada push, o GitHub Actions ([verificar-implantacao.yml](.github/workflows/verificar-implantacao.yml)) roda num Ubuntu 24.04 x64 e num ARM (como a VM Ampere):

- os testes e o build;
- o `systemd-analyze verify` nas units de `deploy/`;
- o `backup.sh` com o app no ar e a restauração do banco;
- o `cloudflared` instalado pelo repositório do Cloudflare, validando o `config.yml` gerado do modelo;
- o `deploy/instalar.sh`:
  - o `shellcheck`;
  - as entradas inválidas, recusadas antes de mexer na máquina;
  - a primeira instalação;
  - a segunda vez, sem reinício;
  - a atualização por um commit novo, com backup antes e o próprio instalador trocado;
  - o túnel rápido, que depende do serviço público do Cloudflare e não derruba o job.

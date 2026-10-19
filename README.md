# MassGen

Gerador de massa de dados **genérico** e interativo. Você modela as entidades, gera massa coerente, envia a uma API de destino cadastrada, acompanha cada requisição e confere o resultado contra um gabarito.

O núcleo não conhece nenhum domínio: entidades, regras e cenários são configuração, organizada em **pacotes**. O primeiro pacote é o do **SplitHub** (fornecedores, contratos e documentos fiscais, pelo docs da API v1.7.0).

Roda na sua máquina, sem infraestrutura: um servidor Node e um banco SQLite num arquivo.

## Como rodar

Precisa do **Node.js 24 ou mais novo**. Nada mais: o banco é o SQLite embutido no Node, e o TypeScript roda sem compilação.

```bash
npm install
npm start
```

Abra http://localhost:3000. O `npm start` compila a interface e sobe o servidor.

### Testar sem sandbox

Uma API falsa, com as regras do SplitHub, roda junto:

```bash
npm run mock
```

Ela fica em http://localhost:8089, com `client_id` **massgen** e `client_secret` **massgen-segredo**. O comprador cadastrado é o CNPJ **11222333000181**. Crie um destino com o pacote SplitHub apontando para ela e rode o cenário C-01.

## Destinos e a trava de produção

O app só envia para domínios da lista `ALLOWED_DESTINATION_DOMAINS`, no `.env` (veja o `.env.example`). Por padrão, só `localhost`. Para um sandbox, inclua o domínio dele e reinicie.

Endereços de produção são sempre recusados: os do `BLOCKED_DESTINATION_DOMAINS` e os que o pacote declara como produção.

## Rastreabilidade e auditoria

- **Trilha de auditoria:** cada ação fica registrada — destino, segredo, importação, modelo, cenário, geração, envio, pausa, reenvio. Cada registro diz quem fez, em que máquina, quando e em quê. Segredos nunca entram na trilha.
- **Cada chamada ao destino** fica gravada: método, URL, cabeçalhos e corpos com token e segredos mascarados, status, tempo, tentativa, chave de idempotência, quem disparou e o hash do corpo enviado.
- **Código de rastreio:** cada chamada leva o cabeçalho `X-MassGen-Rastreio` (`MG-<execução>-<entidade>-<n>-<fase>-<tentativa>`), para achar a chamada nos logs do destino.
- **Integridade:** a trilha e as requisições são encadeadas por hash (SHA-256). A verificação, em Auditoria, aponta a primeira linha alterada ou removida.
- **Pacote de evidências:** cada execução gera um JSON com o retrato do que produziu a massa (cenário, semente, pacote, hash dos modelos, destino), os registros com o gabarito, as requisições e a trilha.

## Estrutura

```
server/
  core/        núcleo genérico: geradores, regras (JSONata), geração, conferência
  engine/      envio: autenticação, limite de taxa, idempotência, retentativa, registro
  servicos/    pacotes, destinos, modelos, cadastros, cenários, execuções, monitor
  importers/   collection e environment do Postman
  auditoria.ts trilha de auditoria e cadeia de hash
packs/         pacotes de domínio (splithub.json)
mock/          API falsa no estilo do SplitHub
web/           interface (React + Vite)
tests/         testes do núcleo e de ponta a ponta
```

## Testes

```bash
npm test
```

Os testes de ponta a ponta sobem o app e a API falsa e conferem:

- o cenário C-01 e os casos de borda do C-05;
- a idempotência;
- a importação do Postman;
- a rastreabilidade;
- a detecção de adulteração.

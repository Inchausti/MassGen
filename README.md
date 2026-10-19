# MassGen

Gerador de massa de dados **genérico** e interativo. Você modela as entidades, gera massa coerente, envia a uma API de destino cadastrada, acompanha cada requisição e confere o resultado contra um gabarito.

O núcleo não conhece nenhum domínio: entidades, regras e cenários são configuração, organizada em **pacotes**. O primeiro pacote é o do **SplitHub** (fornecedores, contratos e documentos fiscais, pelo docs da API v1.7.0).

Roda na sua máquina, sem infraestrutura: um servidor Node e um banco SQLite num arquivo. Para o time usar junto, o mesmo app roda numa VM: veja [Hospedar para o time](#hospedar-para-o-time).

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

## Como usar

1. **Destino** — em *Destinos › Novo destino*, importe a collection e o environment do Postman ou preencha à mão. As credenciais vão para a aba *Segredos* (cofre). Use *Testar conexão*.
2. **Estrutura de APIs** — cada operação ligada a uma entidade e a uma ação (`criar`, `consultar`…). O que a collection não tem vem do pacote. As divergências entre a collection e o modelo aparecem ali.
3. **Modelos e cadastros** — ajuste os modelos do pacote (campos, geradores, regras, perfis, casos de borda) e veja um exemplo antes de salvar. Salve empresas, contratos e o que mais quiser como cadastros mestres.
4. **Cenário** — parta de um cenário pronto do pacote (C-01 a C-05) e ajuste as quantidades, os perfis, os cadastros e os casos de borda. *Gerar massa* cria a execução, sem enviar nada.
5. **Execução** — revise a massa, envie e acompanhe:
   - **Monitor de requisições:** o que foi enviado e o que voltou, com o esperado ao lado. Dá para reenviar e copiar como curl.
   - **Conferência:** o resultado de cada registro contra o gabarito.
   - **Rastreabilidade:** o retrato da execução, a trilha e o pacote de evidências.

A primeira vez que abrir o app, informe seu nome: ele entra na trilha de auditoria de cada ação. Hospedado atrás do Cloudflare Access, o app não pergunta: usa o e-mail do login.

Para desenvolver com recarga automática: `npm run dev` (servidor em 3000, interface em 5173).

## Destinos e a trava de produção

O app só envia para domínios da lista `ALLOWED_DESTINATION_DOMAINS`, no `.env` (veja o `.env.example`). Por padrão, só `localhost`. Para um sandbox, inclua o domínio dele e reinicie.

Endereços de produção são sempre recusados: os do `BLOCKED_DESTINATION_DOMAINS` e os que o pacote declara como produção.

## Rastreabilidade e auditoria

- **Trilha de auditoria:** cada ação fica registrada — destino, segredo, importação, modelo, cenário, geração, envio, pausa, reenvio. Cada registro diz quem fez, em que máquina, quando e em quê. Segredos nunca entram na trilha.
- **Quem fez:** na sua máquina, o nome informado na interface mais o usuário do sistema. Hospedado atrás do Cloudflare Access, com `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true`, é o e-mail do login (cabeçalho `Cf-Access-Authenticated-User-Email`). Sem a variável, esse cabeçalho é ignorado, porque qualquer um poderia forjá-lo.
- **Cada chamada ao destino** fica gravada: método, URL, cabeçalhos e corpos com token e segredos mascarados, status, tempo, tentativa, chave de idempotência, quem disparou e o hash do corpo enviado.
- **Código de rastreio:** cada chamada leva o cabeçalho `X-MassGen-Rastreio` (`MG-<execução>-<entidade>-<n>-<fase>-<tentativa>`), para achar a chamada nos logs do destino.
- **Integridade:** a trilha e as requisições são encadeadas por hash (SHA-256). A verificação, em Auditoria, aponta a primeira linha alterada ou removida.
- **Pacote de evidências:** cada execução gera um JSON com o retrato do que produziu a massa (cenário, semente, pacote, hash dos modelos, destino), os registros com o gabarito, as requisições e a trilha.

## Hospedar para o time

Para o time usar o mesmo MassGen, ele roda numa **VM Linux sempre ligada**, com disco persistente. O **Cloudflare Tunnel** liga a VM ao Cloudflare sem abrir nenhuma porta. O **Cloudflare Access** exige login com o e-mail da empresa antes de qualquer requisição chegar ao app. O banco continua o SQLite em `data/`.

```
navegador → Cloudflare Access (login) → Cloudflare Tunnel → cloudflared, na VM → MassGen em 127.0.0.1:3000 → sandboxes
```

### Por que não GitHub Pages nem o plano gratuito do Render

- **GitHub Pages** só serve arquivos estáticos. O MassGen precisa de um servidor: é ele que chama as APIs dos sandboxes, guarda as credenciais cifradas no cofre e grava a trilha de auditoria. O navegador não faz isso sozinho, por causa do CORS e porque os segredos não podem ir para a tela.
- **Render, plano gratuito:** o disco é efêmero. A cada deploy ou reinício, `data/` some, e com ela o banco, a chave do cofre e a trilha. Disco persistente só existe nos planos pagos. Além disso, o serviço dorme depois de 15 minutos sem acesso, e um envio longo seria interrompido.

### O que precisa

- **Uma VM Linux sempre ligada.** Os comandos abaixo são para Ubuntu 24.04 LTS. Pode ser:
  - **uma VM da empresa**; ou
  - **Oracle Cloud Always Free** (Ampere A1 ou AMD micro). Na criação da conta, a *home region* é escolhida uma vez só, e os recursos gratuitos só existem nela: prefira São Paulo ou Vinhedo. Não precisa abrir porta na *security list*, porque o túnel sai da VM. A Oracle pode recuperar instâncias Always Free ociosas. Contas *Pay As You Go* não passam por isso e continuam sem custo dentro dos limites gratuitos.
- **Node.js 24 ou mais novo**, `git` e `sqlite3` (usado pelo backup).
- **Um domínio com DNS no Cloudflare.** A conta gratuita serve.
- **Cloudflare Zero Trust, plano Free**, com até 50 usuários.

1 vCPU e 1 GB de memória bastam para o app. Com 1 GB, crie um swap de 2 GB antes do build da interface.

### 1. Preparar a VM

```bash
sudo apt update && sudo apt install -y git sqlite3 curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version
sudo timedatectl set-timezone America/Sao_Paulo
sudo useradd --system --create-home --home-dir /var/lib/massgen --shell /usr/sbin/nologin massgen
```

O `node --version` precisa mostrar v24 ou mais. O fuso define a hora do backup diário.

### 2. Instalar o app

```bash
sudo mkdir -p /opt/massgen && sudo chown massgen:massgen /opt/massgen
sudo -u massgen git clone https://github.com/Inchausti/MassGen.git /opt/massgen
cd /opt/massgen
sudo -u massgen -H npm ci
sudo -u massgen -H npm run build
sudo -u massgen mkdir -p data
```

Se o repositório for privado, clone com uma *deploy key* só de leitura.

### 3. Configurar o `.env`

```bash
sudo -u massgen cp .env.example .env
sudo -u massgen chmod 600 .env
sudo -u massgen nano .env
```

| Variável | Na VM | O que faz |
|---|---|---|
| `PORT` | `3000` | Porta do app. |
| `MASSGEN_HOST` | `127.0.0.1` | Endereço de escuta. **Padrão: vazio, que escuta em todas as interfaces.** Com `127.0.0.1`, só o `cloudflared`, na mesma VM, alcança o app. Use `127.0.0.1`, não `localhost`, que pode resolver para `::1`. |
| `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS` | `true` | O e-mail do login do Access vira o usuário da trilha. Padrão: `false`. Só ligue com o app atrás do Access e em `127.0.0.1`. |
| `ALLOWED_DESTINATION_DOMAINS` | os sandboxes | Domínios dos sandboxes que o time vai usar, como `api.sandbox.exemplo.com.br,*.hml.exemplo.com.br`. Tire `localhost` e `127.0.0.1` se a API falsa não rodar na VM: assim ninguém aponta um destino para serviços da própria VM. |
| `BLOCKED_DESTINATION_DOMAINS` | produção | Domínios sempre recusados. |
| `MASSGEN_DATA_DIR` | `data` | Pasta do banco e da chave do cofre. Se mudar, mude também o `ReadWritePaths` do `massgen.service`. |
| `MASSGEN_MASTER_KEY` | vazio | Vazio: o app cria `data/master.key`. |

### 4. Subir como serviço (systemd)

```bash
sudo cp deploy/massgen.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now massgen
curl -s http://127.0.0.1:3000/api/saude
```

O `curl` deve responder `{"ok":true}`. O serviço roda `node server/main.ts` com o usuário `massgen`, carrega o `.env` e reinicia sozinho se cair. Os logs ficam em `journalctl -u massgen -f`. Se o Node não estiver em `/usr/bin/node` (confira com `command -v node`), ajuste o `ExecStart`.

### 5. Cloudflare Tunnel

Instale o `cloudflared` pelo repositório do Cloudflare:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

Crie o túnel e aponte o DNS. O `login` mostra um link: abra-o em qualquer navegador e escolha o domínio.

```bash
cloudflared tunnel login
cloudflared tunnel create massgen
cloudflared tunnel route dns massgen massgen.empresa.com.br
```

O `create` mostra o UUID do túnel e grava `~/.cloudflared/<UUID>.json`. Copie as credenciais e o exemplo de configuração:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo cp /opt/massgen/deploy/cloudflared/config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml
```

Troque o UUID, o hostname, o `teamName` e o `audTag`. Os dois últimos vêm do passo 6. Com `access.required: true`, o túnel recusa tudo até o Access existir, então pode subir antes:

```bash
sudo cloudflared service install
sudo systemctl status cloudflared
```

Prefere criar o túnel pelo painel (**Networks › Tunnels**)? O painel dá um comando `cloudflared service install <token>`. Aí o hostname público (`http://127.0.0.1:3000`) e o *Protect with Access* são configurados lá, e o `config.yml` não é usado.

### 6. Cloudflare Access

Siga [deploy/cloudflare-access.md](deploy/cloudflare-access.md). Em resumo:

1. Crie uma aplicação **Self-hosted** para `massgen.empresa.com.br`.
2. Crie uma política *Allow* por **e-mails terminados em** `@empresa.com.br` ou por uma lista de e-mails.
3. Copie o *AUD tag* para o `config.yml` e reinicie o `cloudflared`.

Abra o endereço numa janela anônima. Deve aparecer o login do Access, e depois o app, com o seu e-mail na barra lateral.

### 7. Backup e restauração

O `deploy/backup.sh` grava um `.tar.gz` com:

- **`massgen.db`:** cópia consistente, feita pelo `.backup` do `sqlite3`, porque o banco está em modo WAL e um `cp` com o app gravando pode sair corrompido. A cópia passa por um `integrity_check`.
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

Mover a pasta `data` inteira importa: um `massgen.db-wal` antigo ao lado do banco restaurado o corromperia. Se a chave estiver no `.env` (`MASSGEN_MASTER_KEY`), o backup não traz `master.key`: extraia só o `massgen.db`. O `.env` do backup fica para conferência. Restaure-o só se a chave estiver nele ou se a VM for nova. Depois, em **Auditoria**, use *Verificar integridade*.

### 8. Atualizar

```bash
cd /opt/massgen
sudo systemctl start massgen-backup.service
sudo -u massgen git pull
sudo -u massgen -H npm ci
sudo -u massgen -H npm run build
sudo systemctl restart massgen
```

O backup antes da atualização é a garantia de volta. As migrações do banco rodam sozinhas na subida. Avise o time antes: envios em andamento no reinício ficam como *interrompidos*. Se algum arquivo de `deploy/` mudou, copie-o de novo para `/etc/systemd/system/` e rode `sudo systemctl daemon-reload`.

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
deploy/        systemd, backup, cloudflared e Cloudflare Access, para hospedar numa VM
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
- a detecção de adulteração;
- a identidade do Cloudflare Access: o e-mail só vale com `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true`, e o app escuta só no `MASSGEN_HOST`.

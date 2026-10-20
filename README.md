# MassGen

Gerador de massa de dados **genérico** e interativo. Você modela as entidades, gera massa coerente, envia a uma API de destino cadastrada, acompanha cada requisição e confere o resultado contra um gabarito.

O núcleo não conhece nenhum domínio: entidades, regras e cenários são configuração, organizada em **pacotes**. O primeiro pacote é o do **SplitHub** (fornecedores, contratos e documentos fiscais, pelo docs da API v1.7.0).

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

## Como usar

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
- **Um domínio com DNS no Cloudflare.** A conta gratuita do Cloudflare serve.
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

Prefere criar o túnel pelo painel (**Networks › Tunnels**)? O painel dá um comando `cloudflared service install <token>`. Aí o hostname público (o mesmo domínio, apontando para `http://127.0.0.1:3000`) é configurado lá, e o `config.yml` não é usado.

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
  core/        núcleo genérico: geradores, regras (JSONata), geração, conferência
  engine/      envio: autenticação, limite de taxa, idempotência, retentativa, registro
  servicos/    pacotes, destinos, modelos, cadastros, cenários, execuções, monitor
  importers/   collection e environment do Postman
  auditoria.ts trilha de auditoria e cadeia de hash
  usuarios.ts  login, sessões, convites e papéis
packs/         pacotes de domínio (splithub.json)
mock/          API falsa no estilo do SplitHub
web/           interface (React + Vite)
tests/         testes do núcleo e de ponta a ponta
deploy/        systemd, backup, cloudflared e Cloudflare Access, para hospedar numa VM
.github/       verificação da implantação num Linux de verdade (x64 e ARM)
```

## Testes

```bash
npm test
```

Os testes de ponta a ponta sobem o app e a API falsa e conferem:

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
- o `cloudflared` instalado pelo repositório do Cloudflare, validando o `config.yml` gerado do modelo.

# Cloudflare Access para o MassGen

O Access fica na frente do túnel e exige login antes de qualquer requisição chegar ao app. O plano **Free** do Cloudflare Zero Trust cobre até **50 usuários**.

Quem passa pelo login chega ao app com o cabeçalho `Cf-Access-Authenticated-User-Email`. Com `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true` no `.env`, o MassGen grava esse e-mail na trilha de auditoria e o mostra na barra lateral. O nome digitado na interface deixa de valer.

Os nomes dos menus abaixo são os do painel do Zero Trust (one.dash.cloudflare.com). O Cloudflare às vezes reorganiza o painel. Se um menu não estiver onde o passo diz, procure pelo nome da opção.

## Antes de começar

- O túnel já foi criado (`cloudflared tunnel create massgen`) e o DNS já foi apontado (`cloudflared tunnel route dns massgen massgen.empresa.com.br`). Veja o README.
- O domínio está na sua conta do Cloudflare.

## 1. Ativar o Zero Trust

1. No painel do Cloudflare, abra **Zero Trust**.
2. Na primeira vez, escolha o **nome da equipe** (*team name*). Ele vira `sua-equipe.cloudflareaccess.com` e vai no `teamName` do `config.yml`.
3. Escolha o plano **Free**. O painel pode pedir um meio de pagamento mesmo no plano gratuito.

O nome da equipe também aparece depois em **Settings › Custom Pages** (*Team domain*).

## 2. Escolher como o time faz login

Em **Settings › Authentication › Login methods**:

- **One-time PIN** já vem ligado: a pessoa digita o e-mail e recebe um código. Não precisa de mais nada.
- Se a empresa usa **Google Workspace** ou **Microsoft Entra ID**, adicione-o aqui: o time entra com a conta da empresa, sem código por e-mail.

## 3. Criar a aplicação

Em **Access › Applications › Add an application**, escolha **Self-hosted** e preencha:

| Campo | Valor |
|---|---|
| Application name | MassGen |
| Session duration | 24 hours (o login vale por um dia) |
| Public hostname | subdomínio `massgen`, domínio `empresa.com.br`, path vazio (o app todo, inclusive `/api`) |
| Identity providers | os do passo 2 |

## 4. Criar a política de acesso

Ainda na aplicação, em **Policies › Add a policy**:

| Campo | Valor |
|---|---|
| Policy name | Time da empresa |
| Action | Allow |
| Include | **Emails ending in** `@empresa.com.br` (todo o domínio) **ou** **Emails** com a lista de quem pode entrar |

Use a lista de e-mails se nem todo mundo com e-mail da empresa deve entrar. Para pôr ou tirar alguém depois, é só editar a política.

Salve a aplicação.

## 5. Copiar o AUD tag para o túnel

Na aplicação, em **Overview**, copie o **Application Audience (AUD) Tag**. Cole no `audTag` de `/etc/cloudflared/config.yml` e preencha o `teamName`. O exemplo está em `deploy/cloudflared/config.yml`.

Com `access.required: true`, o próprio `cloudflared` recusa toda requisição sem um token válido dessa aplicação. Se alguém desligar o Access no painel por engano, o app não fica aberto: as requisições param no túnel.

```bash
sudo systemctl restart cloudflared
```

## 6. Ligar a identidade no MassGen

No `/opt/massgen/.env`:

```bash
MASSGEN_HOST=127.0.0.1
MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true
```

```bash
sudo systemctl restart massgen
```

Ligue a variável só quando o único caminho até o app for o túnel com o Access. Sem o Access na frente, qualquer um que alcance o app pode mandar o cabeçalho com o e-mail de outra pessoa. Por isso o app escuta só em `127.0.0.1`, e o log avisa na subida se a variável estiver ligada sem isso.

## 7. Testar

1. Abra `https://massgen.empresa.com.br` numa janela anônima. Deve aparecer a tela de login do Access, não o app.
2. Entre com um e-mail da empresa. O app abre, e o e-mail aparece na barra lateral, no lugar de "Informar operador".
3. Faça uma ação (por exemplo, crie um destino) e abra **Auditoria**: a coluna *Quem* mostra o e-mail.
4. Tente com um e-mail de fora da política: o Access recusa.

## Tirar alguém

1. Tire a pessoa da política (passo 4).
2. Para derrubar um login que ainda vale, em **My Team › Users** escolha a pessoa e use **Revoke session**.
3. Isso também libera o lugar dela entre os 50 do plano Free.

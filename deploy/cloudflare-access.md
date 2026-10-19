# Cloudflare Access para o MassGen (camada opcional)

O MassGen tem login próprio: e-mail e senha, com roots e convites (veja "Usuários e acesso", no README). Com isso, ele já pode ficar na internet só com o túnel.

O Cloudflare Access é uma camada **a mais**, na frente do túnel. Ele exige login antes de qualquer requisição chegar ao app, então nem a tela de entrada do MassGen fica exposta. Também deixa o time entrar com a conta da empresa (Google Workspace ou Microsoft Entra ID), sem senha do MassGen. O plano **Free** do Cloudflare Zero Trust cobre até **50 usuários**.

Com `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true` no `.env`, o e-mail que o Access autenticou (cabeçalho `Cf-Access-Authenticated-User-Email`) identifica o usuário no MassGen:

- **Cadastrado e ativo:** entra direto, sem a senha do MassGen, com o papel que tem no app.
- **Convidado** (pré-cadastrado por um root): o primeiro acesso pelo Access já aceita o convite. O Access comprovou o e-mail.
- **Não cadastrado ou desativado:** o app mostra "Sem acesso ao MassGen" e recusa as chamadas com 403. Passar pelo Access não basta: quem dá o acesso ao app é um root, em **Usuários**.

Os nomes dos menus abaixo são os do painel do Zero Trust (one.dash.cloudflare.com). O Cloudflare às vezes reorganiza o painel. Se um menu não estiver onde o passo diz, procure pelo nome da opção.

## Antes de começar

- O túnel já funciona, com o seu domínio (o de `MASSGEN_URL_PUBLICA`), e o login do app já abre por ele. Veja o README.
- Os roots já fizeram o primeiro acesso.

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
| Public hostname | o seu domínio, com path vazio (o app todo, inclusive `/api`) |
| Identity providers | os do passo 2 |

## 4. Criar a política de acesso

Ainda na aplicação, em **Policies › Add a policy**:

| Campo | Valor |
|---|---|
| Policy name | Time do MassGen |
| Action | Allow |
| Include | **Emails** com a lista de quem usa o MassGen, **ou** **Emails ending in** `@empresa.com.br` |

A política decide quem chega ao app; o cadastro em **Usuários** decide quem entra nele. Mantenha os dois alinhados. Se algum usuário tem e-mail fora do domínio da empresa (um root com e-mail pessoal, por exemplo), use a lista de e-mails, ou inclua a pessoa numa segunda regra *Include*.

Salve a aplicação.

## 5. Exigir o Access no túnel

Na aplicação, em **Overview**, copie o **Application Audience (AUD) Tag**. Em `/etc/cloudflared/config.yml`, descomente o bloco `originRequest` e preencha o `teamName` e o `audTag`:

```bash
sudo nano /etc/cloudflared/config.yml
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo systemctl restart cloudflared
```

Com `access.required: true`, o próprio `cloudflared` recusa toda requisição sem um token válido dessa aplicação. Se alguém desligar o Access no painel por engano, o app não fica aberto: as requisições param no túnel.

## 6. Ligar a identidade no MassGen

No `/opt/massgen/.env`:

```bash
MASSGEN_HOST=127.0.0.1
MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true
```

```bash
sudo systemctl restart massgen
```

Ligue a variável só quando o único caminho até o app for o túnel com o Access exigido (passo 5). Sem o Access na frente, qualquer um que alcance o app pode mandar o cabeçalho com o e-mail de outra pessoa. Por isso o app escuta só em `127.0.0.1`, e o log avisa na subida se a variável estiver ligada sem isso.

Prefere o Access só como barreira, com a senha do MassGen valendo? Faça os passos 1 a 5 e deixe `MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=false`.

## 7. Testar

1. Abra o seu domínio numa janela anônima. Deve aparecer a tela de login do Access, não a do app.
2. Entre com o e-mail de um usuário cadastrado. O app abre direto, com o e-mail e o papel na barra lateral, marcados com "Access".
3. Faça uma ação (por exemplo, crie um destino) e abra **Auditoria**: a coluna *Quem* mostra o e-mail.
4. Entre no Access com um e-mail que a política aceita, mas que não está em **Usuários**: o app mostra "Sem acesso ao MassGen".

## Tirar alguém

1. Em **Usuários**, no MassGen, desative a pessoa. As sessões do app caem na hora.
2. Tire a pessoa da política (passo 4).
3. Para derrubar um login do Access que ainda vale, em **My Team › Users** escolha a pessoa e use **Revoke session**. Isso também libera o lugar dela entre os 50 do plano Free.

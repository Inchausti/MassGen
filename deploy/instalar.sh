#!/usr/bin/env bash
# Instalador do MassGen numa VM Ubuntu 24.04 com systemd, como a Always Free da Oracle Cloud.
# Faz os passos 2 a 7 de "Hospedar para o time", no README: pacotes e Node 24, o usuário massgen, o app em
# /opt/massgen, o .env, os serviços do systemd, o backup diário do banco e o túnel do Cloudflare.
#
# Pode rodar de novo. Na segunda vez, atualiza: faz o backup, puxa a branch, recompila e só reinicia o que mudou.
# O banco (data/) e o .env ficam como estão, menos as chaves passadas nas opções.
#
# Primeira vez, na VM, com o túnel já criado no painel do Cloudflare (o instalador pede o token):
#   curl -fsSLo instalar.sh https://raw.githubusercontent.com/Inchausti/MassGen/main/deploy/instalar.sh
#   sudo bash instalar.sh --url https://massgen.seudominio.com.br --roots voce@empresa.com.br
# Atualizar:
#   sudo bash /opt/massgen/deploy/instalar.sh
# Todas as opções: bash instalar.sh --ajuda
set -Eeuo pipefail

APP=/opt/massgen
USUARIO=massgen
BACKUPS=/var/backups/massgen
UNIDADES=/etc/systemd/system
TOKEN_ARQUIVO=/etc/cloudflared/massgen-tunel.env
REPO_PADRAO=https://github.com/Inchausti/MassGen.git
SAUDE=http://127.0.0.1:3000/api/saude
# Os túneis que o instalador reconhece: o do painel, o rápido e o da linha de comando (passo 6 do README, à mão).
TUNEIS=(massgen-tunel massgen-tunel-rapido cloudflared)

RE_HOST='[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+'
RE_EMAIL="[A-Za-z0-9._%+-]+@$RE_HOST"
RE_DOMINIO="(\*\.)?$RE_HOST|localhost|127\.0\.0\.1"

ajuda() {
  cat <<'FIM'
Uso: sudo bash instalar.sh [opções]

  --url URL                    Endereço do app, como https://massgen.seudominio.com.br (MASSGEN_URL_PUBLICA).
                               É o hostname público do túnel. Obrigatório na primeira vez, menos com --tunel rapido.
  --roots E-MAILS              E-mails dos roots, separados por vírgula (MASSGEN_ROOTS). Obrigatório na primeira vez.
  --dominios-permitidos LISTA  Domínios que o app pode chamar (ALLOWED_DESTINATION_DOMAINS), como o do webhook do
                               SplitHub da POC. Separados por vírgula; aceita *.exemplo.com.br.
  --tunel MODO                 painel  túnel criado no painel do Cloudflare; o instalador pede o token (padrão)
                               rapido  endereço temporário *.trycloudflare.com, sem domínio: só para teste
                               nenhum  sem túnel: o app fica só em 127.0.0.1:3000
                               Sem --tunel, um túnel já instalado fica como está.
  --refazer-tunel              Troca o túnel instalado: outro modo, ou um token novo.
  --ref BRANCH                 Branch do repositório (padrão: main).
  --repo ENDEREÇO              De onde clonar (padrão: https://github.com/Inchausti/MassGen.git).
  --fuso FUSO                  Fuso da VM, que define a hora do backup (padrão: America/Sao_Paulo). Vazio: não mexe.
  -h, --ajuda                  Esta ajuda.

O token do painel não vai na linha de comando: o instalador pergunta, sem mostrar na tela, ou lê a variável
MASSGEN_TUNEL_TOKEN (sudo --preserve-env=MASSGEN_TUNEL_TOKEN bash instalar.sh ...).
FIM
}

ETAPA=início
AVISOS=()
URL="" ROOTS="" DOMINIOS="" TUNEL="" REFAZER="" REF=main REPO="" FUSO=America/Sao_Paulo JA_ATUALIZADO="" TOKEN=""
REINICIAR="" ENV_MUDOU="" ENV_NOVO="" HASH_ESTE="" ARGS=()

etapa() { ETAPA=$1; printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$*"; }
aviso() { AVISOS+=("$*"); printf '    Atenção: %s\n' "$*" >&2; }
falhar() { printf '\nO instalador parou (%s): %s\n' "$ETAPA" "$*" >&2; exit 1; }
trap 'printf "\nO instalador parou na etapa \"%s\" (linha %s). Corrija o que apareceu acima e rode de novo.\n" "$ETAPA" "$LINENO" >&2' ERR

# O app, o Git e o npm rodam como o usuário massgen, dono de /opt/massgen. O PATH fixo garante o Node de
# /usr/bin, o mesmo do massgen.service: o secure_path do sudo põe /usr/local/bin antes, onde pode haver outro.
como_massgen() { sudo -u "$USUARIO" -H env PATH=/usr/bin:/bin:/usr/sbin:/sbin "$@"; }
# Numa VM recém-criada, o apt automático do Ubuntu pode estar com a trava: espera em vez de falhar.
apt_() { apt-get -q -y -o DPkg::Lock::Timeout=600 "$@"; }

ler_env() { [[ -f "$APP/.env" ]] || return 0; sed -n "s/^$1=//p" "$APP/.env" | tail -n 1; }

# definir_env CHAVE VALOR: troca a linha da chave no .env, ou acrescenta no fim. O cat preserva o dono e a permissão.
definir_env() {
  local chave=$1 valor=$2 tmp
  if grep -q "^$chave=" "$APP/.env" && [[ "$(ler_env "$chave")" == "$valor" ]]; then return 0; fi
  tmp="$(mktemp)"
  awk -v k="$chave=" -v v="$valor" '
    index($0, k) == 1 { if (!feito) print k v; feito = 1; next }
    { print }
    END { if (!feito) print k v }' "$APP/.env" >"$tmp"
  cat "$tmp" >"$APP/.env"
  rm -f "$tmp"
  ENV_MUDOU=1
}

exigir_valor() { [[ $# -ge 2 && -n $2 && $2 != --* ]] || falhar "$1 precisa de um valor (veja --ajuda)."; }

ler_opcoes() {
  while (($#)); do
    case $1 in
      --url) exigir_valor "$@"; URL=$2; shift 2 ;;
      --roots) exigir_valor "$@"; ROOTS=$2; shift 2 ;;
      --dominios-permitidos) exigir_valor "$@"; DOMINIOS=$2; shift 2 ;;
      --tunel) exigir_valor "$@"; TUNEL=$2; shift 2 ;;
      --refazer-tunel) REFAZER=1; shift ;;
      --ref) exigir_valor "$@"; REF=$2; shift 2 ;;
      --repo) exigir_valor "$@"; REPO=$2; shift 2 ;;
      --fuso) [[ $# -ge 2 ]] || falhar "--fuso precisa de um valor."; FUSO=$2; shift 2 ;;
      --ja-atualizado) JA_ATUALIZADO=1; shift ;; # uso interno: a versão nova do instalador, depois do git
      -h | --ajuda) ajuda; exit 0 ;;
      *) falhar "opção desconhecida: $1 (veja --ajuda)." ;;
    esac
  done
}

tunel_instalado() {
  local t
  for t in "${TUNEIS[@]}"; do
    if systemctl is-enabled -q "$t.service" 2>/dev/null; then echo "$t"; return 0; fi
  done
  return 0
}

conferir_maquina() {
  [[ $EUID -eq 0 ]] || falhar "rode com sudo: sudo bash instalar.sh ..."
  command -v apt-get >/dev/null && [[ -d /run/systemd/system ]] || falhar "o instalador precisa de um Ubuntu com apt e systemd."
  local os
  os="$(. /etc/os-release 2>/dev/null && echo "${ID:-}-${VERSION_ID:-}" || true)"
  [[ $os == ubuntu-24.04 ]] || aviso "o instalador foi verificado no Ubuntu 24.04; esta máquina é ${os:-desconhecida}."
}

# Tudo o que pode dar errado nas entradas é conferido aqui, antes de qualquer mudança na máquina.
conferir_entradas() {
  local instalado atual palavras=()
  instalado="$(tunel_instalado)"
  if [[ -z $TUNEL ]]; then
    if [[ -n $instalado ]]; then TUNEL=manter
    elif [[ ! -f "$APP/.env" ]]; then TUNEL=painel
    else TUNEL=nenhum
    fi
  fi
  case $TUNEL in painel | rapido | nenhum | manter) ;; *) falhar "--tunel aceita painel, rapido ou nenhum." ;; esac
  if [[ $TUNEL != manter && -n $instalado && -z $REFAZER ]]; then
    if [[ $TUNEL == painel && $instalado == massgen-tunel ]] || [[ $TUNEL == rapido && $instalado == massgen-tunel-rapido ]]; then
      TUNEL=manter
    else
      falhar "já há um túnel instalado ($instalado.service). Para trocar por --tunel $TUNEL, acrescente --refazer-tunel."
    fi
  fi

  URL=${URL%/}
  if [[ -n $URL && ! $URL =~ ^https://$RE_HOST$ ]]; then
    falhar "--url precisa ser https://<domínio>, sem caminho nem porta. Veio: $URL"
  fi
  [[ $TUNEL != rapido || -z $URL ]] || falhar "o túnel rápido sorteia o endereço: não passe --url com --tunel rapido."
  if [[ $TUNEL == painel && -z $URL && ! "$(ler_env MASSGEN_URL_PUBLICA)" =~ ^https:// ]]; then
    falhar "informe --url https://<o hostname público do túnel no painel do Cloudflare>."
  fi

  ROOTS=${ROOTS// /}
  if [[ -n $ROOTS && ! $ROOTS =~ ^$RE_EMAIL(,$RE_EMAIL)*$ ]]; then
    falhar "--roots precisa ser uma lista de e-mails separados por vírgula. Veio: $ROOTS"
  fi
  atual="$(ler_env MASSGEN_ROOTS)"
  if [[ -z $ROOTS && ( -z $atual || $atual == voce@empresa.com.br ) ]]; then
    falhar "informe --roots com os e-mails de quem administra o MassGen."
  fi

  DOMINIOS=${DOMINIOS// /}
  if [[ -n $DOMINIOS && ! $DOMINIOS =~ ^($RE_DOMINIO)(,($RE_DOMINIO))*$ ]]; then
    falhar "--dominios-permitidos precisa ser uma lista de domínios separados por vírgula. Veio: $DOMINIOS"
  fi
  [[ $REF =~ ^[A-Za-z0-9._/-]+$ ]] || falhar "--ref inválido: $REF"
  [[ -z $FUSO || -f /usr/share/zoneinfo/$FUSO ]] || falhar "fuso desconhecido: $FUSO (veja timedatectl list-timezones)."

  if [[ $TUNEL == painel ]]; then
    TOKEN=${MASSGEN_TUNEL_TOKEN:-}
    if [[ -z $TOKEN ]]; then
      { : </dev/tty; } 2>/dev/null || falhar "sem terminal para perguntar o token do túnel: passe-o em MASSGEN_TUNEL_TOKEN."
      printf '\nNo painel do Cloudflare (Networking › Tunnels), abra o túnel e copie o comando de instalação, com o token.\n' >/dev/tty
      printf 'Cole aqui o comando inteiro ou só o token (não aparece na tela) e tecle Enter: ' >/dev/tty
      IFS= read -rs TOKEN </dev/tty || true
      printf '\n' >/dev/tty
    fi
    # Do comando colado, fica a última palavra: o token.
    read -ra palavras <<<"${TOKEN//$'\r'/}" || true
    if ((${#palavras[@]})); then TOKEN=${palavras[-1]}; else TOKEN=""; fi
    [[ $TOKEN =~ ^eyJ[A-Za-z0-9+/_=-]{40,}$ ]] || falhar "isso não parece um token de túnel do Cloudflare (ele começa com eyJ)."
  fi
}

major_node() {
  local v
  v="$(/usr/bin/node --version 2>/dev/null || true)"
  v=${v#v}
  v=${v%%.*}
  if [[ $v =~ ^[0-9]+$ ]]; then echo "$v"; else echo 0; fi
}

instalar_cloudflared() {
  [[ -x /usr/bin/cloudflared ]] && return 0
  info "Instalando o cloudflared pelo repositório do Cloudflare"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    >/etc/apt/sources.list.d/cloudflared.list
  apt_ update
  apt_ install cloudflared
  [[ -x /usr/bin/cloudflared ]] || falhar "o cloudflared não ficou em /usr/bin/cloudflared, onde os serviços o procuram."
}

etapa_pacotes() {
  etapa "Pacotes do sistema, Node 24, fuso e usuário"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  apt_ update
  apt_ install git sqlite3 curl ca-certificates gettext-base gnupg
  if (($(major_node) < 24)); then
    info "Instalando o Node 24 pelo NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt_ install nodejs
  fi
  (($(major_node) >= 24)) || falhar "o Node em /usr/bin/node precisa ser 24 ou mais novo: $(/usr/bin/node --version 2>&1 || true)."
  info "Node $(/usr/bin/node --version), arquitetura $(dpkg --print-architecture)."
  if [[ $TUNEL == painel || $TUNEL == rapido ]]; then instalar_cloudflared; fi
  if [[ -n $FUSO && "$(timedatectl show -p Timezone --value 2>/dev/null || true)" != "$FUSO" ]]; then
    timedatectl set-timezone "$FUSO"
    info "Fuso: $FUSO."
  fi
  if ! id -u "$USUARIO" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/massgen --shell /usr/sbin/nologin "$USUARIO"
    info "Usuário $USUARIO criado."
  fi
}

backup_antes_de_atualizar() {
  if [[ -f $UNIDADES/massgen-backup.service && -f $APP/data/massgen.db ]]; then
    info "Backup antes de atualizar"
    systemctl start massgen-backup.service
  fi
}

etapa_codigo() {
  etapa "Código em $APP"
  if [[ -d $APP/.git ]]; then
    cd "$APP" || falhar "sem acesso a $APP."
    [[ -z "$(como_massgen git status --porcelain --untracked-files=no)" ]] ||
      falhar "há mudanças locais em $APP (sudo -u $USUARIO git -C $APP status). Desfaça-as antes de atualizar."
    [[ -z $REPO ]] || como_massgen git remote set-url origin "$REPO"
    if [[ -z $JA_ATUALIZADO ]]; then
      como_massgen git fetch -q origin "$REF"
      if [[ "$(como_massgen git rev-parse HEAD)" != "$(como_massgen git rev-parse FETCH_HEAD)" ]]; then
        backup_antes_de_atualizar
        como_massgen git checkout -q -B "$REF" FETCH_HEAD
        info "Atualizado para $(como_massgen git log -1 --format='%h %s')."
      else
        info "Já no último commit de $REF: $(como_massgen git log -1 --format='%h %s')."
      fi
    fi
  else
    [[ ! -e $APP || -z "$(ls -A "$APP")" ]] || falhar "$APP existe e não é um clone do MassGen."
    install -d -o "$USUARIO" -g "$USUARIO" "$APP"
    cd "$APP" || falhar "sem acesso a $APP."
    como_massgen git clone -q --branch "$REF" "${REPO:-$REPO_PADRAO}" "$APP"
    info "Clonado: $(como_massgen git log -1 --format='%h %s')."
  fi
  # Quem roda é sempre o instalador do commit que vai para o ar: se o do repositório for outro, ele continua daqui.
  if [[ -z $JA_ATUALIZADO && "$(sha256sum <"$APP/deploy/instalar.sh")" != "$HASH_ESTE" ]]; then
    info "O instalador do repositório é outra versão: segue com ela."
    export MASSGEN_TUNEL_TOKEN=$TOKEN
    exec bash "$APP/deploy/instalar.sh" "${ARGS[@]}" --ja-atualizado
  fi
}

etapa_build() {
  etapa "Dependências e interface"
  local commit
  commit="$(como_massgen git rev-parse HEAD)"
  # O npm ci apaga o node_modules: a marca do último commit compilado fica nele e some junto.
  if [[ -f web/dist/index.html && "$(cat node_modules/.massgen-compilado 2>/dev/null || true)" == "$commit" ]]; then
    info "Já compilado neste commit (${commit:0:7})."
    return 0
  fi
  como_massgen npm ci --no-audit --no-fund
  como_massgen npm run build
  echo "$commit" | como_massgen tee node_modules/.massgen-compilado >/dev/null
  REINICIAR=1
}

copiar_unidade() {
  cmp -s "$APP/deploy/$1" "$UNIDADES/$1" && return 0
  install -m 0644 "$APP/deploy/$1" "$UNIDADES/$1"
  systemctl daemon-reload
  [[ $1 != massgen.service ]] || REINICIAR=1
  info "Instalado: $UNIDADES/$1"
}

desligar_tuneis() {
  local t
  for t in "${TUNEIS[@]}"; do
    if systemctl is-enabled -q "$t.service" 2>/dev/null || systemctl is-active -q "$t.service" 2>/dev/null; then
      systemctl disable --now -q "$t.service"
      info "Desligado: $t.service"
    fi
  done
}

# O endereço que o túnel rápido sorteou nesta subida dele, lido do journal.
url_rapida() {
  local id u
  for _ in $(seq 1 60); do
    id="$(systemctl show -p InvocationID --value massgen-tunel-rapido.service)"
    if [[ -n $id ]]; then
      u="$(journalctl -q -o cat "_SYSTEMD_INVOCATION_ID=$id" 2>/dev/null |
        grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '^https://api\.' | tail -n 1 || true)"
      if [[ -n $u ]]; then echo "$u"; return 0; fi
    fi
    sleep 1
  done
  return 1
}

tunel_painel() {
  install -d -m 0755 /etc/cloudflared
  (umask 077 && printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" >"$TOKEN_ARQUIVO")
  desligar_tuneis
  copiar_unidade massgen-tunel.service
  systemctl enable -q massgen-tunel.service
  systemctl restart --no-block massgen-tunel.service
  for _ in $(seq 1 60); do systemctl is-active -q massgen-tunel.service && break; sleep 1; done
  if ! systemctl is-active -q massgen-tunel.service; then
    journalctl -u massgen-tunel -n 30 --no-pager >&2 || true
    falhar "o túnel não conectou em 60 s. Confira o token no painel do Cloudflare e rode de novo com --refazer-tunel."
  fi
  info "Túnel do painel conectado (massgen-tunel.service). O token está em $TOKEN_ARQUIVO, só para o root."
}

tunel_rapido() {
  [[ ! -f /etc/cloudflared/config.yml ]] ||
    falhar "o túnel rápido não sobe com /etc/cloudflared/config.yml presente (do túnel pela linha de comando). Use --tunel painel."
  desligar_tuneis
  copiar_unidade massgen-tunel-rapido.service
  systemctl enable -q massgen-tunel-rapido.service
  systemctl restart massgen-tunel-rapido.service
  URL="$(url_rapida)" || falhar "o túnel rápido não informou o endereço em 60 s (journalctl -u massgen-tunel-rapido)."
  info "Endereço temporário: $URL"
}

etapa_tunel() {
  etapa "Túnel do Cloudflare"
  local t
  case $TUNEL in
    manter)
      t="$(tunel_instalado)"
      info "Mantido: $t.service ($(systemctl is-active "$t.service" || true))."
      if [[ $t == massgen-tunel-rapido ]]; then
        URL="$(url_rapida)" || falhar "o túnel rápido não informou o endereço (journalctl -u massgen-tunel-rapido)."
      fi
      ;;
    nenhum)
      desligar_tuneis
      info "Sem túnel: o app fica só em 127.0.0.1:3000."
      ;;
    painel) tunel_painel ;;
    rapido) tunel_rapido ;;
  esac
  if [[ "$(tunel_instalado)" == massgen-tunel-rapido ]]; then
    aviso "o endereço do túnel rápido muda quando a VM ou o túnel reiniciam: depois disso, rode o instalador de novo. Para a POC, use --tunel painel, com um domínio."
  fi
}

etapa_env() {
  etapa "Configuração (.env)"
  cd "$APP" || falhar "sem acesso a $APP."
  if [[ ! -f .env ]]; then
    install -o "$USUARIO" -g "$USUARIO" -m 0600 .env.example .env
    ENV_NOVO=1
    definir_env MASSGEN_HOST 127.0.0.1
  fi
  chown "$USUARIO:$USUARIO" .env
  chmod 0600 .env
  [[ -z $URL ]] || definir_env MASSGEN_URL_PUBLICA "$URL"
  [[ -z $ROOTS ]] || definir_env MASSGEN_ROOTS "$ROOTS"
  [[ -z $DOMINIOS ]] || definir_env ALLOWED_DESTINATION_DOMAINS "$DOMINIOS"

  local host porta dados url
  host="$(ler_env MASSGEN_HOST)"
  porta="$(ler_env PORT)"
  dados="$(ler_env MASSGEN_DATA_DIR)"
  url="$(ler_env MASSGEN_URL_PUBLICA)"
  [[ -z $porta || $porta == 3000 ]] || falhar "PORT=$porta no .env: os serviços e o túnel supõem a porta 3000."
  [[ -z $dados || $dados == data ]] || falhar "MASSGEN_DATA_DIR=$dados no .env: o massgen.service só deixa gravar em $APP/data."
  [[ $host == 127.0.0.1 ]] || aviso "MASSGEN_HOST=${host:-vazio} no .env. Com o túnel, use 127.0.0.1: assim o app não fica exposto pelo IP da VM."
  if [[ -n "$(tunel_instalado)" && ! $url =~ ^https:// ]]; then
    falhar "MASSGEN_URL_PUBLICA precisa ser o endereço https do túnel: passe --url."
  fi
  if [[ -n $ENV_NOVO && -z $DOMINIOS ]]; then
    aviso "ALLOWED_DESTINATION_DOMAINS ficou $(ler_env ALLOWED_DESTINATION_DOMAINS). Para o MassGen avisar o webhook do SplitHub da POC, rode de novo com --dominios-permitidos <domínio do webhook>."
  fi
  install -d -o "$USUARIO" -g "$USUARIO" -m 0700 data
  info "$APP/.env só para o usuário $USUARIO (600). Endereço: ${url:-http://localhost:3000}."
}

aguardar_saude() {
  local id
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "$SAUDE" 2>/dev/null | grep -q '"ok":true'; then
      # Os links de primeiro acesso saem logo depois de "Domínios permitidos"; o journal pode levar um instante.
      id="$(systemctl show -p InvocationID --value massgen.service)"
      for _ in $(seq 1 20); do
        journalctl -q -o cat "_SYSTEMD_INVOCATION_ID=$id" 2>/dev/null | grep -q '^Domínios permitidos' && break
        sleep 0.25
      done
      sleep 0.5
      return 0
    fi
    sleep 0.5
  done
  journalctl -u massgen -n 40 --no-pager >&2 || true
  falhar "o app não respondeu em $SAUDE."
}

etapa_servicos() {
  etapa "Serviços do systemd"
  copiar_unidade massgen.service
  copiar_unidade massgen-backup.service
  copiar_unidade massgen-backup.timer
  install -d -o "$USUARIO" -g "$USUARIO" -m 0700 "$BACKUPS"
  systemctl enable -q massgen.service
  if ! systemctl is-active -q massgen.service; then
    systemctl start massgen.service
    info "massgen.service no ar."
  elif [[ -n $REINICIAR || -n $ENV_MUDOU ]]; then
    systemctl restart massgen.service
    info "massgen.service reiniciado."
  else
    info "Nada mudou: o massgen.service segue no ar, sem reiniciar."
  fi
  aguardar_saude
}

ultimo_backup() {
  find "$BACKUPS" -maxdepth 1 -name 'massgen-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n 1 | cut -d' ' -f2- || true
}

etapa_backup() {
  etapa "Banco e backup diário"
  local ultimo
  systemctl enable --now -q massgen-backup.timer
  if [[ -z "$(ultimo_backup)" ]]; then
    info "Primeiro backup, agora"
    systemctl start massgen-backup.service
  fi
  ultimo="$(ultimo_backup)"
  [[ -n $ultimo ]] || falhar "o backup não gerou arquivo em $BACKUPS (journalctl -u massgen-backup)."
  info "Banco: $APP/data/massgen.db (SQLite, no disco da VM)."
  info "Último backup: $ultimo. O timer roda todo dia às 3h e guarda 14 dias."
}

etapa_conferencia() {
  local url t
  url="$(ler_env MASSGEN_URL_PUBLICA)"
  t="$(tunel_instalado)"
  [[ -n $t && $url =~ ^https:// ]] || return 0
  etapa "Conferência pela internet"
  for _ in $(seq 1 24); do
    resolvectl flush-caches 2>/dev/null || true
    if curl -fsS --max-time 5 "$url/api/saude" 2>/dev/null | grep -q '"ok":true'; then
      info "$url/api/saude responde."
      return 0
    fi
    sleep 5
  done
  if [[ $t == massgen-tunel ]]; then
    aviso "$url ainda não responde pela internet. No painel do Cloudflare (Networking › Tunnels › massgen › Routes), o túnel precisa da rota ${url#https://} para o Service URL http://127.0.0.1:3000 (não localhost). O DNS pode levar alguns minutos."
  else
    aviso "$url ainda não responde pela internet (journalctl -u $t)."
  fi
}

resumo() {
  local url t id links
  url="$(ler_env MASSGEN_URL_PUBLICA)"
  t="$(tunel_instalado)"
  id="$(systemctl show -p InvocationID --value massgen.service)"
  links="$(journalctl -q -o cat "_SYSTEMD_INVOCATION_ID=$id" 2>/dev/null | grep '^Primeiro acesso de ' || true)"
  etapa "Pronto"
  info "App:            ${url:-http://localhost:3000}   (logs: journalctl -u massgen -f)"
  info "Entes emulados: ${url:-http://localhost:3000}/entes/...   (as rotas e a credencial de cada POC estão em POCs › Barramento)"
  info "Túnel:          $(if [[ -n $t ]]; then echo "$t.service"; else echo nenhum; fi)"
  info "Banco:          $APP/data/massgen.db, com backup diário em $BACKUPS"
  info "Atualizar:      sudo bash $APP/deploy/instalar.sh"
  if [[ -n $links ]]; then
    printf '\nLinks de primeiro acesso, da subida de %s. Cada um vale 24 h e uma vez.\n' "$(systemctl show -p ActiveEnterTimestamp --value massgen.service)"
    printf 'Mande cada link só para o dono, por um canal privado: quem abre define a senha daquela conta.\n'
    sed 's/^/  /' <<<"$links"
    printf 'Venceu ou se perdeu? sudo systemctl restart massgen e rode o instalador de novo.\n'
  else
    info "Sem link de primeiro acesso nesta subida: os roots já definiram a senha."
  fi
  if ((${#AVISOS[@]})); then
    printf '\nAtenção:\n'
    printf '  - %s\n' "${AVISOS[@]}"
  fi
}

main() {
  local este
  # A impressão digital deste arquivo sai antes do git, que pode trocá-lo no disco.
  este="$(readlink -f "${BASH_SOURCE[0]:-}" 2>/dev/null || true)"
  if [[ -f $este ]]; then HASH_ESTE="$(sha256sum <"$este")"; fi
  ARGS=("$@")
  ler_opcoes "$@"
  cd / || exit 1
  conferir_maquina
  conferir_entradas
  etapa_pacotes
  etapa_codigo
  etapa_build
  etapa_tunel
  etapa_env
  etapa_servicos
  etapa_backup
  etapa_conferencia
  resumo
}

# Carregado com source (nos testes), só define as funções.
if ! (return 0 2>/dev/null); then main "$@"; fi

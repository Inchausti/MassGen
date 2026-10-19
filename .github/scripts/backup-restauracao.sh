#!/usr/bin/env bash
# Backup e restauração na máquina da CI, com o MassGen rodando pelo systemd (deploy/massgen.service):
# faz o primeiro acesso do root, cria um destino com segredos no cofre, faz o backup pelo massgen-backup.service
# com o app gravando, restaura pelo procedimento do README e confere que o login, o destino e o cofre voltaram.
set -euo pipefail

URL=http://127.0.0.1:3000/api
EMAIL=ci.root@exemplo.com.br
SENHA=senha-da-ci-12345
MOCK=http://localhost:8089
BACKUPS=/var/backups/massgen
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

falhar() {
  echo "::error::$*"
  sudo journalctl -u massgen -u massgen-backup --no-pager | tail -n 60
  exit 1
}

# chamar MÉTODO ROTA [JSON]: imprime o corpo e grava o status em $TMP/status.
# A URL pública é https, então o cookie sai com Secure e o curl não o mandaria por http: ele vai à mão.
chamar() {
  local metodo=$1 rota=$2 corpo=${3:-} cookie
  local args=(-sS -X "$metodo" -o "$TMP/corpo" -D "$TMP/cabecalhos" -w '%{http_code}' -H 'content-type: application/json')
  if [[ -s "$TMP/cookie" ]]; then args+=(-H "cookie: $(cat "$TMP/cookie")"); fi
  if [[ -n "$corpo" ]]; then args+=(--data "$corpo"); fi
  curl "${args[@]}" "$URL$rota" >"$TMP/status"
  cookie="$(grep -i '^set-cookie: massgen_sessao=' "$TMP/cabecalhos" | head -n1 | sed -E 's/^[^:]+: ([^;]*).*/\1/' | tr -d '\r' || true)"
  if [[ -n "$cookie" ]]; then echo "$cookie" >"$TMP/cookie"; fi
  cat "$TMP/corpo"
}

# esperar PADRÃO DESCRIÇÃO: o último status precisa casar com o padrão (por exemplo 200 ou 2..).
esperar() {
  [[ "$(cat "$TMP/status")" =~ ^$1$ ]] || falhar "$2: esperava $1, veio $(cat "$TMP/status") $(cat "$TMP/corpo")"
}

aguardar_app() {
  for _ in $(seq 1 75); do curl -fsS "$URL/saude" >/dev/null 2>&1 && return 0; sleep 0.2; done
  falhar "o app não voltou"
}

echo "1. Primeiro acesso do root, pelo link do console"
link="$(sudo journalctl -u massgen --no-pager | grep -oE "Primeiro acesso de $EMAIL: [^ ]+" | tail -n1 | awk '{print $NF}')"
[[ -n "$link" ]] || falhar "sem link de primeiro acesso no journal"
chamar POST "/convites/${link##*/convite/}" "{\"nome\":\"Root da CI\",\"senha\":\"$SENHA\"}" >/dev/null
esperar 200 "aceite do primeiro acesso"
grep -qiE '^set-cookie: massgen_sessao=[^;]+;.*HttpOnly.*Secure' "$TMP/cabecalhos" || falhar "o cookie de sessão precisa sair HttpOnly e Secure com a URL pública em https"

echo "2. Destino com segredos no cofre, testado contra a API falsa"
destino="$(chamar POST /destinos "{\"nome\":\"Destino da CI\",\"tipoAmbiente\":\"desenvolvimento\",\"baseUrl\":\"$MOCK\",\"pacoteId\":\"splithub\",\"variaveis\":{\"buyer_cnpj\":\"11222333000181\",\"buyer_name\":\"Comprador Exemplo S.A.\",\"buyer_state\":\"SP\"}}" | jq -r .id)"
esperar 201 "criar o destino"
chamar PUT "/destinos/$destino/segredos" '{"chave":"client_id","valor":"massgen"}' >/dev/null
esperar '2..' "gravar client_id"
chamar PUT "/destinos/$destino/segredos" '{"chave":"client_secret","valor":"massgen-segredo"}' >/dev/null
esperar '2..' "gravar client_secret"
[[ "$(chamar POST "/destinos/$destino/testar" | jq -r .ok)" == true ]] || falhar "teste de conexão antes do backup: $(cat "$TMP/corpo")"

echo "3. Backup pelo massgen-backup.service, com o app gravando"
antigo="$BACKUPS/massgen-2000-01-01_000000.tar.gz"
sudo -u massgen touch -d '30 days ago' "$antigo"
(
  for i in $(seq 1 40); do
    curl -s -o /dev/null -X POST -H 'content-type: application/json' --data "{\"email\":\"carga$i@exemplo.com.br\",\"senha\":\"errada-123456\"}" "$URL/sessao"
  done
) &
carga=$!
sudo systemctl start massgen-backup.service
wait "$carga"
sudo journalctl -u massgen-backup --no-pager | tail -n 5
arquivo="$(sudo find "$BACKUPS" -maxdepth 1 -name 'massgen-*.tar.gz' -newer "$TMP/status" | sort | tail -n1)"
[[ -n "$arquivo" ]] || falhar "o backup não gerou arquivo"
echo "Backup: $arquivo"
if sudo test -e "$antigo"; then falhar "a retenção não apagou o backup de 30 dias"; fi
conteudo="$(sudo tar -tzf "$arquivo")"
echo "$conteudo"
for item in massgen.db master.key .env; do grep -qx "$item" <<<"$conteudo" || falhar "o backup não trouxe $item"; done
[[ "$(sudo stat -c '%a %U' "$arquivo")" == "600 massgen" ]] || falhar "o backup precisa ser só do usuário massgen: $(sudo stat -c '%a %U' "$arquivo")"

echo "4. Algo depois do backup, que a restauração precisa desfazer"
depois="$(chamar POST /destinos "{\"nome\":\"Depois do backup\",\"tipoAmbiente\":\"desenvolvimento\",\"baseUrl\":\"$MOCK\"}" | jq -r .id)"
esperar 201 "destino depois do backup"

echo "5. Restauração pelo procedimento do README"
sudo systemctl stop massgen
cd /opt/massgen
sudo -u massgen mv data "data.antes-da-restauracao-$(date +%F)"
sudo -u massgen mkdir data
sudo -u massgen tar -xzf "$arquivo" -C data massgen.db master.key
sudo systemctl start massgen
aguardar_app

echo "6. Conferência: login, destino, cofre e integridade"
rm -f "$TMP/cookie"
chamar POST /sessao "{\"email\":\"$EMAIL\",\"senha\":\"$SENHA\"}" >/dev/null
esperar 200 "login com a senha de antes do backup"
chamar GET "/destinos/$destino" >/dev/null
esperar 200 "destino restaurado"
chamar GET "/destinos/$depois" >/dev/null
esperar 404 "o destino criado depois do backup não pode voltar"
[[ "$(chamar POST "/destinos/$destino/testar" | jq -r .ok)" == true ]] || falhar "o cofre não abriu depois da restauração: $(cat "$TMP/corpo")"
integridade="$(chamar GET /auditoria/integridade)"
[[ "$(jq -r '.auditoria.ok and .requisicoes.ok' <<<"$integridade")" == true ]] || falhar "integridade depois da restauração: $integridade"

echo "Backup e restauração conferidos."

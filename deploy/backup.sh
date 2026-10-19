#!/usr/bin/env bash
# Backup do MassGen: cópia consistente do banco SQLite e a chave do cofre, num .tar.gz com data e hora.
#
# O banco roda em modo WAL: copiar massgen.db com cp, com o app gravando, pode pegar um retrato pela metade.
# O .backup do sqlite3 usa a API de backup online do SQLite e sempre entrega um banco inteiro.
# Sem a chave (data/master.key ou MASSGEN_MASTER_KEY no .env), os segredos do cofre não abrem: vão juntos.
#
# Roda como o usuário massgen, pelo timer do systemd (deploy/massgen-backup.timer), ou à mão:
#   sudo -u massgen /opt/massgen/deploy/backup.sh
#
# Variáveis (todas opcionais; o timer carrega o .env do app):
#   MASSGEN_DIR                   pasta do app                         (padrão: /opt/massgen)
#   MASSGEN_DATA_DIR              pasta do banco, relativa ao app      (padrão: data)
#   MASSGEN_BACKUP_DIR            onde os backups ficam                (padrão: /var/backups/massgen)
#   MASSGEN_BACKUP_RETENCAO_DIAS  backups mais velhos que isso saem    (padrão: 14)
set -euo pipefail
umask 077

MASSGEN_DIR="${MASSGEN_DIR:-/opt/massgen}"
DADOS="${MASSGEN_DATA_DIR:-data}"
[[ "$DADOS" = /* ]] || DADOS="$MASSGEN_DIR/$DADOS"
DESTINO="${MASSGEN_BACKUP_DIR:-/var/backups/massgen}"
RETENCAO_DIAS="${MASSGEN_BACKUP_RETENCAO_DIAS:-14}"

falhar() { echo "Backup do MassGen falhou: $*" >&2; exit 1; }

command -v sqlite3 >/dev/null || falhar "sqlite3 não encontrado. Instale com: sudo apt install sqlite3"
[[ -f "$DADOS/massgen.db" ]] || falhar "banco não encontrado em $DADOS/massgen.db"
[[ "$RETENCAO_DIAS" =~ ^[0-9]+$ ]] || falhar "MASSGEN_BACKUP_RETENCAO_DIAS precisa ser um número de dias"
mkdir -p "$DESTINO"

carimbo="$(date +%Y-%m-%d_%H%M%S)"
arquivo="$DESTINO/massgen-$carimbo.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; rm -f "$arquivo.parcial"' EXIT

# 1. Banco: cópia consistente, mesmo com o app no ar. O timeout espera uma gravação em curso terminar.
sqlite3 -cmd ".timeout 10000" "$DADOS/massgen.db" ".backup '$tmp/massgen.db'"
verificacao="$(sqlite3 "$tmp/massgen.db" 'PRAGMA integrity_check;')"
[[ "$verificacao" == "ok" ]] || falhar "a cópia do banco não passou no integrity_check: $verificacao"

# 2. Chave do cofre e .env (onde pode estar MASSGEN_MASTER_KEY, além da configuração do app).
itens=(massgen.db)
if [[ -f "$DADOS/master.key" ]]; then cp -p "$DADOS/master.key" "$tmp/master.key"; itens+=(master.key); fi
if [[ -f "$MASSGEN_DIR/.env" ]]; then cp -p "$MASSGEN_DIR/.env" "$tmp/.env"; itens+=(.env); fi
if [[ ! -f "$tmp/master.key" && -z "${MASSGEN_MASTER_KEY:-}" ]]; then
  echo "Aviso: sem $DADOS/master.key e sem MASSGEN_MASTER_KEY. Se houver segredos no cofre, eles não abrem com este backup." >&2
fi

# 3. Empacota (o nome final só aparece com o arquivo completo) e aplica a retenção.
tar -czf "$arquivo.parcial" -C "$tmp" "${itens[@]}"
mv "$arquivo.parcial" "$arquivo"
find "$DESTINO" -maxdepth 1 -name 'massgen-*.tar.gz' -mtime "+$RETENCAO_DIAS" -delete

echo "Backup gravado em $arquivo ($(du -h "$arquivo" | cut -f1)). Retenção: $RETENCAO_DIAS dias."

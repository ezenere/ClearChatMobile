#!/usr/bin/env bash
# Servidor de sync LOCAL para os testes de integração e o E2E no emulador (nunca produção).
#   scripts/test-server.sh up      → Postgres descartável no Docker (tmpfs, sem volume) + migrações + API
#   scripts/test-server.sh down    → para a API e remove o contêiner (os dados somem junto)
#   scripts/test-server.sh status
# A API roda o backend de ../ClearChatWebsite/backend em 127.0.0.1:$PORT com MAIL_BACKEND=console
# (os códigos de login vão para $DIR/api.log) e sem captcha. A configuração é só por variáveis de
# ambiente, rodando de uma pasta própria: o .env do repositório do site nunca é lido.
#
# Variáveis:
#   CLEARCHAT_SERVER_PYTHON  Python ≥ 3.12 com as dependências do backend
#                            (padrão: ../ClearChatWebsite/backend/.venv/bin/python — `make -C ../ClearChatWebsite/backend venv`)
#   CLEARCHAT_TEST_DIR       pasta de trabalho (log, pid, blobs) — padrão: ${TMPDIR:-/tmp}/clearchat-mobile-test
#   PORT (8100), DB_PORT (55433), DB_CONTAINER (clearchat-mobile-test-db)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$(cd "$ROOT/../ClearChatWebsite/backend" && pwd)"
PY="${CLEARCHAT_SERVER_PYTHON:-$BACKEND/.venv/bin/python}"
DIR="${CLEARCHAT_TEST_DIR:-${TMPDIR:-/tmp}/clearchat-mobile-test}"
PORT="${PORT:-8100}"
DB_PORT="${DB_PORT:-55433}"
DB_CONTAINER="${DB_CONTAINER:-clearchat-mobile-test-db}"

server_env() {
  export PUBLIC_BASE_URL="http://127.0.0.1:$PORT"
  export DATABASE_URL="postgresql+asyncpg://postgres@127.0.0.1:$DB_PORT/clearchat"
  export MAIL_BACKEND=console TURNSTILE_SITE_KEY= TURNSTILE_SECRET_KEY= ADMIN_TOKEN=
  export INSTANCE_NAME="ClearChat (teste local)" INITIAL_SIGNUP_OPEN=true
  export BLOB_STORAGE_DIR="$DIR/blobs"
  export PYTHONPATH="$BACKEND" PYTHONPYCACHEPREFIX="$DIR/pycache" PYTHONUNBUFFERED=1
  if [[ ! -s "$DIR/secret" ]]; then head -c 48 /dev/urandom | base64 | tr -d '\n' > "$DIR/secret"; fi
  SERVER_SECRET="$(cat "$DIR/secret")"
  export SERVER_SECRET
}

up() {
  [[ -x "$PY" ]] || { echo "Python do backend não encontrado: $PY (defina CLEARCHAT_SERVER_PYTHON)" >&2; exit 1; }
  mkdir -p "$DIR/cwd" "$DIR/blobs"
  if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    docker run -d --rm --name "$DB_CONTAINER" -p "127.0.0.1:$DB_PORT:5432" \
      --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=clearchat \
      postgres:17-alpine >/dev/null
  fi
  for _ in $(seq 1 60); do
    docker exec "$DB_CONTAINER" pg_isready -U postgres -d clearchat >/dev/null 2>&1 && break
    sleep 0.5
  done
  server_env
  cd "$DIR/cwd"
  "$PY" -m clearchat_server migrate
  if [[ -f "$DIR/api.pid" ]] && kill -0 "$(cat "$DIR/api.pid")" 2>/dev/null; then
    echo "API já está rodando (pid $(cat "$DIR/api.pid"))"
  else
    : > "$DIR/api.log"
    nohup "$PY" -m uvicorn clearchat_server.main:app --host 127.0.0.1 --port "$PORT" \
      --ws-max-size 16777216 >> "$DIR/api.log" 2>&1 &
    echo $! > "$DIR/api.pid"
    for _ in $(seq 1 60); do
      curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1 && break
      sleep 0.5
    done
  fi
  curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null
  echo "API em http://127.0.0.1:$PORT — log (com os códigos): $DIR/api.log"
  echo "  export CLEARCHAT_SYNC_TEST_URL=http://127.0.0.1:$PORT CLEARCHAT_SYNC_TEST_MAIL_LOG=$DIR/api.log"
}

down() {
  if [[ -f "$DIR/api.pid" ]]; then
    kill "$(cat "$DIR/api.pid")" 2>/dev/null || true
    rm -f "$DIR/api.pid"
  fi
  docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$DIR/blobs" "$DIR/pycache" "$DIR/secret"
  echo "servidor de teste parado (contêiner $DB_CONTAINER removido)"
}

status() {
  if [[ -f "$DIR/api.pid" ]] && kill -0 "$(cat "$DIR/api.pid")" 2>/dev/null; then
    echo "API: rodando (pid $(cat "$DIR/api.pid")), log $DIR/api.log"
  else
    echo "API: parada"
  fi
  docker inspect -f 'Postgres: {{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || echo "Postgres: ausente"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "uso: $0 up|down|status" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Roda o EAS CLI (versão fixa) com a MESMA chave de upload do build local.
#
#   scripts/eas.sh <args do eas>          ex.: scripts/eas.sh build -p android -e production --auto-submit
#
# eas.json usa credentialsSource "local": o EAS lê ./credentials.json. Este script cria esse arquivo
# a partir de ~/.android/clearchat-release.properties (ou CLEARCHAT_SIGNING_PROPS), só durante o
# comando, e apaga ao sair — a senha não fica no projeto (e credentials.json está no .gitignore).
set -euo pipefail
cd "$(dirname "$0")/.."

EAS_VERSION=27.5.0
PROPS="${CLEARCHAT_SIGNING_PROPS:-$HOME/.android/clearchat-release.properties}"

if [[ -e credentials.json ]]; then
  echo "credentials.json já existe no projeto — apague (ou mova) antes; não sobrescrevo." >&2
  exit 1
fi

if [[ -f "$PROPS" ]]; then
  trap 'rm -f credentials.json' EXIT
  (umask 077 && node -e '
    const fs = require("fs")
    const p = Object.fromEntries(
      fs.readFileSync(process.argv[1], "utf8").split("\n")
        .filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
    )
    for (const k of ["storeFile", "storePassword", "keyAlias", "keyPassword"])
      if (!p[k]) throw new Error("falta " + k + " em " + process.argv[1])
    fs.writeFileSync("credentials.json", JSON.stringify({ android: { keystore: {
      keystorePath: p.storeFile, keystorePassword: p.storePassword, keyAlias: p.keyAlias, keyPassword: p.keyPassword
    } } }, null, 2))
  ' "$PROPS")
elif [[ "${1:-}" == "build" ]]; then
  echo "sem chave de assinatura: rode  npm run build:apk -- --init" >&2
  exit 1
fi

# Build --local roda o Gradle aqui: mesmo ajuste de JDK do build-apk.sh.
if [[ -z "${JAVA_HOME:-}" ]]; then
  jbr="$(ls -d /opt/android-studio*/jbr "$HOME"/android-studio*/jbr 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$jbr" ]] && export JAVA_HOME="$jbr"
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"

npx -y "eas-cli@$EAS_VERSION" "$@"

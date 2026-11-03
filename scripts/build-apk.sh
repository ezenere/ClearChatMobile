#!/usr/bin/env bash
# APK release assinado, 100% local — sem conta Expo/EAS.
#
#   scripts/build-apk.sh --init       cria a chave de assinatura (uma vez só; GUARDE O BACKUP)
#   scripts/build-apk.sh              gera dist/ClearChat-<versão>.apk (arm64-v8a)
#   scripts/build-apk.sh --install    idem + adb install -r no aparelho conectado
#
# Variáveis: ABIS (padrão arm64-v8a; ex. "arm64-v8a,armeabi-v7a" ou "x86_64" p/ emulador),
# CLEARCHAT_SIGNING_PROPS (padrão ~/.android/clearchat-release.properties),
# CLEARCHAT_KEYSTORE_PASSWORD (só no --init, para rodar sem prompt).
#
# A chave e a senha ficam FORA do repositório. Perder a chave = não dá mais para atualizar o app
# instalado (Android exige a mesma assinatura); só desinstalando, o que apaga os dados locais.
set -euo pipefail
cd "$(dirname "$0")/.."

PROPS="${CLEARCHAT_SIGNING_PROPS:-$HOME/.android/clearchat-release.properties}"
ABIS="${ABIS:-arm64-v8a}"

init() {
  if [[ -e "$PROPS" ]]; then
    echo "já existe: $PROPS — não sobrescrevo (apague à mão se quiser recriar)." >&2
    exit 1
  fi
  local dir store pass pass2
  dir="$(dirname "$PROPS")"
  store="$dir/clearchat-release.jks"
  if [[ -e "$store" ]]; then
    echo "já existe: $store — não sobrescrevo." >&2
    exit 1
  fi
  mkdir -p "$dir"
  if [[ -n "${CLEARCHAT_KEYSTORE_PASSWORD:-}" ]]; then
    pass="$CLEARCHAT_KEYSTORE_PASSWORD"
  else
    read -rsp "Senha da chave (mín. 6): " pass; echo
    read -rsp "Repita: " pass2; echo
    [[ "$pass" == "$pass2" ]] || { echo "senhas diferentes" >&2; exit 1; }
  fi
  [[ ${#pass} -ge 6 ]] || { echo "senha curta demais" >&2; exit 1; }
  # PKCS12: a senha da chave é a mesma do keystore.
  KS_PASS="$pass" keytool -genkeypair -keystore "$store" -storetype PKCS12 -alias clearchat \
    -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=ClearChat" \
    -storepass:env KS_PASS -keypass:env KS_PASS
  chmod 600 "$store"
  umask 077
  {
    echo "storeFile=$store"
    echo "storePassword=$pass"
    echo "keyAlias=clearchat"
    echo "keyPassword=$pass"
  } >"$PROPS"
  chmod 600 "$PROPS"
  echo "chave criada: $store"
  echo "config:       $PROPS"
  echo "Faça backup dos DOIS arquivos (e da senha) num lugar seguro."
}

build() {
  [[ -f "$PROPS" ]] || { echo "sem chave de assinatura: rode  scripts/build-apk.sh --init" >&2; exit 1; }
  # O Gradle não roda no JDK mais novo do sistema: sem JAVA_HOME, usa o JBR do Android Studio.
  if [[ -z "${JAVA_HOME:-}" ]]; then
    local jbr
    jbr="$(ls -d /opt/android-studio*/jbr "$HOME"/android-studio*/jbr 2>/dev/null | sort -V | tail -1 || true)"
    [[ -n "$jbr" ]] && export JAVA_HOME="$jbr"
  fi
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
  npx expo prebuild --platform android --no-install >/dev/null
  grep -q 'clearchat:release-signing' android/app/build.gradle \
    || { echo "o plugin de assinatura não entrou no build.gradle (rode npx expo prebuild --clean)" >&2; exit 1; }
  (cd android && CLEARCHAT_SIGNING_PROPS="$PROPS" ./gradlew assembleRelease \
    -PreactNativeArchitectures="$ABIS" --console=plain -q)
  local apk version out sdk apksigner
  apk=android/app/build/outputs/apk/release/app-release.apk
  [[ -f "$apk" ]] || { echo "APK assinado não gerado (veja o log do Gradle)" >&2; exit 1; }
  version="$(node -p "require('./app.json').expo.version")"
  mkdir -p dist
  out="dist/ClearChat-$version.apk"
  cp "$apk" "$out"
  sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
  apksigner="$(ls -d "$sdk"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$apksigner" ]]; then
    "$apksigner" verify --print-certs "$out" | grep -E 'certificate (DN|SHA-256)' | sort -u || true
  fi
  echo "pronto: $out ($(du -h "$out" | cut -f1), ABIs: $ABIS)"
  if [[ "${1:-}" == "--install" ]]; then
    local adb
    adb="$(command -v adb || echo "$sdk/platform-tools/adb")"
    "$adb" install -r "$out"
  fi
}

case "${1:-}" in
  --init) init ;;
  ""|--install) build "${1:-}" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac

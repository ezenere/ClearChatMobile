#!/usr/bin/env bash
# APK/AAB release assinado, 100% local (o Gradle roda aqui; não precisa do EAS para gerar).
#
#   scripts/build-apk.sh --init       cria a chave de assinatura (uma vez só; GUARDE O BACKUP)
#   scripts/build-apk.sh              gera dist/ClearChat-<versão>.apk (arm64-v8a)
#   scripts/build-apk.sh --install    idem + adb install -r no aparelho conectado
#   scripts/build-apk.sh --aab        sobe o versionCode e gera dist/ClearChat-<versão>-<code>.aab
#                                     (Play Store; todas as ABIs) — envie com  npm run submit:android
#
# Variáveis: ABIS (APK: padrão arm64-v8a; ex. "arm64-v8a,armeabi-v7a" ou "x86_64" p/ emulador),
# CLEARCHAT_SIGNING_PROPS (padrão ~/.android/clearchat-release.properties),
# CLEARCHAT_KEYSTORE_PASSWORD (só no --init, para rodar sem prompt).
#
# A chave e a senha ficam FORA do repositório. Perder a chave = não dá mais para atualizar o app
# instalado (Android exige a mesma assinatura); só desinstalando, o que apaga os dados locais.
set -euo pipefail
cd "$(dirname "$0")/.."

PROPS="${CLEARCHAT_SIGNING_PROPS:-$HOME/.android/clearchat-release.properties}"
ABIS_SET="${ABIS:-}"
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
  local mode="${1:-}" task kind out version vcode
  if [[ "$mode" == "--aab" ]]; then
    task=bundleRelease kind=aab
    # A Play exige versionCode crescente a cada envio: sobe no app.json (fonte única; o EAS faz igual).
    vcode="$(node -e '
      const fs = require("fs"); const a = JSON.parse(fs.readFileSync("app.json"))
      a.expo.android.versionCode = (a.expo.android.versionCode ?? 0) + 1
      fs.writeFileSync("app.json", JSON.stringify(a, null, 2) + "\n"); console.log(a.expo.android.versionCode)')"
    echo "versionCode → $vcode (app.json; faça commit)"
  else
    task=assembleRelease kind=apk
  fi
  npx expo prebuild --platform android --no-install >/dev/null
  grep -q 'clearchat:release-signing' android/app/build.gradle \
    || { echo "o plugin de assinatura não entrou no build.gradle (rode npx expo prebuild --clean)" >&2; exit 1; }
  (cd android && CLEARCHAT_SIGNING_PROPS="$PROPS" ./gradlew "$task" \
    -PreactNativeArchitectures="$ABIS" --console=plain -q)
  local built sdk apksigner
  if [[ "$kind" == aab ]]; then
    built=android/app/build/outputs/bundle/release/app-release.aab
  else
    built=android/app/build/outputs/apk/release/app-release.apk
  fi
  [[ -f "$built" ]] || { echo "$kind assinado não gerado (veja o log do Gradle)" >&2; exit 1; }
  version="$(node -p "require('./app.json').expo.version")"
  vcode="$(node -p "require('./app.json').expo.android.versionCode ?? 1")"
  mkdir -p dist
  out="dist/ClearChat-$version-$vcode.$kind"
  cp "$built" "$out"
  sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
  if [[ "$kind" == aab ]]; then
    keytool -printcert -jarfile "$out" 2>/dev/null | grep -E 'Owner:|SHA256:' | sort -u || true
  else
    apksigner="$(ls -d "$sdk"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
    if [[ -n "$apksigner" ]]; then
      "$apksigner" verify --print-certs "$out" | grep -E 'certificate (DN|SHA-256)' | sort -u || true
    fi
  fi
  echo "pronto: $out ($(du -h "$out" | cut -f1), ABIs: $ABIS)"
  if [[ "$mode" == "--install" ]]; then
    local adb
    adb="$(command -v adb || echo "$sdk/platform-tools/adb")"
    "$adb" install -r "$out"
  fi
}

case "${1:-}" in
  --init) init ;;
  --aab) ABIS="${ABIS_SET:-armeabi-v7a,arm64-v8a,x86,x86_64}" build --aab ;;
  ""|--install) build "${1:-}" ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac

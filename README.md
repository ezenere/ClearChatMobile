# ClearChat Mobile

Cliente Android (iOS depois) do protocolo de sync do ClearChat, em **Expo SDK 58 / React Native 0.88**
(Hermes, New Architecture), TypeScript estrito e expo-router. Plano e fases: [`docs/PLAN.md`](docs/PLAN.md).
Regras do repositório: [`CLAUDE.md`](CLAUDE.md).

Os repositórios irmãos ficam ao lado deste (`../ClearChatDesktop`, `../ClearChatWebsite`) e o contrato
canônico em `../docs/` (`SYNC_PROTOCOL.md` + `test-vectors/`).

## Ambiente

```sh
export JAVA_HOME=/opt/android-studio-quail3/jbr   # JDK 25 (o JDK 27 do sistema é novo demais para o Gradle)
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH
```

Node ≥ 22 e `npm install`.

## Comandos

| Comando                                   | O quê                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `npm run typecheck`                       | `tsc` do app (inclui `src/vendor/`) e dos testes                      |
| `npm run lint`                            | ESLint (config do Expo) + Prettier (`--check`)                        |
| `npm test`                                | Vitest (Node): todos os vetores + testes da camada de plataforma      |
| `npm run vendor` / `npm run vendor:check` | copia / confere as cópias de `src/vendor/` (falha em qualquer desvio) |
| `npm run prebuild`                        | gera `android/` (`expo prebuild --platform android`)                  |
| `npm start`                               | Metro (bundler)                                                       |
| `npm run android`                         | `expo run:android`: compila, instala no aparelho/emulador e abre      |

### Build e emulador

```sh
emulator -avd Pixel_9_Pro -no-snapshot-save -no-audio &        # -no-window para rodar sem janela
npm run prebuild
npx expo run:android                                             # ou, à mão:
cd android && ./gradlew assembleDebug -PreactNativeArchitectures=x86_64 && cd ..
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081 && npm start                       # o build debug carrega o JS do Metro
```

`android/` **não** é versionado (CNG — Continuous Native Generation): tudo o que é nativo vem do
`app.json`, de plugins e do módulo local `modules/argon2`; `npx expo prebuild --clean` regenera. Se um
ajuste nativo não couber num config plugin, reavaliar.

### Self-test da cripto no aparelho

Só em build de desenvolvimento. Roda todos os vetores do protocolo + checagens da plataforma e mede o
Argon2id de produção e o AES-GCM de 1 MiB:

```sh
adb shell am start -a android.intent.action.VIEW -d clearchat://dev/selftest
adb logcat -s ReactNativeJS | grep CLEARCHAT_SELFTEST           # linha de resumo (PASS/FAIL, contagens, tempos)
```

## Vendorização (`src/vendor/`)

Código compartilhado é **copiado** dos repositórios irmãos por `scripts/vendor.mjs` (lista explícita; os
imports relativos e `@shared/...` são seguidos automaticamente para nada ficar pendurado):

- `protocol/` ← `../docs`: `SYNC_PROTOCOL.md` e `test-vectors/*.json` (bytes idênticos);
- `site/crypto/` ← `../ClearChatWebsite/frontend/src/crypto` (cripto do protocolo, sem os testes);
- `shared/` ← `../ClearChatDesktop/src/shared` (tipos e módulos puros + fecho transitivo);
- `desktop/sync/` ← `../ClearChatDesktop/src/main/sync/{http,ws,stream}.ts`.

Cada `.ts` ganha uma linha de cabeçalho `// VENDORED from …`; nunca edite à mão — corrija na origem e rode
`npm run vendor`. O `vendor:check` (ignorando o cabeçalho) falha em qualquer divergência, arquivo ausente
ou sobrando.

## Camada de plataforma (`src/platform/`)

O Hermes não tem WebCrypto, `CompressionStream` nem WebAssembly. Os arquivos vendorados rodam **sem
alteração**; a camada supre o que falta (instalada por `index.ts` antes do expo-router):

| Falta no Hermes                                        | Solução                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.subtle` (AES-256-GCM, HKDF, HMAC, SHA-256)     | `subtle.ts`: subconjunto do WebCrypto em JS puro sobre `@noble/ciphers` + `@noble/hashes`, instalado em `globalThis.crypto`                                                                                                                                                                                                                                   |
| `crypto.getRandomValues` / `randomUUID`                | `expo-crypto` (CSPRNG do SO)                                                                                                                                                                                                                                                                                                                                  |
| `CompressionStream('deflate-raw')` + `Blob.stream()`   | `primitives.ts`: o resolver (Metro e Vitest, `scripts/platformAliases.cjs`) redireciona o `./primitives` dos módulos de `src/vendor/site/crypto` para uma versão que reexporta tudo e troca só `deflateRaw`/`inflateRaw` por `fflate` (com teto incremental contra zip bomb). Shimar streams no Hermes seria frágil (o `Blob` do RN não aceita `ArrayBuffer`) |
| Argon2id do `hash-wasm` (WebAssembly)                  | `hash-wasm` → `hashWasm.ts` (mesma interface `argon2id({...})`, mesma saída) com backend nativo: módulo Expo local `modules/argon2` sobre **argon2kt 1.6.0** (referência phc-winner-argon2 em C via JNI, `.so` alinhadas a 16 KB), fora da thread do JS                                                                                                       |
| `TextDecoder` com `fatal`                              | `textCodec.ts` (só instala se faltar ou não for estrito)                                                                                                                                                                                                                                                                                                      |
| URL do WHATWG (a do RN é aproximada por regex)         | `react-native-url-polyfill`                                                                                                                                                                                                                                                                                                                                   |
| `AbortSignal.any` / `timeout`                          | `abort.ts` (o RN 0.88 já tem; só cobre runtimes antigos)                                                                                                                                                                                                                                                                                                      |
| `node:crypto` (`randomUUID` no `stream.ts` do desktop) | `nodeCrypto.ts` (paths do tsconfig + resolver)                                                                                                                                                                                                                                                                                                                |

Nos testes (`tests/setup.ts`) o WebCrypto do Node é **trocado** pelo shim, `CompressionStream` é removido e
o backend do Argon2 é o `hash-wasm` real — os vetores exercitam o mesmo código que roda no aparelho. O
Argon2 nativo é validado no aparelho pelo self-test (mesma saída do hash-wasm, byte a byte).

## Estrutura

```
index.ts               entrada: camada de plataforma → expo-router
modules/argon2/        módulo Expo local (Kotlin + argon2kt)
scripts/               vendor.mjs, platformAliases.cjs (redirecionamentos Metro/Vitest)
src/app/               telas (expo-router); dev/selftest.tsx
src/crypto/            cripto do protocolo para o app (reexporta a vendorada)
src/platform/          polyfills e trocas para o Hermes
src/selftest/          casos dos vetores + checagens da plataforma (Vitest e aparelho)
src/ui/                tema (tokens do desktop)
src/vendor/            cópias geradas — não editar
tests/                 Vitest
```

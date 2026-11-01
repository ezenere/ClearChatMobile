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
| `npm test`                                | Vitest (Node): vetores, plataforma, conta e sync (servidor falso)     |
| `npm run test:integration`                | conta e dados contra o servidor REAL local (pulado sem as variáveis)  |
| `npm run test-server -- up\|down\|status` | servidor de sync local para testes (Docker + backend do site)         |
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

Sem `watchman` instalado, o watcher do Metro pode perder edições (as rotas são carregadas sob demanda
e continuam com o código velho): se o app não refletir uma mudança, reinicie com `npx expo start --clear`.

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

## Conta (fase 1)

Login por código, registro do dispositivo, chaves e sessão ficam em `src/account/` (sem React Native no
núcleo — testável no Node):

- `session.ts` — máquina de estados pura (`boot → signed-out → needs-setup → locked → unlocked`) e os
  avisos de fim de sessão; `service.ts` — `AccountService` (servidor, código por e-mail, setup/desbloqueio/
  recuperação, refresh rotativo no corpo via `SyncHttp` vendorado, WebSocket via `RealtimeClient`
  vendorado só para `device_revoked`/`keys.changed`/`keys.reset`/`account.deleted`, primeiro/segundo
  plano); `native.ts` — implementações do aparelho e a instância única; `captcha.ts` — §15 (nonce, URL,
  interceptação do `/captcha/done`).
- **Onde fica cada coisa**: tokens e DEK só no `expo-secure-store` (Keystore; tokens gravados de forma
  **síncrona** porque o refresh rotaciona e reusar o antigo revoga o aparelho); o resto (servidor escolhido,
  e-mail, ids, wraps em cache, preferências) no `expo-sqlite/kv-store` — nada disso é segredo.
- "Lembrar neste dispositivo" (padrão ligado) guarda a DEK; "Exigir biometria" aparece só com biometria
  cadastrada (`requireAuthentication` do SecureStore, entrada separada; prompt cancelado → pede a senha).
  Bloquear apaga a DEK guardada; Sair revoga o aparelho (`POST /auth/logout`) e apaga tudo.
- Rotas (`src/app`): `/` decide pela fase; `(auth)` = `login`, `code`, `server`, `captcha`, `setup`,
  `unlock`, `recover` (cada fase libera só as suas via `Stack.Protected`); `(app)` = `home`,
  `recovery-key`. Componentes em `src/ui/` (botões, campos, código de 6 dígitos, cartões, banners,
  diálogo, toast, chave de recuperação, senha nova com medidor).
- `EXPO_PUBLIC_CLEARCHAT_SYNC_URL` fixa o servidor (desenvolvimento), como o `CLEARCHAT_SYNC_URL` do desktop.

## Dados (fase 2)

Sem React Native no núcleo (`src/data/`, testável no Node com `node:sqlite`):

- `store.ts` — cache no `expo-sqlite` (`clearchat-cache.db`): `records` (tipo, id, escopo, rev, seq,
  tombstone, plaintext JSON; tipos desconhecidos/envelopes novos ficam opacos; o que não decifra fica
  marcado e nunca aparece), `meta` (cursor, dono = servidor + usuário, último sync) e índices derivados:
  `chats` (título, ordem por `updatedAt`, persona, prévia da última mensagem do **caminho ativo** da
  sessão principal), `messages` + `messages_fts` (FTS5, `unicode61 remove_diacritics` — busca sem acento
  no conteúdo, com trecho destacado) e `chat_states` (host/janela, §8.2). Migrações por `PRAGMA user_version`.
- `engine.ts` — `SyncEngine`: pull paginado pelo cursor (§7.3, `payload=1`, `records/fetch` para os
  `omitted`), uma transação por página, revisão menor ignorada, cascata do chat/coleção (§7.7), resync
  completo no `410` (§7.9: `GET /records` paginado, apaga o que sumiu, cursor = head); `sync.changes` do
  WebSocket aplicado direto quando continua exatamente do cursor (senão puxa — §10.2/10.3); `chat.state` e
  `welcome.chat_states`; primitivo de escrita LWW (`saveLww`/`remove`, §7.4–7.5: `push_id` estável nas
  retentativas de rede, `rev_mismatch` → reaplica só os campos alterados sobre a versão do servidor,
  `gone` → a exclusão vence, `chat_busy`/cota com texto em pt-BR). Nesta fase só renomear/apagar chat
  usam escrita (online; sem outbox — fases 3/5). Primeiro plano → puxa de novo.
- `attachments.ts` — `clearchat-attachment://<sha256>.<ext>` → `blob_id` → `GET /blobs/{id}` → CCB1 →
  confere o SHA-256 → grava em `Documents/attachments/` (escrita atômica); downloads deduplicados.
- `binding.ts` — liga ao `AccountService`: desbloqueado → sincroniza; bloqueado → para (o cache fica);
  saiu/revogado/conta apagada/`keys.reset`/outra conta ou servidor → apaga o cache e os anexos.

**Decisão — plaintext no cache.** Decifrar uma vez e guardar o JSON em claro no SQLite privado do app
(o aparelho é do usuário; Android: sandbox do app, sem backup — `configureAndroidBackup`). Assim lista,
busca e conversa abrem sem cripto. O cache some no logout, na revogação, no `keys.reset` e na troca de
conta/servidor; **bloquear não apaga** (o cofre pede a senha, mas os dados ficam no armazenamento do
app). Evolução possível: SQLCipher do `expo-sqlite` com chave derivada da DEK (bloquear = cifrado em repouso).

**AES-GCM nativo.** O `primitives.ts` da plataforma troca `gcmEncrypt`/`gcmDecrypt` pelo AES-GCM do
`expo-crypto` no aparelho — só depois de uma resposta conhecida idêntica ao noble (cifra, decifra e
recusa adulteração); senão continua no JS. O self-test roda todos os vetores (registros e blobs CCB1)
pelo caminho nativo e compara com o noble em tamanhos variados. Pixel 9 Pro (AVD x86_64): blob de 1 MiB
decifrado em **19 ms nativo × 1616 ms em JS** — por isso o pull decifra tudo na hora (cede a thread a cada
~12 ms) em vez de adiar.

**Telas** (`src/chat/`, `src/app/(app)/`): lista (`chats.tsx`, FlashList; busca; puxar para atualizar;
indicador "Ao vivo/Sincronizando/Offline"; carregando/vazio/offline; toque longo → renomear/apagar) e
conversa (`chat/[id].tsx`, FlashList com linhas memorizadas, abre no fim e segue o fim enquanto imagens
carregam). `viewModel.ts` (puro) monta o caminho ativo pelo algoritmo normativo (`branchView` vendorado),
o ‹ i/n › que troca a versão **só na tela** (cai quando o `branchSel` sincronizado muda), separadores de
dia e a fronteira de compactação. `MessageRow.tsx`/`ToolCard.tsx` seguem o MessageList do desktop:
balões, raciocínio recolhível, cards de tool (resumo, tamanho, ok/erro/negada, aprovação com detalhes,
delegate com "Abrir subsessão", send_to_chat, questionário respondido, mídia), resumo de compactação,
erro, marcadores de chamada e falas, mensagens entre chats/agente pai/irmãos, resultado de subagente,
extração de memória e o rodapé (modelo, tokens in/out, cache, raciocínio, custo, duração). Markdown:
`marked` (lexer GFM) + renderizador próprio em componentes nativos (`Markdown.tsx`): código com
linguagem, cópia e rolagem horizontal, tabelas roláveis, listas/citações/títulos; fórmulas `$…$`/`$$…$$`
em monoespaçado (sem KaTeX); sem HTML cru nem imagens remotas (viram link); imagem de anexo vira o anexo.
Anexos: miniatura (expo-image) → tela cheia com pinça/duplo toque e compartilhar; PDF/outros abrem no
visualizador do sistema (`File.preview`) ou na folha de compartilhamento.

## Controle remoto (fase 3)

Núcleo sem React Native em `src/remote/` (testável no Node):

- `crypto.ts` — envelopes do stream e dos comandos com `K_stream` e as AADs de stream/comando/resultado
  (§3.10), moldura com deflate acima de 1 KiB; conferido byte a byte nos vetores `realtime.json`.
- `mirror.ts` — `LiveMirror`: espelho ao vivo de um chat (porta da metade "controle remoto" do
  `HostController` do desktop): `snapshot` completo, `draft.delta` (via `stream.ts` vendorado), `n`
  contíguo por epoch (buraco/delta fora de ordem → `stream.resync`), drafts encerrados que ficam na tela
  até a mensagem persistida chegar (teto de 8 s), status ao vivo por sessão, `branchSel` ao vivo, tools
  (rodando/Smart-Approve avaliando/saída), fila, aprovações, questionários, retries, compactação,
  processos, skills do host e erros. `liveStatus` = status a exibir (espelho → transitório com janela).
- `controller.ts` — `RemoteController`: modo do host por chat (`remote`/`host-offline`/`none`/`local`/
  `offline`/`diverged`, §8.2), inscrição no stream do chat aberto (`stream.subscribe`/`unsubscribe`,
  `hello.subscriptions` na reconexão, `stream.resync` no welcome e quando o host volta), eventos
  decifrados em série, avisos "O dispositivo remoto (X) caiu"/"voltou"; cliente de comandos para TODOS os
  kinds do §8.6 (um método por kind; `regenerate` sai como `branch.regenerate`), `cmd_id` novo por
  comando, timeout de 40 s, `remote.failed` e queda da conexão viram erro claro, recusas do host
  (`attachment_missing`, `chat_busy`, `not_host`, versão antiga, `message.edit` numa mensagem digitada…)
  em pt-BR; `fs.list`/`fs.read` com as mesmas validações do desktop; `host.pin`; "Descartar a versão de
  <D>" (`divergence/resolve` com `keep: 'online'`, a única resolução segura no celular).
- `upload.ts` — anexos: classifica como o desktop (`classifyAttachment`), grava `<sha256>.<ext>` no store,
  `blob_id` = HMAC do sha256, `POST /blobs/check` e `PUT /blobs/{id}` (CCB1, `X-Content-SHA256` do
  ciphertext) **antes** do `send` (§14).
- `files.ts` — leitura em pedaços (3 em voo, tamanho/mtime conferidos a cada pedaço, corte de UTF-8).
- `binding.ts`/`native.ts`/`react.ts` — liga ao WebSocket da conta (`AccountService.wsRequest`,
  `helloSubscriptions`) e ao motor (mensagens novas trocam o draft); `useRemoteChat(chatId)`.

Telas: a conversa (`chat/[id].tsx`) troca o rodapé somente leitura pelo **composer** com o host online
(`src/chat/remote/Composer.tsx`: texto, anexos da galeria/arquivo com upload antecipado, lâmpada com as
skills do host, enviar/“adicionar à fila”, ⚡ forçar — botão ou toque longo no enviar —, parar, fila com
⚡/✕, linha de status "Trabalhando…/Executando Terminal…/Aguardando aprovação…"); resposta ao vivo como
última linha da lista (raciocínio, Markdown e tool calls atualizando no lugar, segue o fim se você não
rolou); cards (`Panels.tsx`): aprovação (simples ou por sub-comando no modo Listas, "Sim para todos",
"⋯" → whitelist/blacklist com o padrão editável, veredito do Smart-Approve, "1 de N", vibração),
questionário no lugar do composer (passo a passo, ícones lucide→Ionicons/emoji/imagem, ajuda em folha,
imagem grande, múltipla escolha, "Outro") e falha de conexão; "Executar mesmo assim" (smart_override) no
card da tool negada; faixa de subagentes rodando com "Parar"; toque longo numa mensagem → folha com
copiar, selecionar texto, editar no lugar, editar como nova versão, regenerar, tentar de novo/compactar e
tentar de novo, apagar; ‹ i/n › troca a versão **no host** (`branch.select`) na principal ociosa; menu do
chat: fixar/desafixar host, arquivos do host, processos, compactar, extrair memórias, parar subagentes.
Host offline/sem host/sem conexão/divergente/troca de host: faixa explicando (o celular não executa chats
com ferramentas locais; "Executar neste dispositivo" fica para a fase 4). Arquivos do host:
`files/[chat]` (pastas primeiro, raiz/confinamento do host) e `file/[chat]` (Markdown/código/texto em
páginas de 128 KiB com "Carregar mais", imagem inteira com progresso, demais tipos "Baixar e abrir").
Folhas inferiores próprias (`src/ui/Sheet.tsx`).

**Cuidado com o React Compiler**: chamadas a objetos externos no render (ex.: `remote.view(id)`) são
memoizadas pelas dependências visíveis — os hooks usam a versão do `useSyncExternalStore` como dependência.

Integração (`tests/integration/remote.test.ts`): um **host falso** (`fakeHost.ts`, dispositivo desktop
no WebSocket real seguindo o `HostController`: dedupe por `cmd_id`, janelas `host.begin`/`host.end`,
push com `chat_bases` + `host_epochs`, snapshot/deltas com `n` contíguo, aprovação por item,
questionário, retry, versões, `fs.*` numa árvore em memória) e o celular real mandam todos os kinds do
§8.6, sobem anexo antes do envio, fixam o host e veem a queda do host (`host_dropped` → `host_offline`).

E2E com o **desktop real** (Electron do `../ClearChatDesktop` compilado numa cópia no scratchpad, nunca
no repositório irmão; `CLEARCHAT_USER_DATA` isolado; provedor LLM falso local que transmite devagar, pede
`shell`/`ask_user` ou corta a conexão): um driver Playwright (`_electron`) loga na conta do E2E, cria o
chat com `shell` em "Perguntar" e expõe um controle HTTP local para conferir o lado do desktop.

## Servidor local para testes

Nunca produção. O script sobe um Postgres descartável no Docker (`--tmpfs`, sem volume) e a API de
`../ClearChatWebsite/backend` em `127.0.0.1:8100`, com `MAIL_BACKEND=console` (códigos no log), sem
captcha e configurada só por variáveis de ambiente (o `.env` do site não é lido):

```sh
# uma vez: Python ≥ 3.12 com as dependências do backend
make -C ../ClearChatWebsite/backend venv          # ou aponte CLEARCHAT_SERVER_PYTHON para outro Python
npm run test-server -- up                          # imprime as variáveis abaixo
export CLEARCHAT_SYNC_TEST_URL=http://127.0.0.1:8100
export CLEARCHAT_SYNC_TEST_MAIL_LOG=${TMPDIR:-/tmp}/clearchat-mobile-test/api.log
npm run test:integration                           # login → dispositivo → chaves → desbloqueio → refresh → revogação → recuperação → keys.reset → sair → conta apagada
npm run test-server -- down                        # para a API e remove o contêiner (os dados somem)
```

Sem `backend/.venv` no site, um venv fora do repositório serve: `python3 -m venv /algum/lugar && /algum/lugar/bin/pip
install <dependências do pyproject do backend>` e `CLEARCHAT_SERVER_PYTHON=/algum/lugar/bin/python` (o script já
põe o backend no `PYTHONPATH`).

A integração de dados (`tests/integration/data.test.ts`) age como um **desktop** (dispositivo `can_host`
com a DEK, `tests/integration/seed.ts`): provedor, persona, chats com versões, tools com aprovação/negação,
subagente, questionário, compactação, erro, mensagem entre chats, chamada de voz e anexos (PNG + PDF em
CCB1); o "celular" (AccountService + SyncEngine reais) puxa e confere as telas; o desktop renomeia/apaga e
o celular recebe pelo WebSocket sem pull; o celular renomeia (LWW) e o desktop vê; sair apaga o cache.
Para o E2E: `E2E_TOOL=seed` (conta + desktop + conversas; estado com a DEK de teste no arquivo),
`E2E_TOOL=rename E2E_CHAT=<id> E2E_TITLE=…` e `E2E_TOOL=delete E2E_CHAT=<id>` (o desktop age; o app recebe
ao vivo). Com `EXPO_PUBLIC_CLEARCHAT_SYNC_URL=http://127.0.0.1:8100 npx expo start` o app já abre no servidor local.

Limites anti-abuso do servidor valem (5 códigos/h por e-mail, 20/h por IP): cada execução da integração
pede 5 códigos; se der `429`, `down` + `up` zera tudo. No emulador: `adb reverse tcp:8100 tcp:8100` e,
no app, Trocar servidor → Self-host → `http://127.0.0.1:8100`. Para o E2E manual,
`E2E_TOOL=create E2E_STATE=<arquivo> npx vitest run --config vitest.integration.config.ts e2eTool` cria
uma conta com chaves (senha e chave de recuperação no arquivo de estado) e `E2E_TOOL=revoke` revoga os
celulares dela. Os elementos da UI têm `testID` (viram `resource-id` no `uiautomator dump`).

## Vendorização (`src/vendor/`)

Código compartilhado é **copiado** dos repositórios irmãos por `scripts/vendor.mjs` (lista explícita; os
imports relativos e `@shared/...` são seguidos automaticamente para nada ficar pendurado):

- `protocol/` ← `../docs`: `SYNC_PROTOCOL.md` e `test-vectors/*.json` (bytes idênticos);
- `site/crypto/` ← `../ClearChatWebsite/frontend/src/crypto` (cripto do protocolo, sem os testes);
- `site/lib/password.ts` ← política/medidor da senha de criptografia do site;
- `site/data/voice.ts` ← leitura defensiva da voz no histórico (marcadores de chamada, rótulos);
- `shared/` ← `../ClearChatDesktop/src/shared` (tipos e módulos puros + fecho transitivo);
- `desktop/sync/` ← `../ClearChatDesktop/src/main/sync/{http,ws,stream}.ts`;
- `renderer/` ← lógica pura da UI do desktop (`src/renderer/src/lib`: `branchView`, `approvalOutcome`,
  `reasoning`, `dates`, `fences`, `math`, `memory`, `skills`) — sem React/DOM, só `@shared`.

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
scripts/               vendor.mjs, platformAliases.cjs (redirecionamentos Metro/Vitest), test-server.sh
src/account/           conta: máquina de estados, AccountService, captcha, Keystore/kv do aparelho
src/app/               telas (expo-router): (auth), (app) [chats, chat/[id], home = conta], dev/selftest.tsx
src/chat/              conversa: modelo puro (viewModel), linhas das mensagens, cards de tool, Markdown, anexos
src/data/              sync de dados: SQLite (store), motor (pull/ao vivo/push/resync), anexos, ligação com a conta
src/remote/            controle remoto: espelho do stream, comandos §8.6, anexos (upload), arquivos do host
src/crypto/            cripto do protocolo para o app (reexporta a vendorada)
src/platform/          polyfills e trocas para o Hermes
src/selftest/          casos dos vetores + checagens da plataforma (Vitest e aparelho)
src/ui/                tema (tokens do desktop) e componentes
src/vendor/            cópias geradas — não editar
tests/                 Vitest (unitários) e tests/integration/ (servidor real)
```

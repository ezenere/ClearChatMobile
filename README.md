# ClearChat Mobile

Cliente Android (iOS preparado — ver "Build iOS no Mac") do protocolo de sync do ClearChat, em **Expo SDK 58 / React Native 0.88**
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
| `npm run prebuild:ios`                    | gera `ios/` (`expo prebuild --platform ios`) — no Mac, ver abaixo     |
| `npm start`                               | Metro (bundler)                                                       |
| `npm run android`                         | `expo run:android`: compila, instala no aparelho/emulador e abre      |
| `npm run build:apk` / `build:aab`         | APK / AAB release assinados em `dist/` (Gradle local) — ver abaixo    |
| `npm run publish:android`                 | build no EAS + envio à Play (teste interno) — ver abaixo              |
| `scripts/make-icons.sh`                   | ícones do app e imagens da loja a partir de `assets/brand/*.svg`      |

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

### APK e AAB (release)

Uma chave de assinatura só, criada uma vez e guardada **fora** do repo; ela assina o APK local, o AAB
local e os builds do EAS (que recebem a chave só durante o build — `credentialsSource: "local"`).

```sh
npm run build:apk -- --init      # UMA VEZ: cria ~/.android/clearchat-release.jks + .properties (pede senha)
npm run build:apk                # → dist/ClearChat-<versão>-<code>.apk (arm64-v8a, celulares atuais)
npm run build:apk -- --install   # idem + adb install -r no aparelho conectado por USB
ABIS=arm64-v8a,armeabi-v7a npm run build:apk   # celulares 32-bit antigos também
npm run build:aab                # sobe android.versionCode no app.json e gera dist/….aab (Play, todas as ABIs)
```

- A assinatura entra pelo plugin `plugins/withReleaseSigning.js`, que lê o `.properties` fora do repo
  (`CLEARCHAT_SIGNING_PROPS` troca o caminho). Chave e senha **nunca** vão para o repositório.
- **Faça backup da chave e da senha.** Para o APK instalado à mão, o Android só aceita atualização com a
  mesma assinatura (sem a chave: desinstalar, o que apaga os dados locais). Na Play, com o Play App
  Signing, ela é só a _chave de upload_ — se perder, o Google consegue trocar.
- APK de debug, APK local e app vindo da Play têm assinaturas diferentes: um não atualiza o outro.
  Escolha um canal por aparelho (troca = desinstalar).
- `versionCode` (app.json `android.versionCode`) é a fonte única: o `build:aab` e o EAS
  (`autoIncrement`) sobem o número e alteram o `app.json` — **faça commit** depois de cada envio.
- Sem cabo: copie o APK para o celular e abra (permita "instalar apps desconhecidos" para o app usado).

### Publicar na Play pelo Expo (EAS)

Projeto EAS: `@ezenere/clearchat-mobile` (`extra.eas.projectId` no app.json). O EAS CLI roda pela
versão fixa em `scripts/eas.sh` (`npm run eas -- <comando>`).

```sh
npm run publish:android          # build na nuvem do EAS (AAB) + envio automático à faixa "internal"
# ou, sem fila da nuvem:
npm run build:aab && npm run submit:android    # AAB local + envio pelo EAS Submit
```

Uma vez só, antes do primeiro envio automático:

1. Play Console → criar o app (`com.ezenere.clearchat`) e preencher o mínimo pedido para teste interno
   (acesso ao app, anúncios, classificação, público-alvo, segurança dos dados e **política de
   privacidade** — exigida porque o app pede microfone).
2. **O primeiro AAB precisa ser enviado à mão** (limitação da API do Google): `npm run build:aab` e
   suba o arquivo em Testes → Teste interno. Aceite o Play App Signing.
3. Conta de serviço para o EAS Submit: no Google Cloud (pode ser o projeto do Firebase) crie uma conta
   de serviço com chave JSON, salve em `secrets/play-service-account.json` (ignorado pelo git) e, na
   Play Console → Usuários e permissões, convide o e-mail dela com permissão de lançar em testes.
4. Testadores: Teste interno → lista de e-mails → mande o link de participação.

O `eas.json` envia com `releaseStatus: "completed"`; enquanto o app estiver em rascunho na Play (antes
do primeiro lançamento manual), o Google só aceita `draft`.

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
  `unlock`, `recover` (cada fase libera só as suas via `Stack.Protected`); `(app)` (cofre aberto ou
  fase `local`, "Usar sem conta") = `settings/*`
  (fase 5; a antiga `home` virou `settings/account`), `recovery-key`. Componentes em `src/ui/` (botões, campos, código de 6 dígitos, cartões, banners,
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
com ferramentas locais; nos outros, "Executar neste dispositivo" — fase 4a). Arquivos do host:
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

## Host no celular (fase 4a)

O celular executa os **próprios** chats (sem ferramentas locais, §8.9) chamando os provedores direto (as
chaves vêm dos registros `provider` sincronizados, decifrados no aparelho; nunca vão para logs).
**Decisão de produto:** chats executados no celular não são controlados remotamente — as tools são só
conversacionais. O celular não publica o stream (§11) e responde todo `remote.command` na hora com
`rejected` ("Este chat roda no celular e não aceita controle remoto. Use “Executar neste dispositivo”
para trazê-lo para cá."); um computador que queira o chat o importa por `host.takeover` (§8.8).

Agente (`src/agent/`, sem React Native):

- **Vendorado** (byte a byte, `npm run vendor`): `agent/llm.ts` (SSE, acumulador, `applyChunk`,
  `finalizeToolCalls`, `parseUsage`, `readableError`, `streamChat`), `agent/adapters/*`,
  `agent/textTools.ts`, `agent/smartApprove.ts` (juiz), `tools/webSearch.ts` + `ddg`/`brave`/
  `searchApis`, `tools/pageExtract.ts` (parse5) e `tools/models.ts`; `shared/contextCapture.ts`.
- **Shims gerados**: o desktop importa `./request` e `./util` (Node: os/shell/fs). O `vendor.mjs` tem
  `SHIMS`: em vez de copiar, gera `src/vendor/desktop/agent/request.ts` e `tools/util.ts` com
  `export * from` as adaptações do celular (`src/agent/request.ts`, `src/agent/tools/util.ts`) — o
  `vendor:check` confere o shim também.
- **Escritos para o celular**: `request.ts` (mesma montagem do desktop; só as tools portáveis —
  `web_search`, `browse_url`, `list_models`, `ask_user` — vão ao modelo; `<environment>` sem raiz/shell;
  parâmetros que o modelo não aceita saem com nota), `providers.ts` (`/models` com cache, como o
  desktop), `attachments.ts` (anexos por referência → base64 na cópia; o runner baixa os blobs antes,
  §14), `registries.ts` (fila, aprovações, questionários, retries, `callWithNetworkRetry`) e
  `runner.ts` (turno do desktop: stream → mensagem com modelo/tokens/custo/duração/raciocínio → tools
  com aprovação (Sempre/Perguntar/Listas/Smart-Approve com juiz só se configurado) → resultados →
  repete; fila e ⚡; Parar com parcial `interrupted`; card de falha de conexão; erro persistido;
  regenerar/editar como versão/trocar de versão/editar/apagar). `tools/web.ts` = backends HTTP do
  web_search (o Brave pelo site fica fora: precisa de navegador) e o `browse_url` por `fetch` com teto
  de tamanho/tempo e o extrator do desktop; `tools/askUser.ts` resolve as imagens do questionário.
- **Streaming**: no SDK 58 o `fetch` global já é o `expo/fetch` (corpo como `ReadableStream`), então o
  `streamChat` vendorado roda sem troca. Prova no aparelho: `clearchat://dev/streamtest?base=…` (só dev)
  contra o provedor falso — 1º delta em ~0,1 s de 24 s e centenas de atualizações (sem buffering).

Host (`src/host/`, sem React Native):

- `writer.ts` — **outbox persistida** (tabela `outbox`, migração 3): cada revisão vai ao cache na hora e
  sobe em lotes (~250 ms): o registro `chat` (LWW; num conflito os campos mudados aqui são reaplicados
  sobre a versão do servidor) antes, depois o conteúdo com `chat_bases[X]` = o head que o aparelho tem
  (calculado no envio) e `host_epochs[X]` = epoch da janela (sem janela = replay, §8.4 B); blobs
  conferidos/enviados antes (§14); `chat_busy`/`not_host`/`stale_base`/divergência tratados.
- `repo.ts` — sessões/mensagens com a semântica de árvore do desktop (`parentId` sempre explícito,
  `branchSel` sempre enviado, mensagem + sessão no mesmo lote).
- `host.ts` — janelas `host.begin`/`host.end` (fecha ocioso e com a outbox vazia), `normalizeStale` ao
  virar host, "Executar neste dispositivo" (`host.takeover`, com `confirm_pinned`), troca pedida por
  outro dispositivo (`host.handover_request`: o turno para **na hora**, a outbox sobe, a janela fecha e
  `host.release` repassa a fila), perda do host (`host.revoked`/`chat.state`), recusa de chats com
  ferramentas locais e de comandos remotos, ações da tela (`local(kind, payload)` com os mesmos kinds do
  §8.6) e o **espelho local**: os eventos do runner alimentam o mesmo `LiveMirror` do controle remoto.
- Segundo plano: `AccountService.beforeBackground` roda antes de fechar o WebSocket — para os turnos
  (parcial `interrupted`, sessão `interrupted`, fila descartada), envia a outbox **sem timers** (o
  Android pausa os timers do JS em segundo plano) e fecha as janelas. `hello.active_windows` reabre as
  janelas numa reconexão rápida.
- `stack.ts` monta tudo (o mesmo código no aparelho — `native.ts` — e na integração no Node);
  `policy.ts` = `usesLocalTools` (cópia da regra do desktop); `newChat.ts` = config de um chat novo
  (padrões de "Novos chats" + persona; só tools portáveis, skills desligadas).

Telas: **Novo chat** (botão na lista): persona, provedor + modelo (lista do `/models` com busca ou id
digitado), parâmetros que o modelo aceita (`paramRules` vendorado), ferramentas portáveis e os buscadores
configurados. A conversa (`useChatRuntime`) decide quem executa: este celular (selo "Executando neste
celular", composer e cards ligados ao runner local) ou outro dispositivo (controle remoto da fase 3);
"Executar neste dispositivo" no menu e na faixa de host offline (só chats sem ferramentas locais);
chats com ferramentas locais mostram por que o celular não os executa.

Testes: `tests/agent.test.ts` (acumulação OpenAI/Anthropic, request, runner contra o provedor falso
HTTP), `tests/host.test.ts` (janelas, revisões, recusas, troca de host no meio do turno, segundo plano,
espelho) e `tests/integration/host.test.ts` (servidor real). Provedor falso: `tests/fakes/fakeLlm.ts`
(SSE OpenAI-compatible e Anthropic, `/models`, DuckDuckGo e páginas falsas; roda sozinho com
`node tests/fakes/fakeLlm.ts 8790` para o E2E). No app de desenvolvimento,
`EXPO_PUBLIC_CLEARCHAT_SEARCH_BASE_DDG=http://127.0.0.1:8790/ddg` aponta o web_search para o falso.

## Host no celular (fase 4b)

Tudo o que o desktop faz num chat sem ferramentas locais roda agora no celular, com a mesma semântica
(o código puro do desktop é **vendorado**; o resto é porta fiel do `runner.ts` do desktop):

- **Memória** (`src/memory/`): o `MemoryStore` do desktop (FTS5 com bm25, similares, slugs, validações)
  roda sem alteração sobre um **índice SQLite em memória** (`memoryIndex.ts`: `memory_collections`/
  `memories`/`memories_fts` montados dos registros `memory_collection`/`memory` do cache e mantidos
  pelos avisos do `LocalStore`) através de um adaptador com a interface do better-sqlite3
  (`sqlite.ts`). Uma mudança feita aqui (tool ou extração) vira revisão do registro com só os campos
  mudados como "sujos" e sobe pela **outbox LWW** persistida (`src/data/lww.ts`, tabela
  `lww_outbox`: um registro por lote, `rev_mismatch` → campos locais sobre a versão do servidor,
  `gone` → a exclusão vence; offline → tenta de novo). Colisão de slug (§4.3.5) segue a regra
  determinística e reenvia. Tools `memory_*` = `tools/memory.ts` vendorado; config por chat/persona
  (`config.memory`); o índice vai **congelado por sessão** no campo `memory` do registro `session`
  (§4.3.7 — o próximo host continua com o mesmo prefixo); renovado depois de compactar ou em
  "Atualizar índice agora"; extração (`memory/extraction.ts` vendorado) depois da compactação e em
  "Extrair memórias agora". Memória desligada → nada de memória vai à API. Tela: menu do chat →
  "Memória…" (ligar, coleções ativas por categoria, **onde o agente grava**, extração automática,
  subagentes).
- **Subagentes**: `delegate_task` (bloqueante ou em segundo plano, modelo/provedor próprios via
  `resolveSubagentTarget`), `check_subagents`/`wait_subagents`/`cancel_subagent`/`message_subagent`
  (pai↔filhos, irmãos com o `SlidingWindowLimiter`, broadcast), `ReportRegistry` vendorado
  (callbacks na ordem, reivindicação, silêncio na parada em cascata), pai acordado pelo callback,
  subagente dormindo (`waiting`) enquanto há filhos pendentes. As subsessões são registros `session`
  (o PC as vê depois do takeover; a tela mostra como abas). "Parar subagentes" no menu e na faixa.
- **Entre chats**: `list_chats`/`get_chat_info` (`tools/chats.ts` vendorado) e `send_to_chat` com os
  limites do desktop (saltos, ciclo de espera, timeout). Destino executado (ou executável) **neste
  celular** → entrega local com a janela aberta antes; destino executado por **outro dispositivo
  online** → comando `send` ao host dele (§8.6, como o controle remoto); com `wait_for_reply` a
  resposta é lida dos registros sincronizados quando a janela do turno remoto fecha
  (`src/host/interChat.ts`). Host do destino offline/em tolerância, divergente, ou chat com
  ferramentas locais sem computador online → recusa com texto claro (não existe fila no servidor,
  §8.7). O cabeçalho não sugere responder por `send_to_chat` (o celular não aceita comandos).
- **read_history** (`tools/history.ts` vendorado) com o `HistoryStore` do celular
  (`src/agent/historyStore.ts`): índice `history_fts` (corpo × tools, bm25 3:1, texto do
  `searchableText` vendorado) mantido junto com as mensagens do cache (migração 4 reindexa o que já
  havia).
- **Compactação** (`agent/compaction.ts` vendorado): pedida (menu → "Compactar conversa…", com o medidor
  de contexto e a compactação automática), automática no limite (`autoCompact` + `compactThreshold`;
  subsessões sempre), "Compactar e tentar de novo" e contexto estourado → compacta e repete; fronteira
  com `insertAt` antes das mensagens pendentes (mesmo lote).
- **Título automático** (`agent/autoTitle.ts` vendorado, chamada lateral com `buildSideRequest`): pelo
  setting sincronizado `autoTitle`, na 1ª mensagem digitada, compare-and-set contra o título provisório;
  "Gerar título" no menu.

**Conectividade, outbox e divergência (§8.4, §9).** Começar um turno exige o servidor (a janela);
com o turno rodando, ele termina no celular mesmo sem conexão e as ações dele (fila, aprovação,
parar) continuam; a outbox sobe quando a conexão volta (na mesma janela se reconectar em < 10 s,
senão `host.begin` de novo ou replay). Se um PC assumiu e escreveu enquanto isso, o replay cria a
**divergência**: o motor deixa de aplicar conteúdo remoto desse chat enquanto houver conteúdo local
pendente ou a versão divergente for deste aparelho (§9.2, só marca "precisa rebaixar"), e a conversa
mostra "Versão deste celular · Versão online" (navegáveis) com "Manter a deste celular" / "Manter a
online" e a confirmação obrigatória (`src/host/divergence.ts`, `src/chat/local/DivergencePanel.tsx`).
Manter a online apaga a versão local (sessões/mensagens fora do servidor + outbox do conteúdo) e baixa
a online; manter a local envia no `divergence/resolve` o lote que transforma a online na local
(tombstones das que só existiam online). Um descarte feito em outro dispositivo chega como
`divergence_discarded` e apaga a versão local do mesmo jeito.

**Fila no segundo plano (decisão).** O turno é interrompido (o SO suspende o app), mas os itens da fila
ainda não injetados são **guardados no SQLite** (`parked_queue`) e voltam à fila ao voltar ao primeiro
plano (ou ao reabrir o app), sem rodar sozinhos, com o aviso "o turno parou; N mensagens da fila
ficaram guardadas — toque ⚡ para enviar". Callbacks de subagentes nunca vão para essa fila: entram como
mensagem no pai já parado.

Testes: `tests/phase4b.test.ts` (servidor falso + provedor falso: memória, LWW, slug, índice congelado,
extração, subagentes, entre chats local/remoto, read_history, compactação, título, offline + replay,
fila guardada, divergência nos dois sentidos) e `tests/integration/phase4b.test.ts` (servidor real:
memória escrita no celular visível/editável no PC, subagente sincronizado, `send_to_chat` a um chat
executado no PC, divergência criada pelo celular sem servidor enquanto o PC assumiu e escreveu —
resolvida mantendo a local num chat e a online no outro). O provedor falso ganhou roteiros (`/remember`,
`/whoami`, `/delegate[-bg]`, `/wait`, `/sleep`, `/tell`, `/ask-chat`, `/chats`, `/history`, `/big`) e
respostas às chamadas laterais (resumo, título, extração).

## Configurações (fase 5)

`src/settings/` (núcleo sem React Native: `records.ts` e `service.ts`) + telas em
`src/app/(app)/settings/` (abertas pelo ícone de engrenagem da lista de chats):

- `records.ts` — plaintexts de `provider`/`preset`/`setting` com a semântica do desktop (porta do
  formulário do provedor: tipo ↔ URL/nome padrão, headers JSON, validação; persona sanitizada e sem
  `cwd`), o patch LWW por campo (`config` da persona chave a chave, chaves removidas em
  `__configUnset`), `mergeEdits` (salvar aplica só o que o usuário mudou sobre a versão atual), a lista
  de buscadores (= `webSearchConfig.ts` do desktop: ligar API sem chave é recusado; apagar a chave
  desliga) e a persona resolvida para o editor.
- `service.ts` — `SettingsService`: provedores, personas (apagar a padrão zera `defaultPresetId`),
  settings (LWW inteiro, `null` = removida), pesquisa na web e memórias (MemoryStore vendorado sobre o
  índice local; apagar coleção = tombstone + cascata). Escreve pela **outbox LWW** da 4b (offline ok;
  retomada ao abrir o cofre e ao reconectar — `native.ts`/`startSettings`). `react.ts`:
  `useSettingsVersion` (eventos do motor com `settings`) e `readAt(version, …)`.
- Componentes: `ModelPicker`/`ModelField` e `ParamsEditor` (também usados pelo Novo chat),
  `MemoryConfigEditor` (folha "Memória…" do chat e aba Memória da persona), `memoryUi`, `ui`
  (tela, segmentado, campo numérico, ícones, linhas), `RenameDialog`.
- Telas: Novos chats, Personas (+ editor), Aprovações, Memórias (coleção, memória), Pesquisa na web,
  Provedores (+ editor com "Testar conexão" — `testProvider` em `src/agent/providers.ts`), Dispositivos,
  Conta e Trocar senha.
- Conta (`AccountService`): `devices()`, `renameDevice(name, id?)`, `revokeDevice(id)` (o atual =
  sair), `changePasswordWithCurrent` (confere a senha atual no aparelho antes do `PUT /keys/password`),
  `setRemember` (lembrar/biometria com o cofre aberto).
- **FLAG_SECURE**: módulo local `modules/secure-screen` + `useSecureScreen()` (`src/ui/secure.ts`) nas
  telas de senha, desbloqueio, recuperação, setup, chave de recuperação, provedor e pesquisa na web
  (o screencap sai preto; para revisar o layout no E2E, `adb emu screenrecord screenshot <pasta>` pega
  o framebuffer do emulador).

Testes: `tests/settings.test.ts`, os novos casos de `tests/account.test.ts` e
`tests/integration/settings.test.ts` (servidor real: celular ↔ "desktop", conflito, offline,
dispositivos, troca de senha). A integração inteira passa do limite de 20 códigos/h por IP: rodar em
dois lotes com `test-server down`/`up` entre eles.

## Voz (fase 6)

Ditado no composer (chats deste celular e controle remoto) e **chamada de voz** nos chats executados
neste celular — com a semântica do desktop, cujo código é **vendorado**:

- **Vendorado** (`npm run vendor`): `desktop/voice/call.ts` (o `VoiceCallManager` inteiro: turno,
  fila/turno continuado, preâmbulo, frases de demora espaçadas — contadas do FIM da reprodução —,
  TTS por frase, tags de voz tiradas da síntese quando a voz não as interpreta, barge-in com o
  histórico só com as PALAVRAS ouvidas, `end_call`, marcadores e custos), `turnMachine`,
  `sentences` (nunca parte uma tag de voz), `callErrors`, `stt.ts` (erros/nome do arquivo/idioma/
  custo), `tts.ts` + `elevenlabs.ts` (REST `/audio/speech` e ElevenLabs, PCM progressivo juntado),
  `wav.ts`, `voiceCatalog.ts` (modelos e vozes do provedor, `supportsAudioTags`, `fishVoiceIdFrom`),
  `shared/voiceTurn` (`AdaptiveTurnGate`, `classifyUtteranceEnd`), `shared/voicePolicy`
  (`PlaybackDuck`, `VoicedSpan`, frases de demora), `shared/speechGate` (`LevelGate`, `SpeechGate`,
  pós-filtro de alucinações), `shared/heardText` (`heardChars`/`heardPrefix`/`liveDimFrom`),
  `shared/audioTags`, e do renderer `voice/dictation.ts` (ponto de inserção, prévia, desfecho,
  erros de captura) e `audio/{silence,pcm}.ts`. **Shims**: `voice/clips.ts` → `src/voice/clips.ts`
  (só a classe `FILLER` = o pool de preâmbulos, o mesmo hash da definição; bytes num cache
  próprio — clipes de interjeição de versões antigas ficam velhos e somem na próxima geração),
  `voice/evalLog.ts` e `voice/elevenlabsStream.ts` → só os tipos (`src/voice/evalLog.ts` — uma
  decisão de preâmbulo por linha, sem disco —, `src/voice/ttsFeed.ts`).
- **Escrito para o celular** (`src/voice/`, sem React Native exceto `native*.ts`/`react.ts`):
  `endpoints.ts` (settings normalizadas, provedor resolvido pelo id — chave só em memória —, forma
  gravada sem as partes do dispositivo, "só no computador" para Local/GPU), `stt.ts`
  (`transcribeAudio` do desktop com o multipart montado em bytes — o `Blob` do RN não aceita bytes),
  `session.ts` (o subconjunto API da sessão do desktop: parciais melhor-esforço, especulação na
  pausa, final reaproveitada, uma nova tentativa na falha transitória e o **portão de ativação de
  fala** na frente de TODA via — parcial, especulação e final, ditado e chamada: trecho com menos de
  280 ms de voz não chama o STT, o que vai é aparado, o texto passa pelo pós-filtro de alucinações e
  o piso de ruído atravessa as sessões), `mic.ts` (quadros PCM16 de 32 ms a 16 kHz;
  `FakeMicSource`), `player.ts` (fila de reprodução: ordem, sem sobreposição, drop/cancel com fade,
  **ducking** — `setDuck`, rampa de ganho de ~80 ms em passos de 16 ms no volume do `AudioPlayer` —,
  `currentPosition` pela posição do player, PCM → WAV), `call.ts` (o "sensor" do `useVoiceCall` do
  desktop — `LevelGate`, `PlaybackDuck`, barge-in com a posição da frase — + o `VoiceCallManager` +
  a pré-checagem), `follow.ts` (leitura ao vivo: frases ouvidas + caracteres da atual, ~10×/s),
  `dictation.ts`, `stack.ts`, `nativeAudio.ts` (expo-audio; `position()` = `currentTime`/
  `duration`) e `native.ts` (instância, microfone de teste, nível de ativação no kv, segundo plano).
- **Escritores do sync**: `interjections` é legado (§4.3.6) — `src/data/legacy.ts` tira o campo de
  `config.voice` (chat/persona) e de `voiceCallDefaults` em todo plaintext antes de cifrar (inclusive
  registros antigos do cache que o celular regrava); `repo.chat()` normaliza `voice` como o `toChat`
  do desktop. `audioInput.activationDb` é parte do dispositivo: fica no kv (`voice.activationDb`),
  `audioSettingOut` nunca o grava e o valor de um registro recebido é ignorado.
- **Runner** (`src/agent/runner.ts`/`request.ts`): overrides da chamada no turno
  (`applyVoiceCallChat` — modelo/params/raciocínio, tools, prompt), `end_call` (sem aprovação,
  encerra o turno), `meta.voice` nas respostas, `appendDisplayMessage` (marcadores — no registro com
  a codificação do §4.3.8, já feita pelo `repo.ts`) e `amendVoiceTurn`. `host.local('send')` aceita
  `voice` (ditado/fala). `HostService.holdWindow` mantém a janela aberta durante a chamada.

**Áudio (expo-audio 58).** O `AudioStream` dá o PCM do microfone em tempo real (float32, 16 kHz
pedidos — o emulador e os aparelhos testados entregam 16 kHz; outra taxa é reamostrada) e o
`AudioPlayer` toca cada frase (arquivo temporário WAV/MP3). Trade-offs, documentados:

- **Sem cancelamento de eco**: o `AudioStream` abre a fonte MIC do Android (não a de chamada).
  Por padrão o microfone fica **surdo enquanto o assistente fala** (+ 350 ms de rabo de eco) e o
  botão **Interromper** faz o barge-in (o histórico fica só com as palavras que tocaram); "Falar
  por cima da resposta (use fone de ouvido)" (opção deste aparelho, §4.4) liga o comportamento do
  desktop: falar por cima **abaixa** a voz do assistente para `turn.duckGain` (rampa no volume do
  player) e ela continua; insistir (`bargeInVoicedMs` de voz, `bargeInWords` palavras reais na
  parcial ao vivo ou "para"/"espera") vira barge-in; parar antes (tosse, "uhum") devolve o volume
  depois de `duckRestoreMs` e o som é descartado. A fala é detectada pelo `LevelGate` (nível de
  ativação + piso de ruído), a mesma regra do portão do STT.
- **TTS por frase, bytes completos**: o expo-audio não toca PCM progressivo; cada frase toca quando a
  síntese termina (a 1ª frase corta na vírgula, como no desktop sem feed). O WebSocket multi-contexto
  da ElevenLabs é só do desktop (depende de `Buffer` e de headers no construtor do WebSocket).
- **Transcrição só pela API** (OpenAI-compatível/OpenRouter; a ElevenLabs direta não transcreve).
  "Local" mostra "só no computador" e o celular **não** manda o áudio para a API sozinho; "Híbrido"
  usa a API. Fala "Local (Kokoro)"/GPU idem.
- Parciais/especulação pela API custam requests (seguem `livePartials`/`turn.speculativeApi`, como
  no desktop).
- **Foreground only**: o app em segundo plano encerra a chamada (marcador de fim "o app foi para o
  segundo plano") e cancela o ditado; outro dispositivo assumir o chat derruba a chamada. O diálogo
  de permissão do microfone pausa a Activity — ignorado (não é segundo plano).
- Permissão `RECORD_AUDIO` (o texto do sistema é o do Android; no iOS, `NSMicrophoneUsageDescription`
  em pt-BR). Negada → aviso em pt-BR.

**Telas.** Composer: microfone (toque = grava; com "Segurar para falar", segurar grava e soltar
conclui), espelho do campo com o ditado translúcido no ponto do cursor, ✕/✓/enviar, parada por
silêncio, erro com "Inserir o texto parcial"; no controle remoto o texto entra igual, mas o `send`
do §8.6 não leva `meta.voice` (sugestão de protocolo no PLAN). O ponto de status do composer agora
segue a conexão (verde/amarelo "Reconectando"/vermelho "Sem conexão"). Conversa: telefone no
cabeçalho (chats executados aqui) → pré-checagem com o motivo e "Abrir Configurações → Voz" →
**dock** no lugar do composer (fase, relógio, nível, texto da fala — parcial/especulativo/final —,
"falando por cima · voz baixa" durante o ducking, mudo, Interromper, desligar, "Gerar clipes");
menu → "Chamada de voz…" (config de voz do chat). Configurações → **Voz**: ditado (com o **Nível de
ativação** — `MicActivationLevel`: valor, medidor ao vivo com a linha do nível, arrastar/−/+, e
"Testar", o único que abre o microfone), transcrição, fala (provedor/modelo/voz pela listagem do
provedor — modelo sem lista de vozes, como o Fish Audio pelo OpenRouter, mostra a dica e aceita o
link `fish.audio/m/<id>` colado —, a nota das tags de voz do modelo, parâmetros do modelo pelos specs
do desktop, "Testar voz"), padrões da chamada (disponível, `end_call`, prompt-base, modelo,
preâmbulos, frases de demora — padrões 8 s/15 s, espaçadas —, "Falar por cima da resposta" — volume,
interromper depois de falar/com palavras, volume volta depois de —, **Tags de voz** com a instrução
editável, fim de turno) e "Neste aparelho" (falar por cima com fone, microfone de teste em dev,
"Gerar clipes dos preâmbulos"). Persona → aba **Voz** (`src/settings/VoiceConfigEditor.tsx`): as
escolhas com herança usam o `InheritChoice` (`src/settings/InheritChoice.tsx`, = desktop): só as
opções reais, ★ na igual ao herdado (persona → global), sem override a ★ fica selecionada e tocar
nela limpa o override — Disponível, Prompt na chamada, O agente pode encerrar, Preâmbulos e Tags de
voz (com o texto da instrução, "Usar o padrão" e o aviso quando a voz atual não interpreta tags);
"Tools próprias na chamada" virou um interruptor (desligado = as do chat, como no desktop).
**Mensagens da chamada** (`src/chat/voiceText.ts` + `Markdown` `voiceTags`/`dimFrom`, nos chats
deste celular, no controle remoto e no viewer ao vivo): tags de voz no lugar, com os colchetes, em
opacidade 0,65 (cor com alfa — `opacity` não vale em `Text` aninhado), fora de código; enquanto uma
resposta é falada aqui, o trecho ainda não falado fica em 0,5 e avança palavra por palavra (posição
do player); depois de uma interrupção o resto não ouvido (`meta.voice.unheard`) aparece esmaecido
depois do marcador "interrompido".

**Microfone de teste (só desenvolvimento — testes nunca abrem o microfone real).**
`clearchat://dev/fakemic?on=1` (ou `EXPO_PUBLIC_CLEARCHAT_FAKE_MIC=1`) troca o microfone por silêncio

- WAVs injetados; `?poll=http://127.0.0.1:8790` faz o app buscar WAVs em `<base>/mic/next` — o E2E
  enfileira com `curl -X POST <base>/mic/queue?name=q1.wav` (um deep link pausaria a Activity, o que
  encerra a chamada). O provedor falso (`tests/fakes/fakeVoice.ts`, dentro do `fakeLlm.ts`) serve
  `/audio/transcriptions` (texto determinístico pelo fixture com a duração de voz mais próxima;
  `FAKE_STT_FIXTURES=<pasta com .wav + .txt>`), `/audio/speech` (tom de ~45 ms por caractere), o
  formato da ElevenLabs e `/mic/*`. Fixtures do E2E: `espeak-ng -v pt-br -w q1.wav "…"`. No AVD,
  `hw.audioInput=no` (conferido em `hardware-qemu.ini`) + `-no-audio`.

**Smart-Approve → coleta automática de contexto** (pendência da 4b): `agent/contextCapture.ts` do
desktop vendorado; o runner do celular o liga como o desktop (mensagem digitada → resumo em segundo
plano com debounce → `config.capturedContext` do chat, que sincroniza; o juiz espera o resumo, teto
de 20 s; Parar cancela; subagente herda a descrição do pai + a tarefa), seguindo
`smartApproveDefaults.capture` (Configurações → Aprovações).

Testes: `tests/voice.test.ts` (paridade do multipart com o `transcribeAudio` vendorado, erros,
sessão, portão de ativação — silêncio/ruído nunca chegam ao STT, fala aparada, "Obrigado." sobre um
estalo vira vazio, nível de ativação do aparelho —, TTS OpenAI/ElevenLabs, settings — `activationDb`
fora do registro, `interjections` nunca reenviado —, clipes só dos preâmbulos, fila com ducking e
posição, ditado com o microfone de teste e a chamada inteira — turno, `meta.voice`, `end_call`,
marcadores codificados, custos —, meia-duplex + Interromper, falar por cima com fone: tosse → volume
de volta, insistir → barge-in em palavras com `meta.voice.unheard`, tags tiradas da síntese),
`tests/voiceText.test.ts` (tags/esmaecimento do texto, ★ da herança), `tests/capture.test.ts` e
`tests/integration/voice.test.ts` (servidor real: settings do "desktop" → ditado e chamada no
celular → o desktop decifra marcadores/falas/`end_call`/persona sem `interjections`).

## Notificações push (protocolo 1.7.0)

Avisos do host (§22) no celular, também com o app fechado. Código em `src/push/`:

- `model.ts` (puro): decisão para cada mensagem de dados do FCM — `dismiss` apaga a tag (sempre);
  `host_offline` usa os campos em claro; os demais decifram com `K_push` (`crypto.ts`, vetores de
  `push.json`) e descartam por falha de autenticação, `kind` interno ≠ externo, `ts` > 24 h (sem DEK:
  `sent_at`), tipo desligado ou chat aberto na tela. Sem a DEK disponível sem interação → texto
  genérico pelo tipo (título "ClearChat", sem chat). Canais `pending` (alta), `replies`, `errors`,
  `host-offline`, todos com visibilidade privada na tela bloqueada; identificador = tag.
- `task.ts`: a tarefa do expo-notifications/expo-task-manager (definida no escopo do módulo, importada
  pelo `index.ts`) recebe **toda** mensagem de dados — primeiro plano, segundo plano e app morto (JS
  sem tela). A chave vem do cofre aberto (`account.pushKey`) ou da DEK lembrada **sem biometria** no
  Keystore (`readDekWithoutPrompt`); com biometria, "não lembrar" ou bloqueado → genérico.
- `registration.ts`: `PUT`/`DELETE /devices/current/push` com o token **nativo** do FCM
  (`getDevicePushTokenAsync`, nada do serviço de push da Expo): na abertura/login/desbloqueio, a
  cada hora em primeiro plano, quando o token muda (só se mudou — o expo avisa o token a cada
  leitura) e nas Configurações; `features.push` nulo → nada; permissão negada ou desligado → `DELETE`.
- `native.ts`: permissão do Android 13+ (convite na primeira entrada na conta, antes do diálogo do
  sistema; negada → aviso e atalho para as configurações do sistema), toque → abre o chat (também a
  frio, pelo `getLastNotificationResponse`), handler de primeiro plano e os **avisos locais dos chats
  executados neste celular** (`localHost.ts`, mesmos textos do host do desktop — `@shared/push`
  vendorado): o host do celular para o turno ao sair da tela, então o aviso real é "O turno parou
  porque o app saiu da tela…" (com a pendência que havia); aprovação/pergunta/retry/resposta/erro
  com o app fora da tela também passam pelo mesmo código.
- Configurações → **Notificações** (`settings/notifications.tsx`): interruptor geral, tipos,
  "Mostrar trecho", estado (permissão, servidor sem push, build sem Firebase, registrado) e
  notificação de teste. Dispositivos mostram "notificações ativas" (`push` do `GET /devices`).

**Firebase.** `app.config.js` estende o `app.json` com `android.googleServicesFile`: variável de
ambiente `GOOGLE_SERVICES_JSON` (no EAS, variável do tipo arquivo, ambientes production e preview,
visibilidade sensitive — `eas.json` fixa o ambiente de cada perfil) ou `secrets/google-services.json`
se existir (fora do git). Sem nenhum dos dois o app compila e roda com o push desligado (status
"Push indisponível"). iOS: `enableRemoteNotifications: false` por enquanto (só avisos locais).

**Teste sem FCM** (build de desenvolvimento): `clearchat://dev/push?kind=approval&chat=<id>` monta a
mensagem (cifrada com o `K_push` do cofre aberto) e a entrega à mesma função da tarefa;
`mode=badkey|old|mismatch`, `nokey=1`, `delay=3` (testar com o chat aberto) e `raw=<JSON do
message.data>` (entrega uma mensagem real capturada). Para a cadeia desktop → servidor sem o Google,
suba o servidor com uma conta de serviço FALSA (`FCM_SERVICE_ACCOUNT_FILE` com uma chave RSA gerada na
hora e `token_uri` local) e `FCM_BASE_URL` apontando para um FCM falso que grava cada
`messages:send`; o `raw=` entrega essas mensagens ao app. `tests/integration/push.test.ts` precisa da
instância com push (com a conta falsa basta).

**E2E real (FCM de verdade, só para o emulador):** AVD com Play Store, build com
`secrets/google-services.json`, servidor local com a conta de serviço real do projeto Firebase
(`FCM_SERVICE_ACCOUNT_FILE`, nunca impressa) e `HOST_DROP_GRACE_S=5 HOST_OFFLINE_PUSH_DELAY_S=15`;
desktop com pasta de dados descartável, `CLEARCHAT_PUSH_GRACE_MS` curto e `CLEARCHAT_FORCE_AWAY=0|1`.
Roteiro: o celular manda `/search …` num chat do PC → aprovação chega com o app em segundo plano e
**morto** (`am kill`) → aprovar no PC → some (dismiss) → resposta chega; PC ausente + turno local →
resposta para todos; cofre bloqueado/biometria → genérico; matar o desktop com chat rodando →
"Host offline" → religar o mesmo dispositivo → some.

## Usar sem conta

Na primeira tela, além de **Entrar**, há **Usar sem conta**: o app funciona como o desktop sem
conta — provedores, personas, chats executados no celular (com versões, anexos, memória,
subagentes, voz), memórias, aprovações, pesquisa na web e voz ficam **só neste aparelho** e nada vai
a servidor nenhum além dos provedores de IA/voz que o usuário cadastrar. A conta só acrescenta sync,
controle remoto dos chats do PC, dispositivos e notificações push.

- **Fase `local`** da conta (`src/account/session.ts`): `useWithoutAccount()` (kv
  `account.local_mode`, abre direto nos dados locais), `beginSignIn()` (Configurações → "Entrar numa
  conta" → o login normal; "Continuar sem conta" volta). O WebSocket nunca liga nessa fase.
- **Mesmo cache, sem parallel store**: o `LocalStore` com dono `local` (`meta.owner`). Toda escrita
  já passa pelas outboxes persistidas (conteúdo: `outbox`; provedores/personas/settings/memórias:
  `lww_outbox`), então o modo sem conta é só "outbox que não sobe": `syncAllowed(store)`
  (`src/data/binding.ts`) zera as chaves do motor, das outboxes e do controle remoto enquanto o dono
  for `local`. O host (`HostService.localOnly`) executa sem janela de escrita (sem `host.begin`) e
  recusa trocar de host com "Entre numa conta…"; renomear/apagar chat vão pela outbox local
  (`chatActions` em `src/host/react.ts`); anexos ficam no store local (sem `blob_id`, que depende da
  DEK) e sobem no merge. Proteção em repouso igual à dos dados de uma conta (o mesmo SQLite privado
  do app, sem backup; as chaves de API ficam no plaintext do registro `provider`, como hoje).
- **Recursos só com conta**: Dispositivos e Conta somem das Configurações; Notificações, Conta,
  Dispositivos, Trocar senha e Chave de recuperação mostram "Precisa de uma conta" com o botão
  "Entrar numa conta" (`src/settings/AccountRequired.tsx`) — nenhum beco sem saída. A lista mostra o
  selo "Neste celular" no lugar do sync; sem provedor, o vazio é o começo do onboarding ("Adicionar
  provedor" → "Novo chat"); o Novo chat, sem modelo padrão, oferece "Usar como modelo padrão".
- **Entrar depois = merge do primeiro login (§12)**, porta do `enterMerge`/`runMerge`/`dedupe`/
  `applyRemap` do engine do desktop (`src/data/merge.ts`; lá o código é amarrado ao SQLite do desktop,
  não dava para vendorar): no 1º desbloqueio com o cache `local`, baixa e decifra tudo
  (`sync/changes` + `records/fetch` + `chat-states`), online vazio → sobe tudo sem perguntar, local
  vazio → só baixa, os dois → a tela do desktop ("Este celular já tem dados", contagens, chats com
  histórias diferentes, **Priorizar online · Priorizar local**, `src/settings/MergeScreen.tsx`).
  Dedupe com id canônico online (provedor por baseUrl normalizada + nome/chave, persona por nome +
  config, coleção por categoria + nome, memória por coleção + título) e remapeamento de todas as
  referências do §12.5; conteúdo vencedor pela prioridade; idênticos não geram envio; tudo numa
  transação (as outboxes são refeitas a partir do cache: novos com base 0, os que venceram por cima
  com `base_rev` = rev online). Depois, cursor = head, dono = a conta e o sync normal liga: os chats
  sobem em replay com `chat_bases = 0` (o celular vira o host deles), os blobs antes (§14). Erro de
  rede → "Tentar de novo" (nada foi enviado, os dados locais ficam). Sair da conta antes do merge
  não apaga os dados sem conta.
- **Sair de uma conta (decisão: igual a hoje)**: apaga o cache da conta no celular (os dados ficam na
  conta) — o texto do diálogo diz isso. Depois dá para entrar de novo ou "Usar sem conta" começando do
  zero. O protocolo (§12, último parágrafo) prevê manter os dados no logout; não foi feito porque
  exigiria transformar uma cópia de chats executados por outros dispositivos (com ferramentas locais,
  anexos não baixados) em dados locais — fica como evolução.

Testes: `tests/noAccount.test.ts` (fase, persistência no arquivo do SQLite, turno pelo provedor
falso sem nenhuma chamada ao servidor, recusas, anexo, merge com o servidor falso: online vazio,
pergunta, dedupe/remapeamento, prioridade local/online, rede caindo, logout antes/depois) e
`tests/integration/noAccount.test.ts` (servidor real: sem conta → entrar → o "desktop" decifra tudo
→ turno seguinte já com janela → 2º celular sem conta une com prioridade online e o provedor igual
deduplicado). E2E: `E2E_TOOL=list` em `tests/integration/e2eTool.test.ts` mostra o que um segundo
cliente vê na conta.

## Localização (tools do celular)

Duas tools só dos **chats executados neste celular** (`src/location/`, núcleo puro + `native.ts`):

- **`get_location`** — posição atual pelo `expo-location` (só **durante o uso**, nunca em segundo
  plano), precisão em metros e o lugar "humano" (bairro, cidade, estado, país) pelo **geocodificador
  do sistema** (`reverseGeocodeAsync`: Android Geocoder / Apple CLGeocoder — sem chave). Sem resposta
  do sistema → **Nominatim** reverso do OpenStreetMap.
- **`nearby_places`** — pontos de interesse em volta de um centro (posição atual por padrão, `near`
  = nome/endereço geocodificado no Nominatim com o Photon de reserva, ou `latitude`+`longitude`) pela
  **Overpass API** (`overpass-api.de`, reserva `overpass.private.coffee`). `what` em texto livre
  (pt-BR/inglês: restaurante, pizzaria, café, farmácia, mercado, posto, hospital, "restaurante
  japonês"…) vira tags OSM (`amenity`/`shop`/`tourism`/`leisure` + `cuisine`/`diet:*`, `tags.ts`);
  uma tag direta (`amenity=cafe`) também vale; nada reconhecido → busca pelo nome. Por lugar: nome,
  categoria, culinária, distância (calculada no aparelho), endereço, `opening_hours`, telefone, site
  e **links de mapa** (Android `geo:lat,lon?q=lat,lon(nome)`, iOS `maps://?q=…&ll=…`, e o https do
  OpenStreetMap). O Markdown do chat abre `geo:`/`maps:` (sem app de mapas → o link do OSM). A
  descrição avisa o modelo que o OSM não tem avaliações e manda usar `web_search` para isso. Sem SDK
  de mapa nem tiles.

Uso justo dos serviços públicos: User-Agent `ClearChat/<versão> (+https://clear.ezenere.com)`, raio
máximo de 5 km, até 25 lugares (120 elementos pedidos e ordenados aqui), `[timeout:20]` no Overpass e
25 s no cliente, um pedido por vez com intervalo (≥ 1 s no Overpass, ≥ 1,1 s no Nominatim/Photon),
cache de 5 min das consultas idênticas (10 min nas geocodificações), sem uso em lote. A reserva só
entra com a principal sobrecarregada (429/5xx/timeout/rede); consulta recusada (400) não é repetida.

**Configurações → Localização** (preferências do **aparelho**, no kv — não sincronizam):

- **Precisão**: _Aproximada_ (padrão) pede só `ACCESS_COARSE_LOCATION` no Android (o diálogo nem
  oferece a precisa) e aceita a precisão reduzida do iOS; a posição vai **arredondada a 2 casas
  (~1 km)** para o modelo, para o OSM e para o geocodificador, sem a rua. _Exata_ pede
  `ACCESS_FINE_LOCATION` / precisão total; no iOS 14+ com "Localização Precisa" desligada, o pedido
  mostra o aviso de precisão total temporária (`NSLocationTemporaryUsageDescriptionDictionary`,
  chave `ExpoLocationFullAccuracy`). Recusado (nos dois sistemas), o resultado fica aproximado e a
  tool diz isso; o app só insiste uma vez por execução.
- **Aprovação**: _Perguntar_ (padrão) — card "Permitir que o agente veja sua localização?" com o que
  vai para quem ("Sua localização aproximada (~1 km) vai para o modelo e para o OpenStreetMap") e
  "Sempre permitir neste celular"; _Sempre permitir_; _Nunca_ — `get_location` some e o
  `nearby_places` só aceita `near`/coordenadas. Só pergunta quando a posição do aparelho é usada
  (`nearby_places` com `near` roda direto). O mesmo controle aparece em Configurações → Aprovações
  ("Neste celular").
- **Permissão do sistema**: estado (permitida precisa/aproximada, negada, ainda não pedida,
  localização do aparelho desligada), "Permitir agora" e "Abrir configurações do sistema".

Decisões:

- **Ligar a tool é por chat, como as outras** (`config.enabledTools`, sincronizado): o Novo chat e a
  persona listam "Localização" e "Lugares próximos" junto das tools do celular; chats novos as trazem
  ligadas quando a persona não escolhe as tools. Os nomes ficam **fora** do `ToolName`/`TOOL_NAMES`
  do desktop (não dá para editar o outro repositório): o desktop trata nomes desconhecidos em
  `enabledTools` sem quebrar — `normalizeToolList` os mantém, `availableTools` filtra por
  `TOOL_NAMES` (não oferece), `usesLocalTools` não os conta como locais (o celular continua podendo
  executar o chat) e o editor de tools do desktop só os perde se o usuário mexer nas tools lá.
  Mensagens antigas com `get_location` viram card genérico no desktop.
- **Aprovação no aparelho, fora dos `approvalModes`**: o desktop normaliza esse setting por
  `APPROVAL_ITEMS` (descartaria um item novo na próxima gravação), o tipo `ApprovalMode` não tem
  "nunca" e a localização é deste aparelho. O runner usa o `ApprovalRegistry` de sempre (mesmo card,
  mesmo `DENIED_TEXT`), sem `meta.approval` (o `ApprovalItem` do protocolo não tem o item).
- **Diálogo de permissão no meio do turno**: no Android ele pausa a Activity (AppState
  "background"), o que pararia o turno. `src/platform/systemDialog.ts` marca o diálogo e os ouvintes
  de segundo plano (conta/host, avisos locais, voz) ignoram essa pausa.
- Manifesto: o plugin `./plugins/withForegroundOnlyLocation` remove os dois serviços em primeiro
  plano do expo-location; `android.blockedPermissions` bloqueia `ACCESS_BACKGROUND_LOCATION` e
  `FOREGROUND_SERVICE_LOCATION`. iOS: só `NSLocationWhenInUseUsageDescription` (sem as chaves
  "Always"), `NSLocationTemporaryUsageDescriptionDictionary`, sem `UIBackgroundModes` de localização
  e sem o sensor de movimento (`motionUsagePermission: false`) — conferido com `expo prebuild
--platform ios` numa cópia descartável.
- Privacidade: a localização vai só para o provedor do modelo do chat e para o OSM (Overpass,
  Nominatim, Photon) — e para o geocodificador do sistema (Google/Apple); nunca para o servidor do
  ClearChat. O resultado da tool fica no histórico do chat (sincronizado cifrado, como qualquer
  mensagem). Ideia futura: Google Places com chave do usuário (ver `docs/PLAN.md` → Ideias).

Testes: `tests/location.test.ts` (texto → tags, consulta Overpass, distância, arredondamento,
leitura do JSON — fixture inventada em `tests/fakes/osm.ts` —, links, preferências, permissão
negada/pedida/precisão reduzida, serviços desligados, geocodificador do sistema → Nominatim, reservas
do Overpass e do Photon, cache, intervalo, oferta na request e o runner com o provedor falso:
perguntar/permitir/negar/sempre/nunca). O LLM falso ganhou `/where`, `/near <o quê> [raio]` e
`/near-at <lugar> | <o quê>` (devolve o resultado em Markdown, com os links). E2E no emulador:
`adb emu geo fix <lon> <lat>` (ex.: Av. Paulista, `-46.6544 -23.5614`).

## Chats só ao vivo (protocolo 1.8.0)

Contrato: §23 do `SYNC_PROTOCOL.md` (e as mudanças do 1.8.0 em §10.3–10.5, §11, §8.6, §12.7, §14,
§17, §22.7). Código em `src/live/` (visualizador), `src/host/storageChoice.ts` + `chat_storage` no
cache (chats deste celular) e as telas `src/app/(app)/live/[id].tsx` e `src/chat/LiveSection.tsx`.

**Celular como visualizador** dos chats só ao vivo de um PC:

- `hello.caps: ["live_chats"]` sempre; o app só usa `live.*`/`history.*`/`attach.*`/`chat.update`
  com `live_chats` de volta no `welcome.caps`. A escolha no Novo chat precisa também de
  `features.liveChats` em `/api/info` (o último valor conhecido por instância fica no kv — só o
  booleano).
- Lista (`src/live/list.ts`): `live.list` depois de cada `welcome` (e de novo ao abrir o cofre — o
  socket conecta com a conta bloqueada e os anúncios não decifram sem a DEK) substitui tudo; `live.*`
  antes do ack são descartados, os de depois entram por cima numa fila (decifrar é assíncrono). Anúncio
  decifrado com a AAD `live-announce` montada com os campos DE FORA; falha ou `chatId` diferente →
  some. Anti-replay por `arev` no mesmo epoch; epoch novo → o espelho recomeça. Socket caiu → tudo
  "reconectando…"; lista nova com `settling_s` mantém os ausentes até o prazo. Seção "Ao vivo em
  <host>" no topo da lista (agrupada por host, `updatedAt`, status rodando / aguardando você (n) /
  ocioso / reconectando…); some com a busca (§23.9: a busca não acha chats ao vivo).
- Histórico (`src/live/history.ts`): inscrição no stream confirmada → `history.list` do chat, das
  sessões e da principal (todas as páginas, "Carregando de <host>… N mensagens"), `large` por
  pedaços (`history.item { piece }`), `omitted` por `history.item { items }`; `rec` guardados durante
  o carregamento; maior `lseq` vence, exclusões guardadas; `rec` com buraco ou `snapshot.live.lseq`
  maior → `history.changes { since }` (`reset` → recarrega); epoch diferente num resultado → recomeça.
  Subsessões carregam quando abertas. O resultado vira o mesmo `LoadedChat` das telas (versões,
  caminho ativo, cards de tool).
- Stream/comandos pelo `RemoteController` de sempre (gancho `live`: host e status vêm do anúncio,
  não de `chat_states`). Todos os comandos do §8.6 (enviar, fila, ⚡, parar, aprovação, pergunta,
  retry, versões, editar/apagar, compactar, memória, subagentes, `fs.*`) + `chat.update` (renomear,
  trocar o modelo). No máximo 3 `history.*`/`attach.*`/`fs.*` em voo. Fim do turno = anúncio com
  `running: false`; a mensagem do assistente num `rec` troca o draft.
- Anexos (`src/live/attach.ts`): o composer manda ao host por `attach.put` (512 KiB por pedaço, um
  por vez, progresso no chip, retentativa do mesmo pedaço em timeout/queda/socket voltando, `offset`
  recusado → continua do `received`, `expired` → recomeça com outro `uploadId`, remover o chip =
  `cancel`), o `send` leva o `AttachmentInfo` do host. A cópia que o seletor deixa no cache do app é
  apagada depois de lida. Exibir: `attach.get` em pedaços com SHA-256 conferido, cache **em memória**
  (LRU ~96 MiB); imagens viram `data:` com o expo-image só no cache de memória
  (`AttachmentSourceCtx` com `memoryOnly`); PDF/áudio, que só abrem no app do sistema, passam por
  `cache/live-view/`, apagada ao sair do chat, ao bloquear e ao abrir o app (o mesmo para os arquivos
  do host abertos num chat ao vivo).
- **Só em memória**: nada desses chats vai ao SQLite, a arquivos persistentes, ao índice de busca ou a
  logs (os logs de dev só têm ids/contagens). O espelho fica para voltar ao chat sem recarregar (os 3
  últimos) e é descartado quando sai da lista, o epoch muda ou a conta bloqueia/sai. Conferido nos
  testes (contagens das tabelas antes/depois) e no aparelho (`run-as` + busca no `.db`).
- Saiu da lista: `saved_online` → espera o registro chegar e abre o chat comum; `deleted` → "foi
  apagado em <host>"; resto → "não está disponível agora — <host> não está conectado".

**Chats executados no celular — "Salvar online" · "Só neste aparelho"** (§23.10): o celular NÃO
anuncia os dele em 1.8.0. "Só neste aparelho" = linha em `chat_storage` (migração 5, `storage =
live`): o `writeLocal` não põe nada na outbox, o host roda sem janela (`localOnlyChat`), o writer
nunca envia, o pull/resync não mexe na cópia, apagar some sem tombstone. Padrão = última escolha
(`newChatStorage` no kv); instalação nova: só neste aparelho; instalação que já sincronizava antes do
1.8.0: online (gravado na primeira execução). Sem conta: sem seletor, grava o padrão. Servidor sem
suporte: seletor escondido e tudo online. Selo "Só neste aparelho" na lista e no cabeçalho; "Salvar
online" no menu do chat e no toque longo: o chat vira um chat comum criado offline (o `chat` com
`base_rev` = rev do tombstone, se houver, e todo o conteúdo com base 0 na outbox; blobs antes; replay
com `chat_bases = 0`; o celular vira o host). O merge do primeiro login pula esses chats
(continuam locais), a pergunta avisa quantos são e a lista oferece "Salvar online" para todos.

**Notificações (§22.7)**: cada aviso guarda o host (`hostDeviceId` decifrado, senão o
`from_device_id`; e o `hostName`). `host_offline` com `device_id` apaga da bandeja as
aprovações/perguntas/retries daquele host (servidor antigo: pelo nome, só os decifrados); `reply`/
`error` ficam. Tocar num aviso `live` abre o visualizador se o chat estiver na lista (espera até 6 s
a lista chegar), senão "Este chat só ao vivo não está disponível agora — <host> não está conectado".

**Teste e E2E**: `tests/live.test.ts` + `tests/liveStorage.test.ts` (unitários, com o relé
`FakeLiveRelay` de `tests/fakeServer.ts` = `src/live/devRelay.ts` e o host falso `src/live/devHost.ts`),
`tests/integration/live.test.ts` e `tests/integration/localOnly.test.ts` (servidor real). No
emulador: `E2E_TOOL=seed` e depois `E2E_TOOL=livehost E2E_STATE=<arquivo>` (o "desktop" vira um host
de chats ao vivo no WebSocket real; escrever `grace`/`back`/`quit`/`announce`/`stop` em
`<arquivo>.ctl`). Sem servidor 1.8.0: `clearchat://dev/live` (só dev) liga relé + host falsos no
aparelho (`?do=grace|back|drop|quit|saved|off`). `clearchat://dev/push` aceita `hostid=` e `live=1`. No
E2E, `adb shell input text` só traduz `%s` (espaço): `%3F` chega literal — para `?` use
`input text '\?'`.

## Build iOS no Mac

O iOS **nunca foi compilado nem testado** (o desenvolvimento é no Linux). Tudo o que é nativo vem
do `app.json` e dos módulos locais (`modules/argon2/ios`, `modules/secure-screen/ios`).

Pré-requisitos: macOS com Xcode ≥ 16 (e as Command Line Tools), CocoaPods (`brew install cocoapods`),
Node ≥ 22, uma conta Apple (a gratuita serve para rodar no seu iPhone; a paga para TestFlight).

```sh
git clone … && cd ClearChatMobile && npm install
npm run prebuild:ios            # gera ios/ (não versionado — CNG) e roda o pod install
# se o pod install não rodar sozinho:  cd ios && pod install && cd ..
```

Rodar no simulador (debug, JS pelo Metro):

```sh
npx expo run:ios                                  # escolhe um simulador; ou --device para o iPhone
# ou à mão:
open ios/ClearChat.xcworkspace                    # Xcode → esquema ClearChat → ▶
npx expo start                                    # Metro (o app de debug carrega o JS daqui)
```

No iPhone: Xcode → alvo ClearChat → Signing & Capabilities → escolha o seu Team (o bundle id é
`com.ezenere.clearchat`; se já existir na sua conta, troque por um seu só localmente). Build local de
release sem EAS na nuvem: `npx expo run:ios --configuration Release --device`, ou com o EAS CLI
`npx eas-cli build --platform ios --profile development --local` (precisa de um `eas.json`; o build
roda no Mac).

Servidor de testes: o iOS só deixa `http://` para a rede local (`NSAllowsLocalNetworking`) — use o
nome `.local` do Mac (`http://SeuMac.local:8100`) ou um servidor com `https://`. Produção já é https.

**Primeira coisa a conferir — o self-test da cripto** (todos os vetores do protocolo + o Argon2id
nativo, que no iOS é a implementação de referência em C compilada no módulo):

```sh
xcrun simctl openurl booted 'clearchat://dev/selftest'      # simulador
# iPhone: abra o link clearchat://dev/selftest (Notas/Safari) com o app de debug instalado
```

A tela mostra PASS/FAIL e os tempos; a linha `CLEARCHAT_SELFTEST …` sai no console do Metro/Xcode.
Tem que dar **PASS em tudo** (o Argon2id precisa ser byte a byte o dos vetores — no Linux os mesmos
`.c` foram compilados e conferidos contra `kdf.json`).

Depois: login no servidor de testes, desbloqueio, abrir um chat, Configurações (a tela de senha deve
ficar coberta na prévia do seletor de apps — o iOS não bloqueia screenshot), Face ID ("Lembrar" +
"Exigir biometria"), ditado e chamada de voz (o primeiro toque no microfone pede a permissão com o
texto em pt-BR). Problemas prováveis e onde mexer:

- erro de compilação do Argon2 no Swift (`cannot find 'argon2id_hash_raw' in scope`): o podspec
  expõe `argon2.h` como header público com `DEFINES_MODULE` (o Swift do pod enxerga o próprio module
  map). Se o Xcode não o importar, crie `modules/argon2/ios/ClearChatArgon2.h` com
  `#import "vendor/phc-winner-argon2/include/argon2.h"`, inclua-o em `source_files` e em
  `public_header_files` do podspec, e rode `pod install` de novo;
- áudio: a sessão é `playAndRecord` com alto-falante (`ensureAudioMode` em
  `src/voice/nativeAudio.ts`), sem o modo de voz do iOS — ou seja, sem cancelamento de eco, como no
  Android: mantenha "Interromper falando" desligado sem fone;
- `UIBackgroundModes` fica vazio de propósito (chamada e host só em primeiro plano);
- localização: Configurações → Localização → "Permitir agora" (diálogo "durante o uso" em pt-BR);
  com "Exata" e a "Localização Precisa" desligada nos Ajustes, o pedido deve mostrar o aviso de
  precisão temporária; o link `maps://` de um lugar abre o Apple Mapas. No simulador: Features →
  Location → Custom Location.

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
- `desktop/agent/`, `desktop/tools/` ← agente e tools portáveis do desktop (`llm`, adaptadores,
  `textTools`, `smartApprove`, `compaction`, `subagents`, `autoTitle`, `webSearch`, `pageExtract`,
  `models`, `memory`, `chats`, `history`); `desktop/memory/` ← `config`, `render`, `store`, `schema`,
  `extraction`; `desktop/searchIndex.ts` (partes puras da busca). `request.ts`/`util.ts`/
  `memory/service.ts`/`historyStore.ts` são **shims gerados** que reexportam as adaptações do celular
  (`SHIMS` no `vendor.mjs`); `crypto` (randomBytes) vai para `src/platform/nodeCrypto.ts` e
  `better-sqlite3` é só tipo (`src/platform/betterSqlite.d.ts`).
- `renderer/` ← lógica pura da UI do desktop (`src/renderer/src/lib`: `branchView`, `approvalOutcome`,
  `reasoning`, `dates`, `fences`, `math`, `memory`, `skills`, `voice/dictation`, `audio/silence`,
  `audio/pcm`) — sem React/DOM, só `@shared`.
- `desktop/voice/` ← voz (`call`, `stt`, `tts`, `elevenlabs`, `wav`, `voiceCatalog`, …) com shims para
  `clips`, `evalLog` e `elevenlabsStream`; `desktop/agent/contextCapture.ts` (resumidor do
  Smart-Approve). `node:crypto` ganhou `createHash('sha256')` (chave do cache do catálogo).

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
modules/argon2/        módulo Expo local (Kotlin + argon2kt; Swift + referência em C no iOS)
modules/secure-screen/ módulo Expo local (FLAG_SECURE; capa na prévia/gravação no iOS)
scripts/               vendor.mjs, platformAliases.cjs (redirecionamentos Metro/Vitest), test-server.sh
src/account/           conta: máquina de estados, AccountService, captcha, Keystore/kv do aparelho
src/app/               telas (expo-router): (auth), (app) [chats, chat/[id], new, settings/*], dev/selftest.tsx
src/chat/              conversa: modelo puro (viewModel), linhas das mensagens, cards de tool, Markdown, anexos
src/data/              sync de dados: SQLite (store), motor (pull/ao vivo/push/resync), anexos, ligação com a conta
src/remote/            controle remoto: espelho do stream, comandos §8.6, anexos (upload), arquivos do host
src/agent/             agente no celular: request, runner, tools portáveis (vendorados + adaptações)
src/host/              chats executados no celular: outbox, janelas, troca de host, recusas, novo chat,
                       divergência com versão local, send_to_chat entre dispositivos
src/memory/            memória: índice local (SQLite em memória) + outbox LWW + MemoryService
src/settings/          Configurações: registros/serviço (outbox LWW) + componentes das telas
src/location/          localização: tags OSM, Overpass, Nominatim/Photon, links de mapa, preferências, aparelho
src/voice/             voz: STT/TTS pela API, sessão, microfone (expo-audio/teste), fila de
                       reprodução, chamada (VoiceCallManager vendorado + sensor), ditado
src/crypto/            cripto do protocolo para o app (reexporta a vendorada)
src/platform/          polyfills e trocas para o Hermes
src/selftest/          casos dos vetores + checagens da plataforma (Vitest e aparelho)
src/ui/                tema (tokens do desktop) e componentes
src/vendor/            cópias geradas — não editar
tests/                 Vitest (unitários) e tests/integration/ (servidor real)
```

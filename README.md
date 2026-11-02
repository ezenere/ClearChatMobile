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
  `unlock`, `recover` (cada fase libera só as suas via `Stack.Protected`); `(app)` = `settings/*`
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
  fila/turno continuado, preâmbulo, frases de demora, interjeições, TTS por frase, barge-in,
  histórico só com o ouvido, `end_call`, marcadores e custos), `turnMachine`, `sentences`,
  `callErrors`, `stt.ts` (erros/nome do arquivo/idioma/custo), `tts.ts` + `elevenlabs.ts` (REST
  `/audio/speech` e ElevenLabs, PCM progressivo juntado), `wav.ts`, `voiceCatalog.ts` (modelos e
  vozes do provedor), `shared/voiceTurn` (`AdaptiveTurnGate`, `classifyUtteranceEnd`) e
  `shared/voicePolicy` (`InterjectionWatcher`, `PlaybackHold`, `VoicedSpan`), e do renderer
  `voice/dictation.ts` (ponto de inserção, prévia, desfecho, erros de captura) e
  `audio/{silence,pcm}.ts`. **Shims**: `voice/clips.ts` → `src/voice/clips.ts` (mesmas frases e o
  mesmo hash da definição; bytes num cache próprio), `voice/evalLog.ts` e
  `voice/elevenlabsStream.ts` → só os tipos (`src/voice/evalLog.ts`, `src/voice/ttsFeed.ts`).
- **Escrito para o celular** (`src/voice/`, sem React Native exceto `native*.ts`/`react.ts`):
  `endpoints.ts` (settings normalizadas, provedor resolvido pelo id — chave só em memória —, forma
  gravada sem as partes do dispositivo, "só no computador" para Local/GPU), `stt.ts`
  (`transcribeAudio` do desktop com o multipart montado em bytes — o `Blob` do RN não aceita bytes),
  `session.ts` (o subconjunto API da sessão do desktop: parciais melhor-esforço, especulação na
  pausa, final reaproveitada, uma nova tentativa na falha transitória), `mic.ts` (quadros PCM16 de
  32 ms a 16 kHz; `FakeMicSource`), `player.ts` (fila de reprodução: ordem, sem sobreposição,
  drop/cancel com fade, ganho, PCM → WAV), `call.ts` (o "sensor" do `useVoiceCall` do desktop +
  o `VoiceCallManager` + a pré-checagem), `dictation.ts`, `stack.ts`, `nativeAudio.ts` (expo-audio)
  e `native.ts` (instância, microfone de teste, segundo plano).
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
  botão **Interromper** faz o barge-in; "Interromper falando (use fone de ouvido)" (opção deste
  aparelho, §4.4) liga o barge-in por voz do desktop.
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
**dock** no lugar do composer (fase, relógio, nível, texto da fala, mudo, Interromper, desligar,
"Gerar clipes"); menu → "Chamada de voz…" (config de voz do chat). Configurações → **Voz**: ditado,
transcrição, fala (provedor/modelo/voz pela listagem do provedor, parâmetros do modelo pelos specs do
desktop, "Testar voz"), padrões da chamada (disponível, `end_call`, prompt-base, modelo, preâmbulos,
frases de demora, interjeições, fim de turno) e "Neste aparelho" (barge-in, microfone de teste em
dev, "Gerar clipes"). Persona → aba **Voz** (`src/settings/VoiceConfigEditor.tsx`).

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
sessão, TTS OpenAI/ElevenLabs, settings, clipes, fila, ditado com o microfone de teste e a chamada
inteira — turno, `meta.voice`, `end_call`, marcadores codificados, custos —, meia-duplex +
Interromper), `tests/capture.test.ts` e `tests/integration/voice.test.ts` (servidor real: settings do
"desktop" → ditado e chamada no celular → o desktop decifra marcadores/falas/`end_call`/persona).

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
- `UIBackgroundModes` fica vazio de propósito (chamada e host só em primeiro plano).

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
src/voice/             voz: STT/TTS pela API, sessão, microfone (expo-audio/teste), fila de
                       reprodução, chamada (VoiceCallManager vendorado + sensor), ditado
src/crypto/            cripto do protocolo para o app (reexporta a vendorada)
src/platform/          polyfills e trocas para o Hermes
src/selftest/          casos dos vetores + checagens da plataforma (Vitest e aparelho)
src/ui/                tema (tokens do desktop) e componentes
src/vendor/            cópias geradas — não editar
tests/                 Vitest (unitários) e tests/integration/ (servidor real)
```

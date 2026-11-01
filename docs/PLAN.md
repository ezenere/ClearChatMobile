# ClearChat Mobile — plano

App Android (iOS depois) em **Expo SDK 58 / React Native 0.88**, com dev build (`expo prebuild`) —
precisamos de módulos nativos. Implementa o protocolo de sync v1.5.0.

## Escopo

1. **Controle remoto completo** dos chats que rodam no desktop: ver ao vivo (stream §11), mandar
   mensagens (com anexos e skills do host), fila, forçar, parar, aprovações (por item), Smart-Approve
   override, questionários, retry, regenerar, editar/apagar mensagens, versões (branches), compactar,
   extrair memória, parar subagentes, visualizar arquivos do host (`fs.list`/`fs.read`), fixar host.
2. **Host no celular** para chats **sem ferramentas locais**: o agente roda no aparelho chamando os
   provedores direto (OpenRouter, Anthropic nativa, OpenAI-compatible), com ferramentas básicas —
   pesquisa na web, `browse_url` (fetch), memória, `ask_user`, `list_models`, entre chats e subagentes.
   Só com o app em primeiro plano (o SO suspende em segundo plano).
3. Configurações sincronizadas: provedores, personas, memórias, pesquisa na web, novos chats, conta,
   dispositivos.
4. Depois: voz (ditado e chamada), notificações, iOS.

## Arquitetura

```
src/
  vendor/            cópias geradas (npm run vendor) — NÃO editar
    protocol/        ../docs: SYNC_PROTOCOL.md + test-vectors
    shared/          ../ClearChatDesktop/src/shared (tipos, branches, modelParams, askUser, approvalPolicy…)
    desktop/         ../ClearChatDesktop/src/main: sync/{http,ws,stream}, agent/{adapters,textTools,compaction},
                     tools/{webSearch,ddg,brave,searchApis,pageExtract,models,chats}
    site/            ../ClearChatWebsite/frontend/src: crypto/*, data/branches, lib/password
  platform/          polyfills e trocas para RN (crypto.subtle, deflate, Argon2 nativo, fetch com
                     streaming, AbortSignal.any, randomUUID, TextEncoder)
  account/           conta, chaves, sessão, WebSocket da conta (fase 1)
  data/              cache expo-sqlite, SyncEngine (pull/ao vivo/push LWW/resync), anexos (fase 2)
  chat/              modelo da conversa (caminho ativo), linhas das mensagens, cards, Markdown (fase 2)
  remote/            espelho do stream, comandos remotos §8.6, upload de anexos, arquivos do host (fase 3)
  sync/              (fase 4) host no celular (máquina de estados §8 sem tools locais)
  agent/             loop enxuto: request → adapter → SSE → tools portáveis → registros
  ui/                telas (expo-router), componentes, tema
```

Trocas de plataforma (sem WebAssembly no Hermes, sem `crypto.subtle`, sem `CompressionStream`):
- Argon2id: módulo nativo, validado nos vetores (mesma saída do hash-wasm).
- AES-GCM/HKDF/HMAC/SHA-256: `@noble/ciphers` + `@noble/hashes` (ou `react-native-quick-crypto`).
- deflate-raw: `fflate`. Aleatoriedade: `expo-crypto`. SSE: `expo/fetch` com streaming.
- DEK e tokens: `expo-secure-store`. Cache/memória/FTS: `expo-sqlite`. Captcha: `react-native-webview`.

## Fases

| Fase | Entrega | Verificação |
|---|---|---|
| 0. Fundação ✅ | Expo dev build Android rodando no emulador; TS estrito, ESLint/Prettier; `vendor`/`vendor:check`; camada `platform/`; cripto passando em **todos** os vetores | `npm test` (vetores), build debug instalado no AVD |
| 1. Conta ✅ | Login por código (captcha via WebView), registro do dispositivo, desbloqueio por senha/chave de recuperação, DEK no SecureStore, sair/revogado | contra servidor local (Docker) |
| 2. Dados ✅ | Pull/push + cache SQLite, realtime (`sync.changes`), lista de chats, leitura com versões, Markdown, anexos (blobs) | idem + testes do Repo |
| 3. Controle remoto ✅ | Estado do host, stream ao vivo, todos os comandos §8.6, cards de aprovação/questionário/retry, fila, upload de anexos, arquivos do host | desktop (build local) hospedando + celular controlando |
| 4. Host no celular | Novo chat, persona, modelo e parâmetros; loop do agente com tools portáveis; `host.begin/takeover`, janelas, publicar stream, aceitar comandos; recusa chats com tools locais | celular hospedando + desktop controlando |
| 5. Configurações | Provedores, personas, memórias, pesquisa na web, dispositivos, conta | e2e |
| 6. Voz e iOS | Ditado/chamada; build iOS no Mac | — |

## Testes

- Unitários (Vitest, Node) nos módulos puros e na cripto (vetores).
- Integração contra o servidor local (`docker compose` do `../ClearChatWebsite` na máquina de dev).
- UI no emulador (Maestro ou adb + uiautomator), com screenshots revisados.

## Fase 1 — estado (2026-10-31)

Feito: escolha do servidor (oficial/self-host validado por `/api/info`, aviso de `http://`), login por
código (colar/autofill, reenviar com espera, 429 com `Retry-After`), registro do dispositivo
(`client: mobile`, `platform`, `can_host: true`, nome editável), captcha §15 (WebView isolada, nonce,
`/captcha/done` interceptado), setup de chaves no aparelho (mesmo fluxo do site: chave de recuperação
mostrada antes do envio, confirmação dos 4 últimos), desbloqueio por senha (Argon2id nativo) e por chave
de recuperação (senha nova obrigatória + sugestão de nova chave), "Lembrar neste dispositivo",
bloquear, sair (revoga), refresh rotativo no corpo, fim de sessão por 401/403/4403
(`device_revoked`, `account.deleted`), `keys.changed`/`keys.reset`, WebSocket fechado em segundo plano.
Verificado: `npm test` (servidor falso), `npm run test:integration` (servidor real local) e E2E no
emulador com adb + uiautomator (servidor local, código lido do log, desbloqueio, reabrir lembrado,
bloquear → recuperação, revogação pelo "site", setup, sair).

Pendências / TODO:
- **Biometria**: implementada (`requireAuthentication`, entrada separada, cancelado → senha), mas só
  aparece com biometria cadastrada; o AVD de teste não tem digital — não foi exercitada no emulador.
  Testar num aparelho real (e no emulador com `adb emu finger touch` após cadastrar PIN + digital).
- **Captcha**: lógica coberta por testes unitários; não exercitado no aparelho (o servidor local roda
  sem a página `/captcha` do site e sem Turnstile). Testar contra uma instância com o site + chaves de
  teste da Cloudflare.
- `FLAG_SECURE` (bloquear screenshot/tela de recentes) nas telas da chave de recuperação e senha.
- Trocar senha de criptografia e lista/revogação de dispositivos nas Configurações (fase 5; o
  `AccountService` já tem `changePassword`/`renameDevice`).
- Mensagem do `hello` falho no WebSocket vem do `ws.ts` vendorado (`console.warn`, sem segredos).

## Fase 2 — estado (2026-10-31)

Feito: cache local no `expo-sqlite` (registros com plaintext decifrado uma vez, cursor, migrações,
índices para lista/prévia/FTS5/estados de host), `SyncEngine` (pull paginado + `records/fetch`, ao vivo
pelo `sync.changes` quando contíguo, resync no `410`, cascatas, revisão antiga ignorada, registros
opacos/quebrados isolados, primitivo LWW com conflito e "exclusão vence"), anexos CCB1 sob demanda com
SHA-256 conferido, wipe no logout/revogação/`keys.reset`/troca de conta, AES-GCM nativo (expo-crypto,
conferido contra o noble antes do uso e nos vetores do self-test; ~85× mais rápido), lista de chats
(busca por título e conteúdo, persona, prévia do caminho ativo, selo do host, puxar para atualizar,
estados carregando/vazio/offline, renomear/apagar com confirmação), conversa somente leitura (sessões,
versões com ‹ i/n › só na tela, todos os tipos de mensagem do desktop, Markdown próprio sobre `marked`,
FlashList), anexos (miniatura, tela cheia com zoom, PDF no visualizador do sistema). Decisões e detalhes:
README § "Dados (fase 2)".
Verificado: `npm test` (126, servidor falso + `node:sqlite`), `npm run test:integration` (conta + dados
contra o servidor real local, seed como desktop, ao vivo pelo WebSocket), self-test no aparelho (67/67)
e E2E no AVD com adb + uiautomator (login, lista, conversa longa, versões, card de tool, imagem em tela
cheia, rename/delete ao vivo vindos do "desktop", renomear/apagar/buscar no celular, reabrir offline com
cache, sair apaga o cache).

Pendências / TODO:
- **Outbox offline**: escrita (renomear/apagar) exige conexão; fila local com `dirty_fields` fica para as
  fases 3/5 (junto com as escritas de conteúdo e configurações).
- **Bloquear não cifra o cache**: avaliar SQLCipher (`expo-sqlite` `useSQLCipher`) com chave derivada da DEK.
- Fórmulas sem KaTeX (texto monoespaçado); código sem realce de sintaxe.
- Pinça no visualizador de imagem só testada por duplo toque no emulador (adb não faz multitoque).
- `present_file` mostra o card genérico (os arquivos ficam no host — `fs.read` é da fase 3);
  `ProcessStartInfo` e as aprovações pendentes/ao vivo também chegam com o stream (fase 3).
- Prévia/ordem da lista usam `chat.updatedAt` (o host reenvia o registro a cada mensagem, §4.3.6).

## Fase 3 — estado (2026-11-01)

Feito: `src/remote/` (espelho ao vivo com snapshot/deltas/buracos/drafts encerrados, cliente de todos os
kinds do §8.6 com K_stream + AAD de comando, timeouts, `remote.failed`, recusas em pt-BR, `fs.list`/
`fs.read`, `host.pin`, descartar versão divergente, upload de anexos antes do envio) e as telas: composer
(anexos, skills do host, fila com ⚡/✕, ⚡ forçar, parar, status), resposta ao vivo (raciocínio, Markdown,
tools), cards de aprovação (por item, Smart-Approve, whitelist/blacklist), questionário, retry,
"Executar mesmo assim", subagentes, ações das mensagens (folha no toque longo), versões no host, menu do
chat (fixar, arquivos, processos, compactar, memórias, parar subagentes), faixas de host offline/sem
host/sem conexão/divergência/troca, arquivos do host (pastas, texto paginado, imagem). Detalhes: README §
"Controle remoto (fase 3)".
Verificado: `npm test` (171; 45 novos em `tests/remote.test.ts`: vetores realtime, espelho, comandos,
fs, pedaços/UTF-8, anexos), `npm run test:integration` (com o host falso: todos os kinds, anexos, fixar,
queda do host) e E2E no AVD com o **desktop real** hospedando (stream ao vivo, fila + forçar, ⚡, parar,
aprovação por item executando o shell no PC, questionário com ajuda/múltipla/Outro, retry após corte de
rede, regenerar, trocar versão no host, editar como nova versão, editar no lugar, apagar, imagem da galeria,
arquivos do host com "Carregar mais", fixar host, compactar, extrair memórias, host offline → banner →
takeover pelo desktop). Screenshots em `scratchpad/mobile/phase3/`.

Pendências / TODO:
- "Executar neste dispositivo" (`host.takeover`) e chat sem host → fase 4 (host no celular, só chats sem
  ferramentas locais). A faixa explica e não oferece a ação.
- Divergência: só "Descartar a versão de <D>" (o celular nunca tem versão local nesta fase); a resolução
  com versão local chega com o host no celular.
- Subagentes, Smart-Approve com juiz e processos não foram exercitados no E2E com o desktop (o provedor
  falso não delega nem roda processos); cobertos pela integração (stop_subagents, smart_override) e pelos
  unitários (processos no espelho).
- Texto digitado no composer pelo `adb input text` perde caracteres quando a UI re-renderiza no meio —
  só no teste (digitar caractere a caractere resolve); avaliar se acontece com teclado real.
- Outbox offline para comandos não existe (protocolo: comandos só com o host online).

# ClearChat Mobile — plano

App Android (iOS depois) em **Expo SDK 58 / React Native 0.88**, com dev build (`expo prebuild`) —
precisamos de módulos nativos. Implementa o protocolo de sync v1.10.0.

## Escopo

1. **Controle remoto completo** dos chats que rodam no desktop: ver ao vivo (stream §11), mandar
   mensagens (com anexos e skills do host), fila, forçar, parar, aprovações (por item), Smart-Approve
   override, questionários, retry, regenerar, editar/apagar mensagens, versões (branches), compactar,
   extrair memória, parar subagentes, visualizar arquivos do host (`fs.list`/`fs.read`), fixar host.
2. **Chats executados no celular** (sem ferramentas locais): o agente roda no aparelho chamando os
   provedores direto (OpenRouter, Anthropic nativa, OpenAI-compatible), com ferramentas
   conversacionais — pesquisa na web, `browse_url` (fetch), memória, `ask_user`, `list_models`, entre
   chats e subagentes — e as de localização só do celular (`get_location`, `nearby_places`). Só com o app em primeiro plano (o SO suspende em segundo plano). **Decisão de
   produto:** chats executados no celular não são controlados remotamente (as tools são só
   conversacionais): o celular não publica o stream e recusa comandos remotos; um computador que quiser
   o chat o traz com "Executar neste dispositivo" (§8.8) e continua lá.
3. Configurações sincronizadas: provedores, personas, memórias, pesquisa na web, novos chats, conta,
   dispositivos.
4. Depois: voz (ditado e chamada), notificações push (1.7.0), iOS.

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
  host/              (fase 4) chats executados no celular: janelas §8.3, outbox com chat_bases/host_epochs,
                     troca de host, recusa de tools locais e de controle remoto, espelho local da tela
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
| 4a. Host no celular ✅ | Novo chat (persona, modelo, parâmetros, tools portáveis); loop do agente (web_search, browse_url, ask_user, list_models, aprovações/Smart-Approve); janelas `host.begin/end`, revisões com `chat_bases`/`host_epochs`; "Executar neste dispositivo"; o PC importa o chat (§8.8); recusa chats com tools locais e controle remoto; segundo plano interrompe | celular executando + desktop recusado/importando |
| 4b. Host no celular (resto) ✅ | Memória (tools + extração), subagentes, entre chats, `read_history`, compactação, título automático e chamadas laterais; execução offline e divergência com versão local (§9) | idem |
| 5. Configurações ✅ | Provedores, personas, memórias, pesquisa na web, novos chats, aprovações, dispositivos, conta (trocar senha, chave de recuperação, lembrar/biometria); FLAG_SECURE nas telas sensíveis | unitários + integração + e2e com o desktop real |
| 6. Voz e iOS ✅ (Android) / iOS preparado, **não testado** | Ditado no composer; chamada de voz nos chats do celular; Configurações → Voz e aba Voz da persona; coleta de contexto do Smart-Approve; ponto de status com a conexão; módulos iOS (Argon2 em C, capa de tela) e "Build iOS no Mac" | unitários + integração + e2e no AVD (microfone de teste) com o desktop real; iOS: só o prebuild no Linux e os vetores do Argon2 compilando os mesmos `.c` |

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
- ~~`FLAG_SECURE` nas telas da chave de recuperação e senha~~ (fase 5).
- ~~Trocar senha de criptografia e lista/revogação de dispositivos nas Configurações~~ (fase 5).
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
- **Bloquear não cifra o cache**: avaliado na fase 5 (SQLCipher) — ver "Fase 5 — estado" (recomendação: adiar).
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

## Fase 4a — estado (2026-11-01)

Feito: `src/agent/` (llm/adaptadores/textTools/juiz do Smart-Approve/webSearch/pageExtract/models
**vendorados**; request, providers, anexos da request, registros e o runner escritos para o celular),
`src/host/` (outbox persistida no SQLite com `chat_bases`/`host_epochs`, janelas, troca de host, recusas,
espelho local) e as telas (Novo chat com persona/modelo/parâmetros/tools; a conversa troca entre "este
celular" e controle remoto com o mesmo composer e os mesmos cards; selo "Executando neste celular";
"Executar neste dispositivo" no menu e na faixa de host offline). Decisão de escopo: o celular não é
controlado remotamente (sem stream publicado; todo `remote.command` recusado com texto em pt-BR); o PC
importa o chat por `host.takeover` — o celular para o turno na hora (parcial `interrupted`), envia a
outbox, fecha a janela e libera (a fila vai junto em `forwarded`). Detalhes: README § "Host no celular (fase 4a)".
Verificado: `npm test` (198; 27 novos em `tests/agent.test.ts` e `tests/host.test.ts`), `npm run
test:integration` (host contra o servidor real com o provedor falso: turnos, web_search com aprovação,
recusa do controle remoto, recusa de tools locais, PC assumindo no meio do turno e continuando, segundo
plano), prova do streaming no aparelho (`clearchat://dev/streamtest`: 1º delta em 136 ms de 24 s, 403
atualizações — sem buffering; parse5 roda no Hermes) e E2E no AVD com o desktop real. Screenshots em
`scratchpad/mobile/phase4a/`.

Pendências / TODO (resolvidas na 4b, exceto as marcadas):
- ~~Memória, subagentes, entre chats, `read_history`, compactação, título automático~~ (4b). A coleta
  automática de contexto do Smart-Approve (resumidor) continua só no desktop.
- ~~Execução offline e divergência com versão local~~ (4b).
- ~~Fila descartada ao ir para o segundo plano~~ (4b: guardada e devolvida).
- O teto do `beforeBackground` depende de timers, que o Android pausa no segundo plano: o gancho não usa
  timers (envio direto), mas um gancho travado deixaria o socket aberto até o SO matá-lo.
- `browse_url` não executa JavaScript (fetch + extração): páginas montadas só no cliente vêm vazias.
- A regra `usesLocalTools` vem vendorada do desktop (`@shared/sync`).

## Fase 4b — estado (2026-11-02)

Feito: memória no celular (`src/memory/`: `MemoryStore`/schema/config/índice/extração e as tools
`memory_*` do desktop **vendorados** sobre um índice SQLite em memória montado dos registros; outbox LWW
persistida para `memory`/`memory_collection` com merge por campo e "exclusão vence"; colisão de slug
§4.3.5; índice congelado por sessão no campo `memory` do registro `session`; extração depois da
compactação e "Extrair memórias agora"; folha "Memória…" com coleções ativas e onde o agente grava);
subagentes com a semântica do desktop (`subagents.ts` vendorado: bloqueante/segundo plano, callbacks que
acordam o pai, `waiting`, check/wait/cancel/message, irmãos com limite, "Parar subagentes", parada em
cascata silenciosa, subagentes abandonados por versão nova param sem callback, subsessões apagadas com
a mensagem); entre chats (`chats.ts` vendorado + `send_to_chat` local ou por comando `send` ao host
remoto, `src/host/interChat.ts`); `read_history` (`history.ts` vendorado + `history_fts` no cache);
compactação pedida/automática/"compactar e tentar de novo" (`compaction.ts` vendorado, `insertAt`);
título automático e "Gerar título" (`autoTitle.ts` vendorado); turno que termina sem servidor e outbox em
replay; divergência com versão local (§9.2 no motor + `src/host/divergence.ts` + painel com as duas
versões e a confirmação obrigatória); fila guardada no segundo plano e devolvida no primeiro plano.
Detalhes e decisões: README § "Host no celular (fase 4b)".
Verificado: `npm test` (215; 17 novos em `tests/phase4b.test.ts`), `npm run test:integration` (com
`tests/integration/phase4b.test.ts`: memória celular→PC e PC→celular, subagente sincronizado,
`send_to_chat` ao chat executado no host falso do PC, divergência resolvida mantendo a local e a online)
e E2E no AVD com o desktop real (memória gravada e lembrada em outra sessão, coleção visível nas
Configurações do desktop, extração, subagente em segundo plano acordando o pai, `send_to_chat` ao chat do
PC, compactação manual com extração automática, título automático, modo avião no meio do turno →
replay, takeover do PC com o celular offline → divergência → "Manter a deste celular", e o PC pedindo o
chat com o celular voltando a tempo → troca sem divergência). Screenshots em `scratchpad/mobile/phase4b/`.

Pendências / TODO:
- `send` remoto não leva `meta` (§8.6): no host remoto a mensagem de `send_to_chat` chega como texto do
  usuário com o cabeçalho de origem (sem `kind: 'inter-chat'`, sem contagem de saltos do lado de lá).
  Mudança de protocolo sugerida: `meta?: Pick<MessageMeta, 'kind'|'fromChatId'|'fromChatTitle'|'interChatHops'>` no `send`.
- Desktop: o `send_to_chat` dele entrega localmente mesmo quando o chat de destino é executado em outro
  dispositivo (inclusive no celular, que recusa comandos) — precisa passar pelo portão do sync.
- ~~Criar/editar coleções e memórias à mão no celular~~ (fase 5).
- ~~Coleta automática de contexto do Smart-Approve (resumidor) segue só no desktop.~~ (fase 6)
- ~~O ponto verde do status do composer não muda sem conexão (a faixa explica).~~ (fase 6)

## Fase 5 — estado (2026-11-02)

Feito: Configurações no celular (`src/settings/` + `src/app/(app)/settings/`), com os mesmos grupos e a
mesma semântica do desktop: **Novos chats** (persona padrão, modelo padrão, system prompt padrão, título
automático com modelo/memórias/limite/prompt, limite de saída das tools), **Personas** (lista com
estrela = padrão, criar/editar/duplicar/apagar; editor com Modelo + parâmetros, Chat, Tools — as que
rodam no celular e as só do computador — e Memória: é a persona que define as coleções ativas dos
chats novos), **Aprovações** (modo global por item, padrões do Smart-Approve com o modelo do
resumidor, whitelist/blacklist de comandos/processos/páginas), **Memórias** (coleções por categoria:
criar/editar/apagar com as memórias; memórias à mão: título, resumo, detalhes com subir/descer,
"Sempre carregar", mover, substitui/substituída, apagar; busca FTS), **Pesquisa na web** (ordem,
liga/desliga, chave de API mascarada, resultados, profundidade do Tavily, intervalo; Brave pelo site
marcado "só no computador"), **Provedores** (OpenAI-compatible, OpenRouter, Anthropic, ElevenLabs;
chave mascarada; headers extras; "Testar conexão" = `testProvider` do desktop, inclusive `/key` do
OpenRouter e `/v1/models` da ElevenLabs; "Ver modelos" → usar como padrão), **Dispositivos** (atual
marcado, online/visto há…, renomear qualquer um, desconectar os outros com confirmação; desconectar o
atual = sair) e **Conta** (renomear este aparelho, lembrar/biometria com o cofre aberto, trocar senha
de criptografia, nova chave de recuperação, bloquear, sair). A antiga tela "Conta" (`home.tsx`) virou
`settings/account.tsx`; o botão da lista de chats abre as Configurações.

Decisões:
- **Toda escrita pela outbox LWW** (`src/data/lww.ts`, a mesma das memórias da 4b): o cache muda na hora
  e sobe depois — funciona offline. `provider`/`preset` = LWW por campo; para `config` da persona o
  patch vai **chave a chave** e as chaves removidas ("Usar o padrão") seguem em `__configUnset` (só
  orienta o merge, nunca vai ao servidor); `setting` = LWW inteiro. O formulário guarda a versão que
  abriu e salvar aplica só o que o usuário mudou sobre a versão atual (`mergeEdits`): não desfaz uma
  edição feita no PC enquanto a tela estava aberta. A outbox agora é retomada ao abrir o cofre e quando
  o WebSocket volta (`startSettings`) — na 4b só uma escrita nova a disparava.
- **Trocar senha pede a senha atual** (conferida no aparelho: Argon2id + desembrulhar e comparar a DEK;
  errada → nada vai ao servidor). O protocolo só exige a DEK em memória (o desktop não pede); no celular,
  mais fácil de ficar desbloqueado na mão de outra pessoa, a senha atual é exigida. A DEK não muda.
- **FLAG_SECURE** por um módulo nativo local mínimo (`modules/secure-screen`, `setSecure` com contagem
  de telas no JS, ligado só com a tela em foco via `useFocusEffect`) em vez do `expo-screen-capture`, que
  adiciona permissões de armazenamento/mídia ao manifesto. Telas: desbloqueio, recuperação, setup, nova
  chave de recuperação, trocar senha, editor de provedor e Pesquisa na web. Chaves digitadas ficam na
  própria tela (o `Modal` do Android é outra janela e não herda o flag).
- Settings do aparelho (§4.4) continuam locais: "lembrar"/biometria no kv/Keystore; nada de pasta.
- Tipos do desktop que não dava para vendorar: o formulário do provedor (`renderer/src/lib/provider.ts`
  importa React e o IPC) foi portado para `src/settings/records.ts`; o resto é vendorado (memória da UI:
  `toggleCollection`/`setWriteTarget`/`moveTargets`/`cleanField`…, `webSearchSettings`, `approvalPolicy`,
  `smartDefaults`, `autoTitle`, `presets`).
- **Cuidado com o React Compiler (de novo)**: `menu!.id` dentro de um callback passado como prop vira
  dependência lida no render (`Cannot read property 'id' of null` com o menu fechado). Nos callbacks,
  testar e usar (`if (!menu) return; … menu.id`), nunca `!.`. As leituras do cache nas telas passam
  pela versão (`readAt(version, …)`) para o compilador refazê-las quando o motor avisa
  (`DataEvent.settings`, novo: provedores, personas, settings e memórias que chegam por pull/ao vivo).

Verificado: `npm test` (228; `tests/settings.test.ts` com 10 novos — formulário, patch/merge com
chaves removidas, persona sem `cwd`, buscadores, e o serviço contra o servidor falso: provedor mesclado
com o PC, persona "usar o padrão" offline enquanto o PC muda o prompt, LWW inteiro de setting, chave e
lista do web_search, coleção + memória e apagar a coleção — e 3 em `tests/account.test.ts`: trocar senha
com a atual, lembrar/biometria, dispositivos), `npm run test:integration` (com
`tests/integration/settings.test.ts`: celular grava → desktop decifra com o esquema do §4.3, desktop muda
→ celular recebe ao vivo, conflito na persona mesclado, offline → sobe ao reconectar, cascata da coleção,
padrão apagada, dispositivos renomear/desconectar, troca de senha com a DEK igual) e E2E no AVD com o
**desktop real** (provedor criado no celular com teste de conexão e modelo padrão → visto no desktop;
provedor renomeado no desktop → ao vivo no celular; persona com modelo/parâmetro/memória → desktop;
persona padrão → o Novo chat abre com ela; coleção + memória à mão, fixada → desktop; desktop edita a
memória → ao vivo; chave do Tavily + ligar + ordem → desktop; título automático, aprovação e whitelist
→ desktop; renomear o PC e desconectar a sessão do site (401 depois); trocar senha → a antiga não abre
mais nem no celular nem no desktop, a nova abre nos dois; lembrar desligar/ligar; FLAG_SECURE conferido
no `dumpsys window` e no screencap preto). Screenshots em `scratchpad/mobile/phase5/` (as telas com
FLAG_SECURE foram revisadas pelo framebuffer do emulador — `adb emu screenrecord screenshot`, lado do
host).

**SQLCipher (avaliação, não implementado).** O `expo-sqlite` suporta SQLCipher (`useSQLCipher` no
plugin + `PRAGMA key`). Para valer a pena: o cache só abre depois do desbloqueio, com chave derivada da
DEK só neste aparelho (ex.: HKDF(DEK, "clearchat/mobile/cache")), e bloquear fecha o banco. Hoje o
`LocalStore` abre no import (`src/data/native.ts`) e é usado por todos os módulos antes do cofre: seria
refatorar o ciclo de vida (abrir/fechar com a sessão), migrar (o mais simples: apagar o cache e puxar de
novo) e ainda cifrar à parte os anexos decifrados em `Documents/attachments/`, que o SQLCipher não
cobre. Ganho real só com "Lembrar" desligado — lembrado, a DEK está no Keystore e o app abre sozinho; e
o Android já cifra os dados do app em repouso (FBE) com o aparelho bloqueado. **Recomendação: adiar**;
fazer junto com a cifra dos anexos e um modo "não lembrar" mais visível, se a ameaça "aparelho
desbloqueado e extraído" entrar no escopo.

Pendências / TODO:
- A integração completa passa do limite anti-abuso do servidor (20 códigos/h por IP, §17.3): rodar em
  dois lotes com o servidor reiniciado entre eles (account/data/e2eTool/host · phase4b/remote/settings).
- Biometria: o interruptor "Exigir biometria" só aparece com biometria cadastrada — não exercitado no AVD
  (sem digital); coberto pelo teste unitário do `setRemember`.
- ~~Áudio (STT/TTS/chamada)~~ (fase 6); Skills só desktop.
- O desktop mostra o nome dele em cache depois de ser renomeado pelo celular (só no próprio desktop; o
  servidor e os outros dispositivos veem o novo nome).
- No E2E, digitar com `adb input text` dentro de um `Modal` (diálogo) com dois "r" seguidos recarrega o
  app de desenvolvimento (atalho RR do RN): artefato do teste, não do app.

## Fase 6 — estado (2026-11-02)

Feito (Android): **ditado** no composer (chats deste celular e controle remoto: microfone → STT pela
API das settings sincronizadas → texto no ponto do cursor com as funções puras do desktop;
`meta.voice = { source: 'dictation' }` no envio dos chats daqui; parada por silêncio e "segurar para
falar"); **chamada de voz** nos chats executados aqui (`VoiceCallManager` do desktop vendorado inteiro
+ o "sensor" do renderer portado: fim de turno adaptativo com especulação, ~~interjeições~~ (saíram
em 2026-11-12 — ver "Voz: desktop 92005b8"), preâmbulos
com clipes gerados no aparelho, frases de demora, TTS por frase, turno continuado, barge-in pelo botão
Interromper, `end_call`, marcadores §4.3.8 com custos, histórico só com o ouvido); **Configurações →
Voz** (`audioInput`/`sttSettings`/`ttsSettings`/`voiceCallDefaults`, gravados sem as partes do
dispositivo; Local/GPU "só no computador"; catálogo de modelos/vozes do provedor; parâmetros pelos
specs do desktop; "Testar voz"; "Gerar clipes"; barge-in e microfone de teste como opções deste
aparelho); aba **Voz** da persona (`src/settings/VoiceConfigEditor.tsx`) e "Chamada de voz…" no
menu do chat; **coleta automática de contexto do Smart-Approve** no celular (`contextCapture.ts`
vendorado); **ponto de status** do composer com a conexão; **iOS preparado**: `modules/argon2/ios`
(Swift + phc-winner-argon2 20190702 em C, saída conferida contra `kdf.json` compilando os mesmos `.c`
no Linux, com e sem threads), `modules/secure-screen/ios` (capa na prévia do seletor de apps e na
gravação/espelhamento — o iOS não bloqueia screenshot), `app.json` (bundle id, microfone e Face ID em
pt-BR, `NSAllowsLocalNetworking`, sem `UIBackgroundModes`; o `expo-image-picker` deixava de bloquear
o `RECORD_AUDIO`) e "Build iOS no Mac" no README. Detalhes e trade-offs: README § "Voz (fase 6)".

Decisões:
- **expo-audio 58** para tudo: `AudioStream` (PCM em tempo real) no microfone e `AudioPlayer` por
  frase. Sem biblioteca extra nem módulo nativo próprio. Custos: sem cancelamento de eco (a fonte é a
  MIC) → meia-duplex por padrão (microfone surdo enquanto o assistente fala; Interromper pelo botão;
  barge-in por voz só com fone, opção do aparelho); sem PCM progressivo → cada frase toca quando a
  síntese termina; sem o WebSocket da ElevenLabs.
- **Transcrição só pela API**; "Local" nunca vaza o áudio para a API sem o usuário escolher (explica);
  "Híbrido" = API no celular.
- O `transcribeAudio` vendorado monta `FormData` com `Blob` de bytes, que o RN não aceita: o celular
  tem uma cópia que monta o multipart em bytes (testada contra a vendorada no Node: mesmos campos).
- Clipes: mesmas frases e mesmo payload de hash do desktop (pós-processamento próprio); bytes em
  `Documents/voice-clips/`.
- Microfone de teste por polling (`/mic/next`), não por deep link: entregar um intent pausa a
  Activity, e o app trata como segundo plano (encerra a chamada) — o mesmo vale para o diálogo de
  permissão do microfone, que agora é ignorado nessa regra.

Verificado: `npm test` (14 novos em `tests/voice.test.ts` e `tests/capture.test.ts`),
`npm run test:integration` (com `tests/integration/voice.test.ts`) e E2E no AVD (`hw.audioInput=no`
conferido em `hardware-qemu.ini`, `-no-audio`, microfone de teste + fixtures do `espeak-ng`, LLM/STT/
TTS falsos) com o **desktop real**: settings de áudio do desktop no celular e `silenceStopMs` do
celular no desktop; gerar clipes; "Testar voz" (ExoPlayer toca e termina); ditado com parciais →
parada por silêncio → texto inserido → enviado com o selo de ditado; chamada completa (marcador de
início, fala → Transcrevendo/Pensando/preâmbulo/Falando com "mic em pausa" → resposta falada →
despedida → `end_call` → marcador de fim "pelo agente · US$ 0,0008") e o desktop mostrando a mesma
chamada; ditado no composer do controle remoto (texto chega ao PC, sem `meta.voice`); ponto
amarelo sem conexão e verde de volta; persona com voz → desktop; permissão negada (aviso em pt-BR) e
concedida (o `AudioStream` nativo abre a 16 kHz mono — no emulador sem entrada de áudio do host ele
recebe um sinal sintético do próprio emulador, nunca o microfone real). Screenshots em
`scratchpad/mobile/phase6/`.

**Não testado:**
- **iOS inteiro** (nem compilado): módulos Swift (Argon2, capa de tela), áudio (sessão
  `playAndRecord`, `AudioStream`), Face ID, ATS. Roteiro no README § "Build iOS no Mac".
- **Microfone real** e alto-falante de verdade (regra dos testes): eco, nível/limiar do
  `AdaptiveTurnGate` (0,01 RMS) com um microfone de celular, latência real dos provedores.
- Provedores reais de STT/TTS (só os falsos; nada pago).
- Barge-in por voz com fone ("Interromper falando" — hoje "Falar por cima da resposta") só nos
  unitários.

Pendências / TODO:
- Protocolo: o `send` remoto (§8.6) não leva `meta.voice` — ditado no controle remoto chega como texto
  digitado. Sugestão: `meta?: { voice: { source: 'dictation' } }` no `send`/`force`.
- Desktop: mover a parte pura de `src/main/voice/clips.ts` (frases, `clipVoiceId`, payload do hash)
  para um módulo sem `node:fs`/`hash-wasm`, e permitir injetar o corpo multipart em
  `transcribeAudio` (ou montá-lo em bytes) — o celular passaria a vendorar em vez de copiar.
- O STT falso escolhe o texto pela duração de voz: a parcial do ditado pode mostrar o começo de outro
  fixture (artefato do falso, não do app).
- O nível do microfone re-renderiza o dock a ~30 Hz: o `uiautomator dump` fica lento durante a
  chamada (para o E2E, screenshots + log do Metro).
- Clipes não são aparados (o desktop apara o silêncio das pontas).

## Voz: desktop 92005b8 — estado (2026-11-12)

Feito (Android; o vendorado veio do desktop 92005b8 + protocolo 8d6e074, sem mudança de versão):
- **Sem interjeições**: nada de "Uhum/Aham", `InterjectionWatcher`, modo sombra nem clipes de
  interjeição (shim `clips.ts` só com `FILLER`; `evalLog.ts` com o `VoiceEvalEvent` novo). Os
  escritores do celular nunca reenviam `interjections` (`src/data/legacy.ts` no plaintext antes de
  cifrar, em chat/persona/`voiceCallDefaults`; `repo.chat()` normaliza).
- **Frases de demora espaçadas** (vendorado): a fila do celular avisa o `playback-idle` quando
  esvazia — o FIM de cada frase curta —, de onde o main conta os intervalos; padrões 8 s/15 s na tela.
- **Falar por cima = ducking** (`PlaybackDuck` vendorado): rampa de ganho no `UtteranceQueue`
  (`setDuck`, ~80 ms em passos de 16 ms no volume do `AudioPlayer`), restore depois do silêncio,
  barge-in por voz/palavras (parciais ao vivo da chamada — `livePartials`)/ordem de parada; vale com
  "Falar por cima da resposta (use fone de ouvido)" ligado (sem fone o microfone segue surdo durante a
  fala). Tela: "Falar por cima da resposta" (os 4 limiares de `voiceCallDefaults.turn`).
- **Portão de ativação de fala** (`speechGate` vendorado): `LevelGate` nos quadros do microfone da
  chamada (início de fala, ducking, barge-in) e `SpeechGate` + pós-filtro em TODA via da sessão de
  STT do celular (parciais, especulação, final; chamada e ditado), com o piso de ruído entre sessões.
  `audioInput.activationDb` local (kv `voice.activationDb`), fora do registro; tela "Nível de
  ativação" com medidor ao vivo, linha do nível, arrastar/−/+ e "Testar" (único que abre o microfone).
- **Tags de voz**: toggle ★ + instrução editável + "Usar o padrão" + aviso de voz sem suporte na
  persona/chat; interruptor + instrução no padrão global; nota das tags ao lado do modelo de fala.
  No chat (local, controle remoto, ao vivo) as tags aparecem no lugar em 0,65 (fora de código).
- **Ouvido em palavras + leitura ao vivo**: barge-in (voz ou botão Interromper) manda `current`
  (`currentPosition` do player: `currentTime`/`duration` do expo-audio, ou a duração do WAV); o
  runner do celular grava o prefixo ouvido + "…" e `meta.voice.unheard`. Enquanto a resposta é falada
  aqui, o resto dela fica em 0,5 avançando palavra por palavra (`src/voice/follow.ts`); depois de uma
  interrupção, o resto não ouvido aparece esmaecido depois de "interrompido" (também no controle
  remoto e no viewer ao vivo).
- **Herança sem opção duplicada**: `src/settings/InheritChoice.tsx` (+ regra pura em `inherit.ts`)
  no editor de voz: Disponível, Prompt na chamada, O agente pode encerrar, Preâmbulos, Tags de voz.
  "Tools na chamada" ("Iguais ao chat"/"Escolher") não é uma escolha de herança com opção duplicada —
  virou o interruptor "Tools próprias na chamada", como no desktop.
- Fala: modelos sem lista de vozes (Fish Audio pelo OpenRouter) mostram a dica e aceitam o link
  `fish.audio/m/<id>` colado (`fishVoiceIdFrom` vendorado); a lista de vozes segue o modelo. O celular
  nunca teve o atalho "Usar OpenRouter (ElevenLabs Flash)".

Decisões:
- O esmaecimento no React Native é pela COR com alfa (o `opacity` não vale em `Text` aninhado) e o
  "ainda não falado" entra no Markdown como um marcador de uso privado no texto-fonte (o renderer
  percorre os tokens do marked na ordem) — `src/chat/voiceText.ts`.
- Parciais ao vivo na chamada seguem `sttSettings.livePartials` (como no desktop): mostram a fala no
  dock e dão as palavras do barge-in; o portão de fala impede parciais de silêncio.

Verificado: `npm run typecheck`, `npm run lint`, `npm test` (novos em `tests/voice.test.ts` — portão
de fala, `activationDb` fora do registro, `interjections` nunca reenviado, fila com ducking/posição,
chamada com fone: tosse → volume de volta, insistir → barge-in em palavras com `unheard`, tags tiradas
da síntese — e `tests/voiceText.test.ts`) e E2E no AVD (`-no-audio`, microfone de teste por polling,
LLM/STT/TTS falsos, chat "Só neste aparelho"): medidor do nível de ativação (ruído abaixo da linha,
fala acima — "Fala detectada"), "Falar por cima da resposta", tags no padrão global com o aviso de voz
sem suporte, chamada com a leitura ao vivo (o resto da frase esmaecido, avançando), tosse por cima →
"falando por cima · voz baixa" → volume de volta, "Espera aí…" por cima → barge-in (`stop-word` pela
parcial ao vivo) → mensagem "…ondas que batem na…" + "interrompido" + o resto esmaecido, tag `[risos]`
em 0,65, e a aba Voz da persona/chat com as ★. Screenshots em `scratchpad/mobile/voice2/`.

Notas para o desktop (vendorado, não corrigido aqui): `sentences.ts` trata "mar." como abreviação
(março) — "…sobre o mar. Depois…" não corta a frase (o E2E trocou o texto). O `npm run vendor` da
fatia seguinte (frases de ferramenta, desktop 1a68ecd/protocolo a92f548) ficou pendente.

## Voz por persona (protocolo 1.9.0) e frases de ferramenta — estado (2026-11-12)

Feito (vendor do desktop ed06271 / protocolo 8562ba3 e a92f548):
- **Frases de ferramenta**: classe `TOOL` no shim `clips.ts` (hash por classe; clipes por voz — a voz
  entra na chave, gerar os de uma não apaga os de outra; clipes antigos de interjeição somem),
  utterance `kind: 'tool'` (pulável), Configurações → Voz → "Frases de ferramenta" (liga/desliga,
  frases por categoria, "Restaurar padrão"), ★ na aba Voz; `get_location`/`nearby_places` → `location`.
- **Settings de voz locais**: tabela `device_settings` (migração 6 copia o último valor sincronizado);
  `SettingsService` grava as 4 ids aqui; o merge ignora as online e remapeia as daqui; nada sobe.
- **Voz da persona/chat**: `src/voice/resolve.ts` (capacidades do celular = provedores; fallback com o
  motivo; `voiceUse`/`settingsWith`); chamada decidida no início (`callUse`); ditado com a transcrição/
  idioma do chat (composer de chats daqui, controle remoto e ao vivo); Novo chat sem `tts`/`stt`
  (`withoutVoiceChoice` vendorado de `lib/voice/voiceChoice.ts`, junto com os textos dos ícones);
  seções Fala/Transcrição (`VoiceChoiceSections.tsx`) na persona e no "Chamada de voz…" do chat;
  telefone/microfone esmaecidos com o motivo (toque mostra) e o aviso do fallback; nota "Padrões deste
  aparelho" em Configurações → Voz.

Verificado: typecheck, lint, `npm test` (novos: `tests/voicePersona.test.ts`, casos 1.9.0 e de frases de
ferramenta em `tests/voice.test.ts`, merge em `tests/noAccount.test.ts`) e E2E no AVD (`-no-audio`,
microfone de teste, LLM/STT/TTS falsos): migração dos settings de voz (valores mantidos), nota do
aparelho, editor das frases de ferramenta, persona com voz própria (seletores, "Gerar clipes desta
voz"), chat herdando ao vivo ("Usando a voz da persona “Padrão”"), ★ das frases de ferramenta,
chamada com a voz da persona (`voz: tts-persona` no selo) e a frase de ferramenta do clipe da persona
(`list_chats` → "Deixa eu ver as informações."), ícones esmaecidos com o motivo. Screenshots em
`scratchpad/mobile/voice3/`. `tests/integration/voice.test.ts` atualizado (não rodado — servidor real).

Não testado: o fallback no AVD (só nos unitários — o seletor do celular só oferece provedores daqui).

Depois (vendor do desktop 2f16271): **sem prompt oculto** — Configurações → Voz sem prompt-base, só o
"Prompt do modo voz" da persona/chat (vazio, "Usar sugestão") e a prévia "O que a chamada muda no
prompt" (`VoicePromptPreview.tsx`, na aba Voz e em Configurações → Voz); **preâmbulo só se demorar**
("Espera do preâmbulo", 2,5 s); **abaixar a voz só depois de 500 ms** de fala seguida (evento `'duck'`
do `PlaybackDuck`; "Abaixar a voz depois de"; barge-in em 1,2 s). Persona → "Ambiente no system
prompt": o bloco do celular por extenso (`environmentBlock()`), fora do grupo "No computador";
`browse_url` com descrição própria do celular (`MOBILE_BROWSE_URL_DESCRIPTION` em `src/agent/request.ts`).
Verificado: typecheck, lint, `npm test` (402) e no AVD (screenshots 13–17 em `scratchpad/mobile/voice3/`,
modo sem conta — a sessão de teste do emulador tinha sido encerrada). `vendor:check` acusa
`shared/voice.ts`/`voicePolicy.ts` só porque a árvore do desktop tem edições não commitadas depois do
2f16271 (a cópia vendorada = 2f16271).

Depois (vendor do desktop 9d52737): **frases de espera** — o ruído durante a espera só pausa (o sensor
do celular já reporta fala vazia/"uhum" como `turn('')`, que retoma a contagem); "manter viva" após 8 s
de silêncio desde o fim da última fala (pools "pensando"/"ferramenta rodando", máx. 2 por turno, nunca
esperando o usuário); "obrigado por aguardar" (4,5 s, clipe `THANKS_<n>` ou síntese em paralelo) no
lugar da desculpa. Celular: classe `THANKS` no shim `clips.ts` (+ `thanksPool` nos clipes da chamada e
da persona), seção "Frases de espera" (`DelayPhrasesSettings.tsx` — os dois tempos e os três pools com
"Restaurar padrão"), aviso de clipes do dock sem o agradecimento. Testes: ruído na espera, ferramenta
demorada → "manter viva" → agradecimento, resposta rápida → sem agradecimento, clipes `THANKS`.

Correção: fala da chamada começando com "/" cortada na bolha ("/chats" → "/", "/sleep 16000 resposta
demorada" → "/sleep 16000 resposta"). Causa: Android 15+ (targetSdk 36) — o `TextView` usa os limites dos
glifos para a largura (`useBoundsForWidth`) e o RN mede pelo avanço; o "/" itálico no começo desce à
esquerda da origem → o texto medido para uma linha quebra no TextView e a 2ª linha fica fora da bolha.
Só texto encolhido ao conteúdo (a bolha do usuário — itálica só nas falas da chamada); digitado com "/"
(reto), "[", "J" e itálico sem "/" no começo não quebravam. Plugin `withTextBoundsForWidth` (estilo
padrão dos TextView com `useBoundsForWidth=false`); vale para chat local, controle remoto e ao vivo (o
mesmo `MessageRow`). O desktop/site não têm o problema (HTML). Verificado no AVD com o APK debug
refeito; o APK de `dist/` precisa ser refeito para levar a correção.

Depois (= desktop a7946ab, sem mudança no vendor): **sem a prévia "O que a chamada muda no prompt"**
(`VoicePromptPreview.tsx` apagado — repetia os dois campos de texto). Na aba Voz da persona/chat a
ordem é "Prompt na chamada" → "Prompt do modo voz" → "Tags de voz" (com a instrução), os dois textos
que a chamada acrescenta na ordem da request; Configurações → Voz fica só com a nota de que o app não
acrescenta prompt próprio. `voicePromptLayout` (vendorado) continua no cálculo da request.

## Notificações push (1.7.0) — estado (2026-11-06)

Feito: `src/push/` (decisão §22.7 pura com `K_push`/AAD e os vetores de `push.json`; tarefa do
expo-notifications que roda com o app fechado; registro do token nativo do FCM com `PUT`/`DELETE
/devices/current/push`; permissão do Android 13+ com convite e explicação ao negar; toque → chat, a
frio também; canais pendências/respostas/erros/host offline com visibilidade privada; chat aberto não
avisa; avisos locais dos chats executados aqui), Configurações → Notificações, "notificações ativas"
nos Dispositivos, Firebase por `app.config.js` (+ variável de arquivo `GOOGLE_SERVICES_JSON` no EAS).
Detalhes: README § "Notificações push".
Verificado: `npm test` (30 em `tests/push.test.ts` + os casos de `push.json` no self-test),
`tests/integration/push.test.ts` contra o servidor real (com conta de serviço falsa), e no AVD: token
real do FCM registrado; convite → negar → "bloqueadas" → configurações do sistema → "Ativas";
avisos pela rota `/dev/push` (decifrado, genérico, descartes, dismiss, chat aberto, toque a quente e
a frio) e a cadeia **desktop real → servidor → FCM falso local → app**: aprovação com trecho (turno
do celular), dismiss ao aprovar no PC, resposta, PC ausente → resposta, cofre bloqueado → genérico,
desktop morto → host offline. Screenshots em `scratchpad/mobile/push/`.

Pendências / TODO:
- **Entrega real pelo FCM não testada** (nem a tarefa num processo sem tela): o servidor com a conta
  de serviço real foi bloqueado pelo controle de permissões desta sessão. Roteiro no README.
- Tela bloqueada: o Android esconde o conteúdo (visibilidade privada) e mostra "Conteúdo oculto",
  não o texto genérico do protocolo (o expo-notifications não monta `publicVersion`).
- Dismiss do "host offline" ao religar não exercitado (o desktop religado entrou como dispositivo novo).
- Aprovar/negar pela notificação: fase seguinte. iOS (APNs pelo FCM): depois.

## Usar sem conta — estado (2026-11-06)

Feito: "Usar sem conta" na primeira tela (fase `local` da conta, persistida; "Entrar numa conta" nas
Configurações leva ao login normal e "Continuar sem conta" volta). Tudo funciona só no aparelho sobre
o **mesmo cache e as mesmas outboxes** (dono `local`; `syncAllowed` zera as chaves do sync até o
merge): provedores, personas, chats executados aqui (sem janela de escrita), memórias, settings, voz,
anexos. Recursos só com conta (sync, controle remoto, dispositivos, push, conta/segurança) somem ou
explicam com "Entrar numa conta". Onboarding: sem provedor, a lista leva a "Adicionar provedor" e
depois ao "Novo chat" (que oferece "Usar como modelo padrão"). Entrar depois faz o **merge do
primeiro login (§12)** — porta do desktop: online vazio sobe tudo; os dois com dados → "Priorizar
online · Priorizar local" (contagens, chats conflitantes); dedupe com id canônico online,
remapeamento do §12.5, idênticos sem envio, replay com `chat_bases = 0`, blobs antes. Detalhes:
README § "Usar sem conta".

Decisões:
- **Logout igual a hoje** (apaga o cache da conta; o diálogo agora diz isso); depois, "Usar sem conta"
  começa do zero. Manter a cópia (o §12 prevê) exigiria converter chats de outros hosts em locais.
- Sair antes de concluir o merge não apaga os dados sem conta; erro de rede no merge → "Tentar de novo".
- O merge do desktop (`engine.ts`) é amarrado ao SQLite dele: portado para `src/data/merge.ts` (mesmas
  regras e normalizações), não vendorado. Sugestão para o desktop: extrair `dedupe`/`remapConfig`/
  `normName`/`normBase` para `src/shared` (puros) — o celular passaria a vendorar.

Verificado: `npm test` (287; 12 novos em `tests/noAccount.test.ts`), `npm run test:integration` (com
`tests/integration/noAccount.test.ts`: sem conta → entrar → o "desktop" decifra tudo; 2º celular une
com prioridade online e o provedor igual deduplicado) e E2E no AVD (instalação limpa → "Usar sem
conta" → provedor apontando para o LLM falso → chat → reabrir o app com os dados → entrar no servidor
local com uma conta que já tinha dados → pergunta → "Priorizar local" → os chats dos dois lados na
lista, e um segundo cliente vendo o chat criado sem conta e o turno seguinte) + APK release (x86_64,
chave descartável) no AVD. Screenshots em `scratchpad/mobile/noaccount/`.

Pendências / TODO:
- "Priorizar local" com chats conflitantes (mesmo id dos dois lados) só nos unitários — no uso real os
  ids sem conta são novos (o conflito aparece se um dia o logout mantiver os dados).
- iOS: não testado (como o resto).

## Localização — estado (2026-11-06)

Feito: tools **`get_location`** (posição "durante o uso" pelo `expo-location`, precisão, lugar pelo
geocodificador do sistema com o Nominatim de reserva) e **`nearby_places`** (Overpass com reserva;
centro = posição atual, `near` geocodificado no Nominatim/Photon ou coordenadas; texto livre → tags
OSM; distância no aparelho; endereço, horário, telefone, site e links `geo:`/`maps:`/OSM tocáveis no
chat) nos chats executados no celular (`src/location/`). Configurações → Localização (precisão
Aproximada/Exata, aprovação Perguntar/Sempre/Nunca, estado da permissão com atalho para o sistema) e
o mesmo controle em Aprovações → "Neste celular"; card de aprovação dizendo o que vai para quem.
Detalhes e decisões: README § "Localização (tools do celular)".

Decisões:
- Ligar a tool por chat/persona em `config.enabledTools` (sincronizado; nomes fora do `TOOL_NAMES`
  do desktop, que os ignora sem quebrar); precisão e aprovação **só no aparelho** (o `approvalModes`
  sincronizado é normalizado pelo desktop e não tem "nunca").
- Aproximada = só `ACCESS_COARSE_LOCATION` e coordenadas com 2 casas (~1 km) para o modelo, o OSM e o
  geocodificador; Exata pede a fina (iOS: precisão total temporária) e, recusada, cai para a
  aproximada avisando.
- Diálogo de permissão no meio do turno não conta como segundo plano (`src/platform/systemDialog.ts`).

Verificado: `npm test` (31 novos em `tests/location.test.ts`), typecheck, lint, `vendor:check`,
`expo prebuild --platform ios` numa cópia descartável (só "When In Use", chave de precisão temporária,
sem modos de segundo plano) e E2E no AVD sem conta com o LLM falso e posição falsa (`adb emu geo
fix`): card → diálogo do Android só com "aproximada" → turno continua → resultado arredondado + link
abrindo o Google Maps; `nearby_places` com o Overpass real (pizzarias, ~1 min com a instância pública
lenta; a primeira tentativa estourou o teto de 25 s → teto ajustado para 45 s por instância/70 s no
total); "Exata" → diálogo de troca para precisa → "manter aproximada" → aviso; precisa concedida →
5 casas e rua; `near` pelo Nominatim real (farmácias na Sé); permissão negada → faixa + configurações
do sistema + erro legível no chat. Screenshots em `scratchpad/mobile/location/`.

Pendências / TODO:
- **iOS não testado** (só o prebuild): diálogo "durante o uso", precisão total temporária com a
  "Localização Precisa" desligada, `maps://` abrindo o Apple Mapas, `CLGeocoder`.
- Desktop: um card próprio para `get_location`/`nearby_places` no histórico (desde o 1.10.0 o desktop
  conhece os nomes e rótulos — `@shared/deviceTools` —, preserva-os nas listas e os mostra esmaecidos
  em "Só no celular").
- Política de privacidade do site: acrescentar o parágrafo de localização (texto no relatório desta
  entrega; não editado aqui).
- Overpass público às vezes leva perto de 1 min (fila da instância): avaliar mostrar "ainda buscando…"
  com mais destaque ou uma instância própria.

## Chats só ao vivo (1.8.0) — estado (2026-11-06)

Feito: o celular como **visualizador** dos chats só ao vivo de um PC (`src/live/`): `caps:
["live_chats"]`, seção "Ao vivo em <host>" na lista (status, reconectando…, some quando o host fecha o
app ou depois da tolerância), visualizador `live/[id]` com o histórico sob demanda (`history.*`,
pedaços, `rec`, buracos → `history.changes`, `reset`, epoch novo) e todos os comandos remotos +
`chat.update` (renomear, trocar o modelo), anexos ao host por `attach.put` (progresso, retomada,
cancelar) e do host por `attach.get` (sha256, memória), arquivos do host; **nada gravado** (só
memória; temporários de PDF/áudio apagados). Chats do celular com a escolha **"Salvar online" · "Só
neste aparelho"** (`chat_storage`, padrões do §23.1, merge do primeiro login pulando os locais,
"Salvar online" depois em replay). Push: host de cada aviso, `host_offline` apaga as pendências do
host, toque em aviso ao vivo. Detalhes: README § "Chats só ao vivo (protocolo 1.8.0)".

Decisões:
- Visualizador numa tela própria (`live/[id].tsx`) reusando linhas, cards, painéis e composer — a
  tela do chat comum lê o cache e mistura host local; separar garante que nada do ao vivo toque o
  SQLite.
- Relé e host falsos em `src/live/devRelay.ts`/`devHost.ts` (dev/testes) — os testes os usam pelo
  `tests/fakeServer.ts` e a rota `clearchat://dev/live` também.
- Retentativa do `attach.put` também em `disconnected`: abrir o seletor de arquivos põe o app em
  segundo plano e a conta fecha o WebSocket (visto no E2E).
- A AAD `live-announce` veio vendorada da cripto do site (o agente do servidor já a acrescentou).

Verificado: `npm test` (367; 49 novos: 33 em `tests/live.test.ts`, 7 em `tests/liveStorage.test.ts` e os 9 casos de `live.json` no self-test),
`tests/integration/live.test.ts` e `tests/integration/localOnly.test.ts` contra o servidor local com o
código 1.8.0 do agente do servidor (lista, histórico, enviar, anexo de 1,2 MiB em 3 pedaços,
`chat.update`, `live.withdraw quit`, queda → tolerância → some; chat só local nunca no servidor e
"Salvar online" com o celular virando host), o resto da integração sem regressão, e E2E no AVD com o
host roteirizado (`E2E_TOOL=livehost`) no servidor real. Screenshots em `scratchpad/mobile/live/`.

Pendências / TODO:
- **E2E com o desktop real** como host (depois do agente do desktop) — roteiro no relatório.
- "Tirar do servidor" (online → só neste aparelho, §23.8) não existe no celular (só a volta, "Salvar
  online"); o celular não anuncia os chats dele (decisão do §23.10).
- "Salvar online" não confere a cota antes (`GET /account`, DEVERIA no §23.8).
- Logout continua apagando o cache — inclusive os chats "Só neste aparelho" (o diálogo avisa que
  apaga os dados deste aparelho).
- iOS: não testado (como o resto).

## Herança ao vivo da persona (protocolo 1.10.0) — estado (2026-11-12)

Feito (vendor do desktop a5d91f1): config efetiva em tudo que roda ou exibe um chat, Novo chat com
`overrides` só do que mudou, editar/voltar a herdar/trocar de persona/"Nenhuma", migração depois do pull
e na inicialização sem conta, congelamento antes do tombstone da persona (e ao recebê-lo), merge 3-way do
registro `chat` com a base guardada na outbox, tela "Configurações do chat" (também para chats só ao
vivo, por `chat.update`), contagem de chats por persona e a nota em "Novos chats". Detalhes: README §
"Herança ao vivo da persona".

Verificado: typecheck, lint, `npm test`, `vendor:check`, `tests/integration/chatInherit.test.ts` e o
resto da integração contra o servidor local, e as telas no AVD com uma conta do servidor local.

Pendências / TODO:
- "Salvar como persona" a partir do chat (o desktop tem) não existe no celular.
- Os campos sem editor no celular (aprovações, Smart-Approve, skills, tools no prompt…) só aparecem
  com o valor e a origem (e "voltar a herdar" quando são do chat); editar é no computador.

## Tools de um tipo de aparelho (protocolo 1.10.0) — estado (2026-11-13)

Feito (vendor do desktop 1badaa2, `@shared/deviceTools`): a lista de tools é a mesma em todo aparelho;
o Novo chat não marca mais nada como próprio por causa do aparelho (antes: ~15 "neste chat" — as do
computador desligadas e as de localização ligadas); o celular hospeda chats com ferramentas locais sem
elas (sem a recusa; `availableTools` só oferece o que roda) e, ao assumir um chat assim, mostra o aviso
forte com confirmação; as do computador aparecem esmaecidas e alternáveis (configurações do chat,
persona, Novo chat, tools da chamada) e a contagem "N são ferramentas só do computador" saiu; a
migração só marca própria a diferença numa tool do tipo de aparelho em que o chat rodou (`hostCwd`);
"Voltar a herdar tudo" não torna mais o chat inexecutável aqui (sem nenhum caso especial).

## Ideias

- Google Places como provedor opcional de lugares (avaliações, fotos, horários mais completos) — pago,
  com chave do usuário.

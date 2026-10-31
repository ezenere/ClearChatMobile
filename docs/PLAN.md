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
  sync/              conta, chaves, Repo (pull/push com cache expo-sqlite), realtime, mirror do stream,
                     comandos remotos, host (máquina de estados §8 sem tools locais)
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
| 0. Fundação | Expo dev build Android rodando no emulador; TS estrito, ESLint/Prettier; `vendor`/`vendor:check`; camada `platform/`; cripto passando em **todos** os vetores | `npm test` (vetores), build debug instalado no AVD |
| 1. Conta | Login por código (captcha via WebView), registro do dispositivo, desbloqueio por senha/chave de recuperação, DEK no SecureStore, sair/revogado | contra servidor local (Docker) |
| 2. Dados | Pull/push + cache SQLite, realtime (`sync.changes`), lista de chats, leitura com versões, Markdown, anexos (blobs) | idem + testes do Repo |
| 3. Controle remoto | Estado do host, stream ao vivo, todos os comandos §8.6, cards de aprovação/questionário/retry, fila, upload de anexos, arquivos do host | desktop (build local) hospedando + celular controlando |
| 4. Host no celular | Novo chat, persona, modelo e parâmetros; loop do agente com tools portáveis; `host.begin/takeover`, janelas, publicar stream, aceitar comandos; recusa chats com tools locais | celular hospedando + desktop controlando |
| 5. Configurações | Provedores, personas, memórias, pesquisa na web, dispositivos, conta | e2e |
| 6. Voz e iOS | Ditado/chamada; build iOS no Mac | — |

## Testes

- Unitários (Vitest, Node) nos módulos puros e na cripto (vetores).
- Integração contra o servidor local (`docker compose` do `../ClearChatWebsite` na máquina de dev).
- UI no emulador (Maestro ou adb + uiautomator), com screenshots revisados.

# CLAUDE.md — ClearChat Mobile

> ⚠️ **AVISO — PROTOCOLO DE SYNC COMPARTILHADO**
> Este repositório faz parte da pasta `ClearChat/` (repositório pai com o que é compartilhado) junto com
> `../ClearChatDesktop` (app) e `../ClearChatWebsite` (servidor/site). O protocolo tem fonte única em
> `../docs/SYNC_PROTOCOL.md`; o mobile **consome**, não define. Mudanças no protocolo, na criptografia,
> nos esquemas dos registros, nos endpoints ou no WebSocket são feitas primeiro no pai (versão +
> changelog), implementadas no app e no servidor e só depois aqui. `npm run vendor:check` falha se a cópia
> local divergir. Regras gerais: `../CLAUDE.md`.

- Plano e fases: `docs/PLAN.md`. Contrato do sync: o `SYNC_PROTOCOL.md` vendorado em `src/vendor/protocol/`.
- Código compartilhado é **vendorado** (copiado) de `../ClearChatDesktop`, `../ClearChatWebsite` e `../docs` para
  `src/vendor/` por `npm run vendor` (lista em `scripts/vendor.mjs`). Nunca edite `src/vendor/` à mão:
  corrija na origem e revendore. `npm run vendor:check` confere byte a byte.
- A cripto DEVE passar em todos os vetores de `docs/test-vectors` (`npm test`).
- `client: 'mobile'`, `can_host: true` — mas o celular **recusa ser host** de chats com ferramentas locais
  (§8.9: shell, arquivos, processos, skills). Como controle remoto, faz tudo o que o desktop faz.
- Chave de dados (DEK) e refresh token só no `expo-secure-store` (Keychain/Keystore), nunca em SQLite,
  AsyncStorage ou logs.
- UI e textos em pt-BR; identificadores em inglês. Tema escuro com os tokens do app desktop.
- Testes: nunca usar dados reais do usuário nem gastar cota de API paga sem autorização; servidor de
  teste local (Docker do `../ClearChatWebsite`), nunca produção.
- Commits sem trailer de co-autoria de IA.

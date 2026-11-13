#!/usr/bin/env node
// Vendoriza (copia) código compartilhado dos repositórios irmãos para src/vendor/.
//   npm run vendor        → copia (e apaga arquivos que saíram da lista)
//   npm run vendor:check  → falha se qualquer cópia divergir da origem (ignora o cabeçalho)
// A lista abaixo é explícita; os imports relativos/`@shared/...` dos .ts são seguidos
// automaticamente (fecho transitivo) para nada ficar pendurado. Imports externos precisam estar em
// EXTERNALS (resolvidos pela camada src/platform/ — ver metro.config.js e vitest.config.ts).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'src/vendor')
const PARENT = resolve(ROOT, '..')

/** Grupos: origem (relativa à pasta-mãe dos repositórios) → destino em src/vendor/. */
const GROUPS = {
  protocol: {
    from: 'docs',
    files: [
      'SYNC_PROTOCOL.md',
      'test-vectors/kdf.json',
      'test-vectors/recovery.json',
      'test-vectors/keys.json',
      'test-vectors/records.json',
      'test-vectors/blobs.json',
      'test-vectors/realtime.json',
      'test-vectors/ids.json',
      'test-vectors/branches.json',
      'test-vectors/push.json',
      'test-vectors/live.json'
    ]
  },
  site: {
    from: 'ClearChatWebsite/frontend/src',
    files: [
      'crypto/index.ts',
      'crypto/constants.ts',
      'crypto/encoding.ts',
      'crypto/primitives.ts',
      'crypto/kdf.ts',
      'crypto/keys.ts',
      'crypto/envelope.ts',
      'crypto/blob.ts',
      'crypto/setup.ts',
      'lib/password.ts',
      'data/voice.ts'
    ]
  },
  shared: {
    from: 'ClearChatDesktop/src/shared',
    files: [
      'types.ts',
      'branches.ts',
      'sync.ts',
      'modelParams.ts',
      'providerKinds.ts',
      'providerDraft.ts',
      'askUser.ts',
      'approvalPolicy.ts',
      'presets.ts',
      'memory.ts',
      'tools.ts',
      'defaults.ts',
      'context.ts',
      'limits.ts',
      'attachments.ts',
      'interChat.ts',
      'siblings.ts',
      'network.ts',
      'models.ts',
      'webSearchSettings.ts',
      'autoTitle.ts',
      'voiceCallMarks.ts',
      'remoteFs.ts',
      'smartApprove.ts',
      'contextCapture.ts',
      // fase 6: voz (turno adaptativo, política dos preâmbulos/frases de demora/ducking; o portão
      // de ativação `speechGate`, `heardText` e `audioTags` vêm pelo fecho dos imports)
      'voiceTurn.ts',
      'voicePolicy.ts',
      // 1.7.0: textos dos avisos push (trecho sem Markdown, aprovação/pergunta/retry) — os avisos
      // locais dos chats executados no celular usam os mesmos do host do desktop
      'push.ts',
      // 1.10.0: herança ao vivo da persona (config efetiva, edição/voltar a herdar, migração,
      // congelamento, troca de persona, merge por unidade de `overrides`)
      'chatInherit.ts',
      // 1.10.0: tools de um tipo de aparelho (só no computador / só no celular — nomes, rótulos
      // das do celular, padrão do app, `withTool` que preserva as desconhecidas, `chatRanOn`)
      'deviceTools.ts'
    ]
  },
  desktop: {
    from: 'ClearChatDesktop/src/main',
    files: [
      'sync/http.ts',
      'sync/ws.ts',
      'sync/stream.ts',
      // agente (fase 4): SSE/acumulador, adaptadores, tools em texto, juiz do Smart-Approve
      'agent/llm.ts',
      'agent/adapters/index.ts',
      'agent/textTools.ts',
      'agent/smartApprove.ts',
      // tools portáveis: web_search (sem o Brave-site), extração de página do browse_url, list_models
      'tools/webSearch.ts',
      'tools/pageExtract.ts',
      'tools/models.ts',
      // fase 4b: memória (store/schema/config/índice/extração e tools), subagentes, compactação,
      // título automático, list_chats/get_chat_info e read_history (+ partes puras da busca)
      'memory/config.ts',
      'memory/render.ts',
      'memory/store.ts',
      'memory/schema.ts',
      'memory/extraction.ts',
      'tools/memory.ts',
      'agent/compaction.ts',
      'agent/subagents.ts',
      'agent/autoTitle.ts',
      'tools/chats.ts',
      'tools/history.ts',
      'searchIndex.ts',
      // fase 6: Smart-Approve → coleta automática de contexto (resumidor)
      'agent/contextCapture.ts',
      // fase 6: voz — clientes de STT (/audio/transcriptions) e TTS (/audio/speech, REST da
      // ElevenLabs), WAV/PCM, o dono do turno da chamada (VoiceCallManager), cortador de frases,
      // máquina do turno, classificação de falhas e o catálogo de modelos/vozes
      'voice/stt.ts',
      'voice/tts.ts',
      'voice/call.ts',
      'voice/voiceCatalog.ts'
    ]
  },
  // lógica pura da UI do desktop (sem React/DOM): ramos na tela, aprovação, raciocínio, datas,
  // cercas/fórmulas do Markdown, resumos das tools de memória e skills
  renderer: {
    from: 'ClearChatDesktop/src/renderer/src/lib',
    files: [
      'branchView.ts',
      'approvalOutcome.ts',
      'reasoning.ts',
      'dates.ts',
      'fences.ts',
      'math.ts',
      'memory.ts',
      'skills.ts',
      // fase 6: ditado (ponto de inserção, desfecho, erros de captura) e DSP puro da captura
      'voice/dictation.ts',
      // voz: rótulos/edição das frases de ferramenta; voz da persona/chat (rótulos, textos dos
      // ícones esmaecidos, `withoutVoiceChoice` do Novo chat — protocolo 1.9.0)
      'voice/toolPhrases.ts',
      'voice/voiceChoice.ts',
      // 1.10.0: rótulos das unidades da herança, texto do valor herdado e o ambiente da herança
      'inherit.ts',
      'audio/silence.ts',
      'audio/pcm.ts'
    ]
  }
}

/** Alias de import → grupo (espelha o `@shared/*` do tsconfig do desktop). */
const ALIASES = { '@shared/': 'shared' }

/** Imports externos permitidos nos arquivos vendorados e quem os resolve no mobile. */
const EXTERNALS = {
  'hash-wasm': 'src/platform/hashWasm.ts (Argon2id nativo)',
  'node:crypto': 'src/platform/nodeCrypto.ts (randomUUID)',
  // memory/store.ts usa randomBytes/randomUUID do Node
  crypto: 'src/platform/nodeCrypto.ts (randomUUID, randomBytes)',
  // só tipos (import type): a conexão no celular é o adaptador src/memory/sqlite.ts
  'better-sqlite3': 'src/platform/betterSqlite.d.ts (tipos; adaptador em src/memory/sqlite.ts)',
  parse5: 'npm parse5 (JS puro; roda no Hermes)'
}

/**
 * Arquivos importados pelos vendorados que NÃO são copiados: a origem depende do Node/Electron e o
 * mobile tem uma adaptação fina em src/. O destino ganha um re-export gerado (conferido no --check)
 * e os imports dele não são seguidos. `grupo:arquivo` → módulo do mobile (relativo à raiz).
 */
const SHIMS = {
  // BuiltRequest/maskRequest/modelInfoFor (llm.ts, smartApprove.ts): request do mobile sem os/shell
  'desktop:agent/request.ts': 'src/agent/request.ts',
  // ok/fail/abortError/fmtNum… (tools): util do mobile sem fs/os/path e sem saída em arquivo
  'desktop:tools/util.ts': 'src/agent/tools/util.ts',
  // MemoryService: o snapshot do índice e lastExtractedSeq ficam no registro `session` (§4.3.7)
  'desktop:memory/service.ts': 'src/memory/service.ts',
  // read_history em outros chats: consultas sobre o cache local (FTS própria)
  'desktop:historyStore.ts': 'src/agent/historyStore.ts',
  // fase 6 (voz): clipes dos preâmbulos — o desktop guarda em disco com node:fs e
  // hash-wasm; o celular tem o mesmo conjunto de frases e um cache próprio (expo-file-system)
  'desktop:voice/clips.ts': 'src/voice/clips.ts',
  // log de diagnóstico dos preâmbulos (JSONL em disco no desktop): no celular só o tipo
  'desktop:voice/evalLog.ts': 'src/voice/evalLog.ts',
  // WebSocket multi-contexto da ElevenLabs (Buffer + headers no construtor do WebSocket do Node):
  // no celular a fala vai por HTTP por frase; a chamada só importa o tipo do gancho
  'desktop:voice/elevenlabsStream.ts': 'src/voice/ttsFeed.ts'
}

const shimSource = (group, file) => {
  const target = join(ROOT, SHIMS[`${group}:${file}`])
  let rel = relative(dirname(join(VENDOR, group, file)), target).replace(/\\/g, '/')
  rel = rel.replace(/\.tsx?$/, '')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return (
    `// VENDORED SHIM for ${posix.join(GROUPS[group].from, file)} — Node-only on desktop; mobile adaptation in ${SHIMS[`${group}:${file}`]}\n` +
    `export * from '${rel}'\n`
  )
}

const header = (group, file) =>
  `// VENDORED from ${posix.join(GROUPS[group].from, file)} — do not edit; run npm run vendor`
const isCode = (f) => /\.(ts|tsx)$/.test(f)

function resolveRelative(group, fromFile, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec))
  if (base.startsWith('..')) throw new Error(`${group}/${fromFile}: import sai do grupo: ${spec}`)
  return resolveIn(group, base, `${group}/${fromFile}`, spec)
}

function resolveIn(group, base, who, spec) {
  const root = join(PARENT, GROUPS[group].from)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const p = join(root, cand)
    if (existsSync(p) && statSync(p).isFile()) return cand
  }
  throw new Error(`${who}: não achei o import ${spec}`)
}

/** Lista final { group, file } com o fecho transitivo dos imports. */
function collect() {
  const seen = new Map()
  const queue = []
  const add = (group, file) => {
    const key = `${group}:${file}`
    if (seen.has(key)) return
    seen.set(key, { group, file })
    queue.push({ group, file })
  }
  for (const [group, g] of Object.entries(GROUPS)) for (const f of g.files) add(group, f)
  while (queue.length) {
    const { group, file } = queue.shift()
    if (!isCode(file) || SHIMS[`${group}:${file}`]) continue
    const src = readSource(group, file)
    for (const { fileName: spec } of ts.preProcessFile(src, true, true).importedFiles) {
      if (spec.startsWith('.')) {
        add(group, resolveRelative(group, file, spec))
        continue
      }
      const alias = Object.keys(ALIASES).find((a) => spec.startsWith(a))
      if (alias) {
        const target = ALIASES[alias]
        add(target, resolveIn(target, spec.slice(alias.length), `${group}/${file}`, spec))
        continue
      }
      if (!(spec in EXTERNALS))
        throw new Error(`${group}/${file}: import externo não tratado: '${spec}' (ver EXTERNALS)`)
    }
  }
  return [...seen.values()].sort((a, b) =>
    `${a.group}/${a.file}`.localeCompare(`${b.group}/${b.file}`)
  )
}

function readSource(group, file) {
  const p = join(PARENT, GROUPS[group].from, file)
  if (!existsSync(p)) throw new Error(`origem ausente: ${relative(ROOT, p)}`)
  return readFileSync(p, 'utf8')
}

/** Conteúdo esperado no destino: cabeçalho + fonte (código) ou bytes idênticos (.md/.json). */
function expected(group, file) {
  if (SHIMS[`${group}:${file}`]) return Buffer.from(shimSource(group, file), 'utf8')
  if (!isCode(file)) return readFileSync(join(PARENT, GROUPS[group].from, file))
  return Buffer.from(`${header(group, file)}\n${readSource(group, file)}`, 'utf8')
}

/** No --check o cabeçalho não conta: só o corpo precisa bater byte a byte com a origem. */
function sameIgnoringHeader(group, file, have) {
  if (!isCode(file) || SHIMS[`${group}:${file}`]) return false
  const text = have.toString('utf8')
  const nl = text.indexOf('\n')
  if (nl < 0 || !text.startsWith('// VENDORED from ')) return false
  return text.slice(nl + 1) === readSource(group, file)
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

function main() {
  const check = process.argv.includes('--check')
  const files = collect()
  const wanted = new Set(files.map(({ group, file }) => join(VENDOR, group, file)))
  const problems = []
  for (const { group, file } of files) {
    const dest = join(VENDOR, group, file)
    const want = expected(group, file)
    const have = existsSync(dest) ? readFileSync(dest) : null
    if (have && have.equals(want)) continue
    if (check && have && sameIgnoringHeader(group, file, have)) continue
    if (check) {
      problems.push(`${have ? 'divergente' : 'ausente'}: src/vendor/${group}/${file}`)
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, want)
    console.log(`${have ? 'atualizado' : 'novo'}: src/vendor/${group}/${file}`)
  }
  for (const p of listFiles(VENDOR)) {
    if (wanted.has(p)) continue
    if (check) problems.push(`sobrando (fora da lista): ${relative(ROOT, p)}`)
    else {
      rmSync(p)
      console.log(`removido: ${relative(ROOT, p)}`)
    }
  }
  if (problems.length) {
    console.error(problems.join('\n'))
    console.error(
      `\nvendor:check falhou (${problems.length}). Rode "npm run vendor" e revise o diff.`
    )
    process.exit(1)
  }
  const counts = Object.keys(GROUPS)
    .map((g) => `${g} ${files.filter((f) => f.group === g).length}`)
    .join(', ')
  console.log(`${check ? 'vendor:check ok' : 'vendor ok'} — ${files.length} arquivos (${counts})`)
}

try {
  main()
} catch (e) {
  console.error(`vendor: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}

// Vetores do contrato (src/vendor/protocol/test-vectors, = docs/test-vectors) contra a cripto
// vendorada do site rodando sobre a camada de plataforma. Adaptado de
// ClearChatWebsite/frontend/src/crypto/vectors.test.ts para uma lista de casos que roda igual no
// Vitest (tests/vectors.test.ts) e no aparelho (tela /dev/selftest).
import {
  aadBlob,
  aadCommand,
  aadCommandResult,
  aadRecord,
  aadStream,
  aadWrap,
  AuthError,
  b64u,
  blobIdFromSha256,
  checkKdfParams,
  decryptBlob,
  deriveSubkeys,
  encryptBlob,
  type Envelope,
  formatRecoveryKey,
  frameJson,
  fromB64u,
  fromHex,
  fromUtf8,
  hex,
  hkdf,
  type KdfParams,
  keyProof,
  open,
  parseRecoveryKey,
  passwordKek,
  recoveryKek,
  seal,
  sha256,
  skillRecordId,
  type Subkeys,
  unframeJson,
  unwrapDek,
  utf8,
  type Wrap,
  wrapDek,
  type WrapSlot
} from '@/crypto'
import { activePath, buildTree, siblings, type TreeMessage } from '@shared/branches'
import blobsJson from '@vendor/protocol/test-vectors/blobs.json'
import branchesJson from '@vendor/protocol/test-vectors/branches.json'
import idsJson from '@vendor/protocol/test-vectors/ids.json'
import kdfJson from '@vendor/protocol/test-vectors/kdf.json'
import keysJson from '@vendor/protocol/test-vectors/keys.json'
import realtimeJson from '@vendor/protocol/test-vectors/realtime.json'
import recordsJson from '@vendor/protocol/test-vectors/records.json'
import recoveryJson from '@vendor/protocol/test-vectors/recovery.json'
import { deepEq, eq, ok, rejects, throws } from './assert'

export interface VectorCase {
  /** Arquivo de vetores (ou grupo). */
  suite: string
  name: string
  /** Argon2id com parâmetros de produção (64 MiB, t=3). */
  slow?: boolean
  run: () => Promise<void> | void
}

// ---- formato dos JSON (só os campos usados) ----
interface KdfCase {
  name: string
  password: string
  password_nfd_utf8_hex?: string
  password_nfc_utf8_hex?: string
  salt: string
  kdf: KdfParams
  kek_hex: string
}
interface RecordCase {
  name: string
  type: string
  id: string
  scope: string | null
  rev: number
  aad_utf8: string
  json: string
  frame_hex: string
  nonce_hex: string
  envelope: Envelope
  ciphertext_size: number
}
interface BlobCase {
  name: string
  plaintext_len: number
  plaintext_sha256_hex: string
  blob_id: string
  chunk_log2: number
  salt_hex: string
  ciphertext_len: number
  ciphertext_sha256_hex: string
  ciphertext_hex: string
}
interface StreamCase {
  name: string
  aad_utf8: string
  json: string
  frame_hex: string
  nonce_hex: string
  envelope: Envelope
}
interface BranchCase {
  name: string
  messages: TreeMessage[]
  branchSel: Record<string, string>
  parents?: Record<string, string | null>
  path: string[]
  siblings?: Record<string, { index: number; count: number }>
}

const kdf = kdfJson as unknown as {
  bounds: { mMin: number; mMax: number }
  cases: KdfCase[]
}
const recovery = recoveryJson as {
  entropy_hex: string
  formatted: string
  parse_accepts: string[]
  parse_rejects: string[]
  salt: string
  kek_hex: string
}
const keys = keysJson as unknown as {
  user_id: string
  dek_hex: string
  subkeys: Record<string, string>
  key_proof: string
  verifier: string
  wraps: { slot: WrapSlot; kek_hex: string; nonce_hex: string; aad_utf8: string; wrap: Wrap }[]
}
const records = recordsJson as unknown as {
  user_id: string
  record_key_hex: string
  cases: RecordCase[]
  must_fail: { name: string; aad_utf8: string; envelope: unknown }[]
}
const blobs = blobsJson as unknown as {
  user_id: string
  blob_key_hex: string
  blob_id_key_hex: string
  cases: BlobCase[]
}
const realtime = realtimeJson as unknown as {
  user_id: string
  stream_key_hex: string
  cases: StreamCase[]
}
const ids = idsJson as unknown as {
  record_id_key_hex: string
  skills: { name: string; record_id: string }[]
  blobs: { plaintext_utf8: string; plaintext_sha256_hex: string; blob_id: string }[]
}
const branches = branchesJson as unknown as { cases: BranchCase[] }

const pattern = (len: number): Uint8Array => {
  const b = new Uint8Array(len)
  for (let i = 0; i < len; i++) b[i] = (i * 7 + 3) % 256
  return b
}

export function vectorCases(): VectorCase[] {
  const cases: VectorCase[] = []
  const add = (suite: string, name: string, run: VectorCase['run'], slow = false): void => {
    cases.push({ suite, name, run, slow })
  }

  // ---------------- kdf.json ----------------
  for (const c of kdf.cases) {
    const allowTest = c.kdf.m < kdf.bounds.mMin
    add(
      'kdf.json',
      `Argon2id ${c.name}`,
      async () => {
        const kek = await passwordKek(c.password, fromB64u(c.salt), c.kdf, allowTest)
        eq(hex(kek), c.kek_hex, 'KEK')
      },
      !allowTest
    )
  }
  add(
    'kdf.json',
    'NFD na entrada dá o mesmo resultado que NFC',
    async () => {
      const c = kdf.cases[0]
      const nfd = fromUtf8(fromHex(c.password_nfd_utf8_hex!))
      ok(nfd !== c.password, 'a senha NFD difere da NFC')
      eq(hex(utf8(c.password.normalize('NFC'))), c.password_nfc_utf8_hex!, 'UTF-8(NFC)')
      const kek = await passwordKek(nfd, fromB64u(c.salt), c.kdf)
      eq(hex(kek), c.kek_hex, 'KEK')
    },
    true
  )
  add('kdf.json', 'recusa parâmetros fora dos limites', () => {
    throws(() => checkKdfParams(kdf.cases[1].kdf), 'parâmetros de teste')
    const good = kdf.cases[0].kdf
    checkKdfParams(good)
    throws(() => checkKdfParams({ ...good, m: kdf.bounds.mMax + 1 }), 'm > máx')
    throws(() => checkKdfParams({ ...good, t: 1 }), 't = 1')
    throws(() => checkKdfParams({ ...good, p: 5 }), 'p = 5')
    throws(() => checkKdfParams({ ...good, alg: 'argon2i' }), 'argon2i')
    throws(() => checkKdfParams({ ...good, v: 16 }), 'v = 16')
    throws(() => checkKdfParams({ ...good, len: 64 }), 'len = 64')
  })

  // ---------------- recovery.json ----------------
  add('recovery.json', 'formata a entropia', async () => {
    eq(await formatRecoveryKey(fromHex(recovery.entropy_hex)), recovery.formatted, 'chave')
  })
  for (const s of recovery.parse_accepts)
    add('recovery.json', `aceita "${s}"`, async () => {
      eq(hex(await parseRecoveryKey(s)), recovery.entropy_hex, 'entropia')
    })
  for (const s of recovery.parse_rejects)
    add('recovery.json', `recusa "${s}"`, () => rejects(parseRecoveryKey(s), 'parse'))
  add('recovery.json', 'KEK_rk = HKDF(entropia, salt_rk)', async () => {
    const kek = await recoveryKek(fromHex(recovery.entropy_hex), fromB64u(recovery.salt))
    eq(hex(kek), recovery.kek_hex, 'KEK_rk')
  })

  // ---------------- keys.json ----------------
  add('keys.json', 'subchaves HKDF', async () => {
    const sk = await deriveSubkeys(fromHex(keys.dek_hex))
    const byInfo: Record<string, Uint8Array> = {
      'clearchat/v1/record': sk.record,
      'clearchat/v1/blob': sk.blob,
      'clearchat/v1/blob-id': sk.blobId,
      'clearchat/v1/stream': sk.stream,
      'clearchat/v1/record-id': sk.recordId,
      'clearchat/v1/key-verify': sk.keyVerify
    }
    for (const [info, want] of Object.entries(keys.subkeys)) eq(hex(byInfo[info]), want, info)
    const rec = await hkdf(fromHex(keys.dek_hex), new Uint8Array(0), 'clearchat/v1/record')
    eq(hex(rec), keys.subkeys['clearchat/v1/record'], 'hkdf direto')
  })
  add('keys.json', 'key_proof e verifier', async () => {
    const p = await keyProof(await deriveSubkeys(fromHex(keys.dek_hex)))
    eq(p.key_proof, keys.key_proof, 'key_proof')
    eq(p.verifier, keys.verifier, 'verifier')
    eq(b64u(await sha256(fromB64u(p.key_proof))), keys.verifier, 'SHA-256(key_proof)')
  })
  for (const w of keys.wraps) {
    add('keys.json', `wrap ${w.slot}: cifra igual e decifra`, async () => {
      const aad = aadWrap(keys.user_id, w.slot)
      eq(fromUtf8(aad), w.aad_utf8, 'AAD')
      const wrap = await wrapDek(
        fromHex(w.kek_hex),
        fromHex(keys.dek_hex),
        aad,
        fromHex(w.nonce_hex)
      )
      deepEq(wrap, w.wrap, 'wrap')
      eq(fromB64u(wrap.c).length, 48, 'tamanho de c')
      eq(hex(await unwrapDek(fromHex(w.kek_hex), w.wrap, aad)), keys.dek_hex, 'DEK')
    })
    add('keys.json', `wrap ${w.slot}: KEK errada ou slot trocado → AuthError`, async () => {
      const bad = fromHex(w.kek_hex)
      bad[0] ^= 1
      await rejects(unwrapDek(bad, w.wrap, aadWrap(keys.user_id, w.slot)), 'KEK errada', AuthError)
      const other: WrapSlot = w.slot === 'password' ? 'recovery' : 'password'
      await rejects(
        unwrapDek(fromHex(w.kek_hex), w.wrap, aadWrap(keys.user_id, other)),
        'slot trocado',
        AuthError
      )
    })
  }
  add(
    'keys.json',
    'cadeia completa: senha → KEK → DEK (produção)',
    async () => {
      const c = kdf.cases[0]
      const kek = await passwordKek(c.password, fromB64u(c.salt), c.kdf)
      const dek = await unwrapDek(kek, keys.wraps[0].wrap, aadWrap(keys.user_id, 'password'))
      eq(hex(dek), keys.dek_hex, 'DEK')
    },
    true
  )

  // ---------------- records.json ----------------
  const recKey = fromHex(records.record_key_hex)
  for (const c of records.cases) {
    add('records.json', `${c.name}: AAD, moldura e envelope`, async () => {
      const aad = aadRecord(records.user_id, c.type, c.id, c.scope, c.rev)
      eq(fromUtf8(aad), c.aad_utf8, 'AAD')
      // cifragem a partir de frame_hex (o deflate de outra biblioteca pode diferir)
      const env = await seal(recKey, aad, fromHex(c.frame_hex), fromHex(c.nonce_hex))
      deepEq(env, c.envelope, 'envelope')
      eq(fromB64u(env.c).length, c.ciphertext_size, 'tamanho do ciphertext')
      const frame = await open(recKey, aad, c.envelope)
      eq(hex(frame), c.frame_hex, 'moldura')
      eq(JSON.stringify(await unframeJson(frame)), c.json, 'JSON')
    })
    add('records.json', `${c.name}: moldura própria (deflate local) faz roundtrip`, async () => {
      const compress = c.frame_hex.startsWith('01')
      const frame = await frameJson(c.json, compress)
      eq(frame[0], compress ? 1 : 0, 'byte de formato')
      if (!compress) eq(hex(frame), c.frame_hex, 'moldura')
      eq(JSON.stringify(await unframeJson(frame)), c.json, 'JSON')
    })
  }
  for (const c of records.must_fail)
    add('records.json', `DEVE falhar: ${c.name}`, () =>
      rejects(open(recKey, utf8(c.aad_utf8), c.envelope as Envelope), c.name)
    )

  // ---------------- blobs.json ----------------
  const blobSk = {
    blob: fromHex(blobs.blob_key_hex),
    blobId: fromHex(blobs.blob_id_key_hex)
  } as Subkeys
  for (const c of blobs.cases) {
    add('blobs.json', c.name, async () => {
      const pt = pattern(c.plaintext_len)
      const ptSha = await sha256(pt)
      eq(hex(ptSha), c.plaintext_sha256_hex, 'SHA-256 do plaintext')
      eq(await blobIdFromSha256(blobSk, ptSha), c.blob_id, 'blob_id')
      const ct = await encryptBlob(
        blobSk,
        blobs.user_id,
        c.blob_id,
        pt,
        fromHex(c.salt_hex),
        c.chunk_log2
      )
      eq(ct.length, c.ciphertext_len, 'tamanho do blob')
      eq(hex(await sha256(ct)), c.ciphertext_sha256_hex, 'SHA-256 do blob')
      eq(hex(ct), c.ciphertext_hex, 'blob')
      eq(hex(await decryptBlob(blobSk, blobs.user_id, c.blob_id, ct)), hex(pt), 'decifrado')
    })
  }
  add('blobs.json', 'truncar o último chunk ou trocar o id do blob falha', async () => {
    const c = blobs.cases[0]
    const ct = fromHex(c.ciphertext_hex)
    await rejects(
      decryptBlob(blobSk, blobs.user_id, c.blob_id, ct.subarray(0, ct.length - 16 - 452)),
      'truncado'
    )
    await rejects(decryptBlob(blobSk, blobs.user_id, '00'.repeat(32), ct), 'id trocado')
    eq(fromUtf8(aadBlob('u', 'b', new Uint8Array(0))), 'clearchat|v1|blob|u|b|', 'AAD do blob')
  })

  // ---------------- realtime.json ----------------
  const streamKey = fromHex(realtime.stream_key_hex)
  add('realtime.json', 'AADs de stream/comando/resultado', () => {
    const [s, c, r] = realtime.cases
    const user = realtime.user_id
    const chat = '3d6f0a52-7c1e-4b8a-9f2d-0e4c5b6a7d8e'
    eq(fromUtf8(aadStream(user, chat, 42, 17)), s.aad_utf8, 'stream')
    eq(fromUtf8(aadCommand(user, chat, 'cmd-7f3a')), c.aad_utf8, 'comando')
    eq(fromUtf8(aadCommandResult(user, chat, 'cmd-7f3a')), r.aad_utf8, 'resultado')
  })
  for (const c of realtime.cases)
    add('realtime.json', c.name, async () => {
      const frame = await frameJson(c.json, false)
      eq(hex(frame), c.frame_hex, 'moldura')
      const env = await seal(streamKey, utf8(c.aad_utf8), frame, fromHex(c.nonce_hex))
      deepEq(env, c.envelope, 'envelope')
      const back = await unframeJson(await open(streamKey, utf8(c.aad_utf8), env))
      eq(JSON.stringify(back), c.json, 'JSON')
    })

  // ---------------- ids.json ----------------
  const idSk = {
    recordId: fromHex(ids.record_id_key_hex),
    blobId: fromHex(keys.subkeys['clearchat/v1/blob-id'])
  } as Subkeys
  for (const s of ids.skills)
    add('ids.json', `skill "${s.name}"`, async () => {
      eq(await skillRecordId(idSk, s.name), s.record_id, 'id da skill')
    })
  for (const b of ids.blobs)
    add('ids.json', `blob_id de ${JSON.stringify(b.plaintext_utf8)}`, async () => {
      const sha = await sha256(utf8(b.plaintext_utf8))
      eq(hex(sha), b.plaintext_sha256_hex, 'SHA-256')
      eq(await blobIdFromSha256(idSk, sha), b.blob_id, 'blob_id')
    })

  // ---------------- branches.json (árvore de versões, §4.3.8) ----------------
  for (const c of branches.cases)
    add('branches.json', c.name, () => {
      const tree = buildTree(c.messages)
      if (c.parents) deepEq(Object.fromEntries(tree.parentOf), c.parents, 'parents')
      deepEq(
        activePath(tree, c.branchSel).map((m) => m.id),
        c.path,
        'caminho ativo'
      )
      for (const [id, want] of Object.entries(c.siblings ?? {})) {
        const s = siblings(tree, id)
        ok(s, `irmãos de ${id}`)
        deepEq({ index: s!.index, count: s!.count }, want, `irmãos de ${id}`)
      }
    })

  return cases
}

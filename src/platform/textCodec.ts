// TextEncoder/TextDecoder UTF-8. O Hermes recente tem TextEncoder; o TextDecoder pode faltar ou não
// suportar `{ fatal: true }` (que o protocolo exige: UTF-8 inválido DEVE falhar). Só instala o que
// faltar ou estiver errado.

export class Utf8Encoder {
  readonly encoding = 'utf-8'
  encode(input = ''): Uint8Array {
    const out: number[] = []
    for (let i = 0; i < input.length; i++) {
      let c = input.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
        const d = input.charCodeAt(i + 1)
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
          i++
        }
      }
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd // surrogate solto → U+FFFD (como o WHATWG)
      if (c < 0x80) out.push(c)
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
      else
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    }
    return new Uint8Array(out)
  }
}

export class Utf8Decoder {
  readonly encoding = 'utf-8'
  readonly fatal: boolean
  readonly ignoreBOM: boolean
  constructor(label = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (!/^(utf-?8|unicode-1-1-utf-8)$/i.test(label.trim()))
      throw new RangeError(`TextDecoder (polyfill): codificação não suportada: ${label}`)
    this.fatal = !!options.fatal
    this.ignoreBOM = !!options.ignoreBOM
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return ''
    const b =
      input instanceof Uint8Array
        ? input
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input)
    let i = 0
    if (!this.ignoreBOM && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3
    let s = ''
    const units: number[] = []
    const flush = (): void => {
      s += String.fromCharCode(...units)
      units.length = 0
    }
    const bad = (): void => {
      if (this.fatal) throw new TypeError('The encoded data was not valid for encoding utf-8')
      units.push(0xfffd)
    }
    while (i < b.length) {
      const c = b[i]
      let need = 0
      let cp = 0
      let lo = 0x80
      let hi = 0xbf
      if (c < 0x80) {
        units.push(c)
        i++
      } else {
        if (c >= 0xc2 && c <= 0xdf) [need, cp] = [1, c & 0x1f]
        else if (c >= 0xe0 && c <= 0xef) {
          ;[need, cp] = [2, c & 0x0f]
          if (c === 0xe0) lo = 0xa0
          if (c === 0xed) hi = 0x9f
        } else if (c >= 0xf0 && c <= 0xf4) {
          ;[need, cp] = [3, c & 0x07]
          if (c === 0xf0) lo = 0x90
          if (c === 0xf4) hi = 0x8f
        } else {
          bad()
          i++
          continue
        }
        let j = 1
        for (; j <= need; j++) {
          const d = b[i + j]
          if (d === undefined || d < (j === 1 ? lo : 0x80) || d > (j === 1 ? hi : 0xbf)) break
          cp = (cp << 6) | (d & 0x3f)
        }
        if (j <= need) {
          bad() // sequência inválida/truncada: consome só os bytes válidos (WHATWG "maximal subpart")
          i += j
          continue
        }
        i += need + 1
        if (cp >= 0x10000) {
          cp -= 0x10000
          units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
        } else units.push(cp)
      }
      if (units.length >= 8192) flush()
    }
    flush()
    return s
  }
}

function decoderIsStrict(): boolean {
  try {
    if (typeof TextDecoder === 'undefined') return false
    new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xc3, 0x28]))
    return false
  } catch (e) {
    return e instanceof TypeError
  }
}

/** Instala os polyfills que faltarem. Devolve o que foi instalado (para o self-test mostrar). */
export function installTextCodec(): string[] {
  const done: string[] = []
  const g = globalThis as Record<string, unknown>
  if (typeof TextEncoder === 'undefined') {
    g.TextEncoder = Utf8Encoder
    done.push('TextEncoder')
  }
  if (!decoderIsStrict()) {
    g.TextDecoder = Utf8Decoder
    done.push('TextDecoder')
  }
  return done
}

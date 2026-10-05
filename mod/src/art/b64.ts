/**
 * Standard padded base64 (RFC 4648 section 4), table driven, pure TS. The mod's runtime has no `btoa`/`atob` in its listed
 * globals and Node 24 has no `Uint8Array.prototype.toBase64`, so Legion's own code carries both directions.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const ENC = new Uint8Array(64)
const DEC = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) {
  ENC[i] = ALPHABET.charCodeAt(i)
  DEC[ALPHABET.charCodeAt(i)] = i
}
const PAD = 61 // '='
const ascii = new TextDecoder()

/** Bytes to base64 text. */
export function encodeBase64(bytes: Uint8Array): string {
  const n = bytes.length
  const out = new Uint8Array(Math.ceil(n / 3) * 4)
  let o = 0
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o++] = ENC[v >>> 18]!
    out[o++] = ENC[(v >>> 12) & 63]!
    out[o++] = ENC[(v >>> 6) & 63]!
    out[o++] = ENC[v & 63]!
  }
  if (i < n) {
    const b1 = i + 1 < n ? bytes[i + 1]! : 0
    const v = (bytes[i]! << 16) | (b1 << 8)
    out[o++] = ENC[v >>> 18]!
    out[o++] = ENC[(v >>> 12) & 63]!
    out[o++] = i + 1 < n ? ENC[(v >>> 6) & 63]! : PAD
    out[o++] = PAD
  }
  return ascii.decode(out)
}

/** Base64 text to bytes. Throws on a character outside the alphabet or a length that is not a multiple of 4. */
export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error(`base64 length ${text.length} is not a multiple of 4`)
  let pad = 0
  if (text.endsWith('==')) pad = 2
  else if (text.endsWith('=')) pad = 1
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    let v = 0
    for (let k = 0; k < 4; k++) {
      const c = text.charCodeAt(i + k)
      let d: number
      if (c === PAD && i + k >= text.length - pad) d = 0
      else {
        d = c < 128 ? DEC[c]! : -1
        if (d < 0) throw new Error(`base64 has a bad character at ${i + k}`)
      }
      v = (v << 6) | d
    }
    if (o < out.length) out[o++] = (v >>> 16) & 255
    if (o < out.length) out[o++] = (v >>> 8) & 255
    if (o < out.length) out[o++] = v & 255
  }
  return out
}

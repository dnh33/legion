/**
 * Ids and hashes from the mod's own globals (`crypto.randomUUID`, `crypto.subtle.digest`); no node:crypto at run time.
 */

/** Desktop parity: src/shared/util.ts:5 `newId = prefix => \`${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}\``. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += HEX[b]
  return out
}

/** SHA-1 of the text's UTF-8 bytes, lowercase hex (same as node's createHash('sha1').update(text).digest('hex')). */
export async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return toHex(new Uint8Array(digest))
}

/** FNV-1a 32-bit over the text's UTF-8 bytes, as 8 lowercase hex digits. A fast, non-cryptographic fingerprint. */
export function fnv1a32(text: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(text)) {
    h ^= b
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

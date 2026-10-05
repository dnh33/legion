/**
 * UTF-8 byte length. File limits ($.fs's 4 MiB, a segment's roll size) are bytes, and Legion's text is not ASCII
 * (roster glyphs, Danish), so `.length` would undercount.
 */
const encoder = new TextEncoder()

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

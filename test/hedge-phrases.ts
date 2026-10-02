/** Absolutes no Legion text may use. Shared by test/bsv-hedge.test.ts and test/blender-hedge.test.ts so the list lives in one place. */
export const BANNED: Array<[string, RegExp]> = [
  ['a guarantee', /\bguarantee[sd]?\b/i],
  ['"tamper-proof" without "not"', /(?<!not )(?<!not a )\btamper[- ]?proof\b/i],
  ['"impossible"', /\bimpossible\b/i],
  ['"cannot be bypassed/forged/disabled/..."', /\bcannot be (bypassed|forged|changed|disabled|tampered with|edited|spoofed|faked|hacked)\b/i],
  ['"nothing can proceed" (a freeze stops Legion\'s BSV tools, not the machine)', /\bnothing can proceed\b/i],
  ['"could ever receive" (the allowlist is checked by an engine no tool uses yet)', /\bcould ever receive\b/i],
  ['"can no longer flip the switch" (reading config.json is not enough; that is all that was shown)', /\bcan no longer flip\b/i],
  ['"no one can" / "nobody can"', /\b(no one|nobody) can\b/i],
  ['"100%" or "fully secure/safe/protected"', /\b100 ?%|\bfully (secure|safe|protected|isolated)\b/i],
  ['"unbreakable", "unhackable", "foolproof", "bulletproof"', /\b(unbreakable|unhackable|foolproof|bulletproof)\b/i],
  ['"protects your funds/keys/wallet"', /\bprotects? (your )?(funds|money|keys|wallet)\b/i],
  ['"keeps your funds safe"', /\bkeeps? (your )?(funds|money|keys)\b.{0,12}\bsafe\b/i],
];

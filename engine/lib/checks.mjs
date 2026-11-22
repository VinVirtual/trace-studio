// Checks that a regular expression cannot do alone: card checksums, IBAN checksums, phone digit
// counts, and whether a base64 blob hides a secret.
import { KEY_PATTERNS, ASSIGNMENT } from './patterns.mjs'

/** Luhn checksum, as used by payment card numbers. */
export function luhn(digits) {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

/** A payment card number: 13 to 19 digits, a card network's prefix, consistent separators, a valid checksum. */
export function isCard(text) {
  const digits = text.replace(/[ -]/g, '')
  if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false
  const seps = text.match(/[ -]/g) || []
  if (seps.length && (new Set(seps).size > 1 || !/^\d{4}([ -]\d{4}){2,3}([ -]\d{1,3})?$|^\d{4}[ -]\d{6}[ -]\d{5}$/.test(text))) return false
  if (!/^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5|4[4-9])|35|30[0-5]|36|38|62)/.test(digits)) return false
  return luhn(digits)
}

/** An IBAN with a valid mod-97 checksum. */
export function isIban(text) {
  const s = text.replace(/ /g, '')
  if (s.length < 15 || s.length > 34) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const d of v) rem = (rem * 10 + Number(d)) % 97
  }
  return rem === 1
}

/** An international phone number: + and 8 to 15 digits. */
export const isPhone = (text) => { const n = text.replace(/\D/g, '').length; return n >= 8 && n <= 15 }

const PRINTABLE = /^[\t\n\r\x20-\x7e]*$/

/** Does this base64 text decode to readable text that holds a key or a secret-named value? */
export function base64HidesSecret(blob, isSecretValue) {
  if (blob.length % 4 === 1) return false
  let decoded
  try { decoded = Buffer.from(blob, 'base64').toString('utf8') } catch { return false }
  if (decoded.length < 12 || !PRINTABLE.test(decoded)) return false
  for (const re of KEY_PATTERNS) { re.lastIndex = 0; if (re.test(decoded)) { re.lastIndex = 0; return true } }
  ASSIGNMENT.lastIndex = 0
  for (const m of decoded.matchAll(new RegExp(ASSIGNMENT.source, 'gi'))) if (isSecretValue(m[1], m[2])) return true
  return false
}

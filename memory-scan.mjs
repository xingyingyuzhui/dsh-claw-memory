const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/
const SECRET = /(api[_-]?key|secret|password|private[_-]?key|begin [a-z ]*private key)/i
const INJECT = /(ignore (all )?(previous|prior) instructions|you are now |system prompt override|exfiltrat)/i

export function scanMemoryText(text) {
  const value = String(text || '')
  if (INVISIBLE.test(value)) return 'blocked: invisible unicode'
  if (SECRET.test(value)) return 'blocked: looks like a credential'
  if (INJECT.test(value)) return 'blocked: injection pattern'
  return null
}

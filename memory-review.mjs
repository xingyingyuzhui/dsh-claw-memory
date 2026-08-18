export function reviewSystemPrompt() {
  return [
    'You extract durable memories from a finished Claw turn.',
    'Reply with JSON only: {"add":[{"target":"user"|"memory","content":"..."}],"remove":[],"replace":[],"note":[]}',
    'user = preferences and identity. memory = environment, conventions, lessons. note = daily process.',
    'Skip trivia, secrets, and anything already in SOUL/AGENTS.',
    'Prefer one compact entry over many thin ones. Empty arrays if nothing is worth keeping.',
  ].join(' ')
}

export function parseReviewJson(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return { add: [], replace: [], remove: [], note: [] }
  try {
    const value = JSON.parse(raw.slice(start, end + 1))
    return {
      add: Array.isArray(value.add) ? value.add : [],
      replace: Array.isArray(value.replace) ? value.replace : [],
      remove: Array.isArray(value.remove) ? value.remove : [],
      note: Array.isArray(value.note) ? value.note : [],
    }
  } catch {
    return { add: [], replace: [], remove: [], note: [] }
  }
}

export function transcriptOf(events, maxChars) {
  const lines = []
  const list = Array.isArray(events) ? events : []
  for (let i = 0; i < list.length; i++) {
    const ev = list[i]
    if (!ev || (ev.type !== 'user/message' && ev.type !== 'assistant/message')) continue
    const role = ev.type === 'user/message' ? 'user' : 'assistant'
    const blocks = ev.data && ev.data.message && ev.data.message.content
    const text = Array.isArray(blocks)
      ? blocks.map((b) => (b && b.type === 'text' ? b.text : '')).join('')
      : ''
    if (!text.trim()) continue
    if (text.indexOf('[heartbeat]') === 0) continue
    lines.push(role + ': ' + text.trim())
  }
  const joined = lines.slice(-12).join('\n\n')
  const cap = maxChars || 8000
  return joined.length > cap ? joined.slice(joined.length - cap) : joined
}

export function reviewSkipReason(opts) {
  const o = opts || {}
  if (o.reviewEnabled === false) return 'review_disabled'
  if (o.force) return ''
  if (o.isChild) return 'child_session'
  if (o.memoryCalled) return 'memory_called'
  if ((o.turnChars || 0) < 80) return 'turn_too_short'
  if (Number.isFinite(Number(o.minTurns)) && Number(o.minTurns) > 1) {
    if ((Number(o.turnCount) || 0) < Number(o.minTurns)) return 'min_turns'
  }
  return ''
}

export function shouldReview(opts) {
  return reviewSkipReason(opts) === ''
}

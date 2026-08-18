export const LIMITS = {
  memory: 2200,
  user: 1375,
  note: 3000,
}

export const SEP = '\n§\n'

export function splitEntries(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '')
  if (!raw.trim()) return []
  if (raw.indexOf('\n§\n') < 0 && raw.indexOf('\n§') < 0 && raw.trim() !== '§') {
    return [raw.trim()]
  }
  return raw.split(/\n§\n|\n§\s*\n/).map((item) => item.trim()).filter(Boolean)
}

export function joinEntries(entries) {
  return entries.filter((item) => String(item || '').trim()).map((item) => String(item).trim()).join(SEP)
}

export function usageOf(entries, limit) {
  const text = joinEntries(entries)
  const used = text.length
  const cap = limit
  const pct = cap <= 0 ? 100 : Math.min(100, Math.round((used / cap) * 100))
  return { used, limit: cap, pct, text }
}

export function findUnique(entries, oldText) {
  const needle = String(oldText || '').trim()
  if (!needle) return { error: 'old_text required' }
  const hits = []
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].indexOf(needle) >= 0) hits.push(i)
  }
  if (hits.length === 0) return { error: 'no entry matches old_text' }
  if (hits.length > 1) return { error: 'old_text matches multiple entries', matches: hits.length }
  return { index: hits[0] }
}

export function addEntry(entries, content, limit) {
  const next = String(content || '').trim()
  if (!next) return { ok: false, error: 'content required' }
  if (entries.indexOf(next) >= 0) {
    return { ok: true, entries: entries.slice(), duplicate: true, usage: usageOf(entries, limit) }
  }
  const proposed = entries.concat([next])
  const usage = usageOf(proposed, limit)
  if (usage.used > limit) {
    return {
      ok: false,
      error: 'Memory at ' + usageOf(entries, limit).used + '/' + limit + ' chars. Adding this entry (' + next.length + ' chars) would exceed the limit. Consolidate with replace/remove, then retry add.',
      current_entries: entries.slice(),
      usage: usageOf(entries, limit),
    }
  }
  return { ok: true, entries: proposed, usage }
}

export function replaceEntry(entries, oldText, content, limit) {
  const found = findUnique(entries, oldText)
  if (found.error) return { ok: false, error: found.error, matches: found.matches }
  const next = String(content || '').trim()
  if (!next) return { ok: false, error: 'content required' }
  const proposed = entries.slice()
  proposed[found.index] = next
  const usage = usageOf(proposed, limit)
  if (usage.used > limit) {
    return {
      ok: false,
      error: 'Replace would exceed the limit (' + usage.used + '/' + limit + '). Shorten the new entry or remove another first.',
      current_entries: entries.slice(),
      usage: usageOf(entries, limit),
    }
  }
  return { ok: true, entries: proposed, usage }
}

export function removeEntry(entries, oldText, limit) {
  const found = findUnique(entries, oldText)
  if (found.error) return { ok: false, error: found.error, matches: found.matches }
  const proposed = entries.slice()
  proposed.splice(found.index, 1)
  return { ok: true, entries: proposed, usage: usageOf(proposed, limit) }
}

export function renderVault(title, entries, limit) {
  const usage = usageOf(entries, limit)
  const body = entries.length ? entries.join('\n§\n') : '(empty)'
  return [
    '══════════════════════════════════════════════',
    title + ' [' + usage.pct + '% — ' + usage.used + '/' + usage.limit + ' chars]',
    '══════════════════════════════════════════════',
    body,
  ].join('\n')
}

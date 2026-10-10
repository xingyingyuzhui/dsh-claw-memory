import { LIMITS, renderVault } from './memory-entries.mjs'

export const PROMPT_BUDGET = {
  blockBytes: 8192,
  totalBytes: 20480,
}

const TRUNCATED = '\n[truncated to fit the memory prompt budget]'

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** Clip to at most `max` UTF-8 bytes without splitting a character. */
export function clipBytes(text, max) {
  const value = String(text || '')
  if (byteLength(value) <= max) return value
  const room = Math.max(0, max - byteLength(TRUNCATED))
  const cut = Buffer.from(value, 'utf8').subarray(0, room).toString('utf8').replace(/\uFFFD+$/, '')
  return cut + TRUNCATED
}

function labeled(source, text) {
  return '## ' + source + '\n\n' + text
}

export function renderFrozenPrompt(userEntries, memoryEntries, daily, budget = PROMPT_BUDGET) {
  const parts = [
    '# Claw memory (frozen this session)',
    '',
    'USER.md is the person. MEMORY.md is durable environment and lessons.',
    'Daily notes are working context only (today and yesterday).',
    'To change the vault, call the memory tool. Edits appear in the tool result now and in the prompt next session.',
    'Do not copy SOUL.md or AGENTS.md into memory.',
    'For last-week chat details, use official session search tools if they exist; do not dump transcripts here.',
    'Each block below is headed by the file it came from.',
  ]
  const blocks = [
    { source: 'USER.md', text: renderVault('USER PROFILE', userEntries || [], LIMITS.user) },
    { source: 'MEMORY.md', text: renderVault('MEMORY', memoryEntries || [], LIMITS.memory) },
  ]
  if (daily) {
    if (daily.yesterdayText && daily.yesterdayText.trim()) {
      blocks.push({ source: 'memory/' + daily.yesterday + '.md', text: daily.yesterdayText.trim() })
    }
    if (daily.todayText && daily.todayText.trim()) {
      blocks.push({ source: 'memory/' + daily.today + '.md', text: daily.todayText.trim() })
    }
  }
  const markers = blocks.map((block) => '[' + block.source + ' omitted: memory prompt budget reached]')
  let used = byteLength(parts.join('\n'))
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    // Keep room so every later block can at least be named as omitted.
    let reserve = 0
    for (let j = i + 1; j < markers.length; j++) reserve += byteLength(markers[j]) + 2
    const remaining = budget.totalBytes - used - 2 - reserve
    const header = labeled(block.source, '')
    if (remaining <= byteLength(header) + byteLength(TRUNCATED) + 64) {
      if (used + 2 + byteLength(markers[i]) <= budget.totalBytes) {
        parts.push('', markers[i])
        used += byteLength(markers[i]) + 2
      }
      continue
    }
    const cap = Math.min(budget.blockBytes, remaining) - byteLength(header)
    const text = labeled(block.source, clipBytes(block.text, cap))
    parts.push('', text)
    used += byteLength(text) + 2
  }
  return parts.join('\n')
}

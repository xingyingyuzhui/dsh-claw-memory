import { LIMITS, renderVault } from './memory-entries.mjs'

export function renderFrozenPrompt(userEntries, memoryEntries, daily) {
  const parts = [
    '# Claw memory (frozen this session)',
    '',
    'USER.md is the person. MEMORY.md is durable environment and lessons.',
    'Daily notes are working context only (today and yesterday).',
    'To change the vault, call the memory tool. Edits appear in the tool result now and in the prompt next session.',
    'Do not copy SOUL.md or AGENTS.md into memory.',
    'For last-week chat details, use official session search tools if they exist; do not dump transcripts here.',
    '',
    renderVault('USER PROFILE', userEntries, LIMITS.user),
    '',
    renderVault('MEMORY', memoryEntries, LIMITS.memory),
  ]
  if (daily) {
    if (daily.yesterdayText && daily.yesterdayText.trim()) {
      parts.push('', '## memory/' + daily.yesterday + '.md', '', daily.yesterdayText.trim())
    }
    if (daily.todayText && daily.todayText.trim()) {
      parts.push('', '## memory/' + daily.today + '.md', '', daily.todayText.trim())
    }
  }
  return parts.join('\n')
}

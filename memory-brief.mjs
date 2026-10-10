import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDsClawPath } from 'dsh-claw-identity/files'
import { splitEntries } from './memory-entries.mjs'
import { isInsideRoot } from './memory-store.mjs'
import { scanMemoryText } from './memory-scan.mjs'

export const BRIEF_LIMITS = {
  perAgentChars: 480,
  perAgentEntries: 4,
  maxAgents: 8,
  totalChars: 2400,
}

const INTERNAL = /^(#\s*(SOUL|AGENTS|TOOLS|IDENTITY|HEARTBEAT)\b|you are |follow the session capability|do not probe desktop)/i
const TOOL_DUMP = /^(tool (call|result)|```json|BLOCKED:|denied by )/i
const LEAK = /(token|bearer|authorization|ghp_|github_pat|sk-[a-z0-9]|eyJ[A-Za-z0-9_-]{8,})/i

export function redactMemoryEntry(text) {
  const value = String(text || '').trim()
  if (!value) return null
  if (scanMemoryText(value)) return null
  if (INTERNAL.test(value) || TOOL_DUMP.test(value) || LEAK.test(value)) return null
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length < 8) return null
  return compact.length > 160 ? compact.slice(0, 157) + '…' : compact
}

export function summarizeVaultText(text, limits = BRIEF_LIMITS) {
  const out = []
  let used = 0
  for (const entry of splitEntries(text)) {
    if (out.length >= limits.perAgentEntries) break
    const line = redactMemoryEntry(entry)
    if (!line) continue
    if (used + line.length > limits.perAgentChars) break
    out.push(line)
    used += line.length
  }
  return out
}

export function loadMainBriefs(home) {
  let registry
  try {
    registry = JSON.parse(readFileSync(join(home, 'workspace-agents', 'registry.json'), 'utf8'))
  } catch {
    return []
  }
  const rows = []
  for (const agent of Object.values((registry && registry.agents) || {})) {
    if (rows.length >= BRIEF_LIMITS.maxAgents) break
    if (!agent || agent.status === 'archived' || !agent.canonicalRoot) continue
    if (!isDsClawPath(String(agent.canonicalRoot), home)) continue
    const vault = join(agent.canonicalRoot, 'MEMORY.md')
    let memoryText = ''
    try {
      if (isInsideRoot(agent.canonicalRoot, vault)) memoryText = readFileSync(vault, 'utf8')
    } catch { /* empty vault */ }
    rows.push({
      title: agent.title,
      slug: agent.slug,
      agentId: agent.agentId,
      status: agent.status,
      memoryText,
    })
  }
  return rows
}

export function renderMainMemoryBrief(agents, limits = BRIEF_LIMITS) {
  const list = Array.isArray(agents) ? agents : []
  const lines = [
    '# Other Claw agents (desensitized)',
    '',
    'Summaries only. No SOUL, AGENTS, credentials, tool transcripts, or session logs.',
    'Do not open those files or probe other agent workspaces unless the user names a target and grants access.',
    '',
  ]
  let total = lines.join('\n').length
  let count = 0
  for (const agent of list) {
    if (count >= limits.maxAgents) break
    if (!agent || agent.status === 'archived') continue
    const title = String(agent.title || agent.slug || agent.agentId || 'agent').trim() || 'agent'
    const bullets = summarizeVaultText(agent.memoryText || '', limits)
    const block = bullets.length
      ? ('## ' + title + '\n' + bullets.map((item) => '- ' + item).join('\n'))
      : ('## ' + title + '\n- (no durable facts yet)')
    if (total + block.length + 2 > limits.totalChars) break
    lines.push(block, '')
    total += block.length + 2
    count += 1
  }
  if (count === 0) return ''
  return lines.join('\n').trim() + '\n'
}

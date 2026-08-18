import { realpathSync } from 'node:fs'
import { applyVaultOp, appendNote, defaultDshHome, listPending, loadDaily, loadDailySync, loadSettings, loadSettingsSync, loadVault, loadVaultSync, removePending, saveDaily, saveRawVault, saveSettings, settingsFile, writePending } from './memory-store.mjs'
import { renderFrozenPrompt } from './memory-prompt.mjs'
import { loadMainBriefs, renderMainMemoryBrief } from './memory-brief.mjs'
import { parseReviewJson, reviewSystemPrompt, shouldReview, transcriptOf } from './memory-review.mjs'

export const name = 'dsh-agent-memory'
export const inject = ['tools', 'systemPrompt', 'webServer']

function optionalService(ctx, key) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const got = ctx.get(key)
      if (got != null) return got
    } catch { /* not injected */ }
  }
  return undefined
}

const BODY_CAP = 65536
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/

function isDsClawPath(path) {
  const raw = String(path || '').replace(/\\/g, '/')
  if (/(^|\/)DSclaw(\/|$)/.test(raw)) return true
  try {
    return /(^|\/)DSclaw(\/|$)/.test(realpathSync(path).replace(/\\/g, '/'))
  } catch {
    return false
  }
}

function cwdOf(agent) {
  const session = agent && agent.session
  const header = session && session.header
  return header && header.cwd ? String(header.cwd) : ''
}

let dshHome = defaultDshHome()
const snapshots = new Map()
const called = new Set()
const reviewed = new Set()

const _internal = {
  setDshHome(dir) { dshHome = dir },
  getDshHome() { return dshHome },
  snapshots,
}
export { _internal }

const writeJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readJsonBody = (req, cap = BODY_CAP) => new Promise((resolveBody, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > cap) {
      reject(new Error('body too large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try {
      resolveBody(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch {
      reject(new Error('invalid json body'))
    }
  })
  req.on('error', reject)
})

const guard = (req, res) => {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return false
  }
  const headers = req.headers || {}
  if (headers['x-dsh-agent-memory'] !== '1') {
    writeJson(res, 403, { ok: false, error: 'missing csrf header' })
    return false
  }
  const origin = headers.origin
  if (origin !== undefined && origin !== null && !LOOPBACK_ORIGIN.test(origin)) {
    writeJson(res, 403, { ok: false, error: 'origin not allowed' })
    return false
  }
  return true
}

async function snapshotOf(root) {
  const user = await loadVault(root, 'user')
  const memory = await loadVault(root, 'memory')
  const daily = await loadDaily(root)
  return renderFrozenPrompt(user.entries, memory.entries, daily)
}

function liveAgents(ctx) {
  const agents = optionalService(ctx, 'agents')
  if (!agents) return []
  if (typeof agents.list === 'function') {
    try { return agents.list() || [] } catch { return [] }
  }
  if (typeof agents.roots === 'function') {
    try { return agents.roots() || [] } catch { return [] }
  }
  return []
}

function resolveRoute(agent, session) {
  const opts = agent && agent.options
  if (opts && opts.provider && opts.model) {
    return { provider: opts.provider, model: opts.model, reasoningEffort: opts.reasoningEffort }
  }
  const header = (session && session.header) || (agent && agent.session && agent.session.header)
  const model = header && (header.model || header.modelSelection)
  if (model && typeof model === 'object' && model.provider && model.model) return model
  return null
}

function agentForSession(ctx, session) {
  if (!session) return null
  const list = liveAgents(ctx)
  for (let i = 0; i < list.length; i++) {
    const agent = list[i]
    if (!agent) continue
    if (agent.session === session) return agent
    if (agent.session && session.id && agent.session.id === session.id) return agent
  }
  return null
}

async function runOp(root, op, settings) {
  const action = op.action
  if (action === 'save' && (op.target === 'daily' || op.target === 'note')) {
    return saveDaily(root, op.key, op.content)
  }
  if (action === 'save') return saveRawVault(root, op.target || 'memory', op.content)
  if (action === 'note') return appendNote(root, op.content)
  if (action === 'pending') return { ok: true, pending: await listPending(root) }
  if (action === 'approve') {
    const rows = await listPending(root)
    const row = rows.find((item) => item.id === op.id)
    if (!row) return { ok: false, error: 'pending id not found' }
    const applied = row.action === 'note'
      ? await appendNote(root, row.content)
      : await applyVaultOp(root, row.action, row.target, row.content, row.old_text)
    if (applied.ok) await removePending(root, row.id)
    return applied
  }
  if (action === 'reject') {
    const ok = await removePending(root, op.id)
    return { ok, error: ok ? undefined : 'pending id not found' }
  }
  const approval = settings && settings.writeApproval
  if (approval && (action === 'add' || action === 'replace' || action === 'remove' || action === 'note')) {
    const row = await writePending(root, op)
    return { ok: true, pending: true, id: row.id }
  }
  return applyVaultOp(root, action, op.target || 'memory', op.content, op.old_text)
}

function toolResult(value) {
  return {
    isError: !value || value.ok === false,
    value,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

export function apply(ctx) {
  const settingsPath = () => settingsFile(dshHome)
  let llm = optionalService(ctx, 'llm')
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], (sub) => {
      llm = optionalService(sub, 'llm') || sub.llm
      sub.effect(() => () => { llm = optionalService(ctx, 'llm') })
    })
  }

  const stopPrompt = ctx.systemPrompt.section({
    name: 'dsh-agent-memory',
    order: 16,
    text: (assemble) => {
      const agent = assemble && assemble.agent
      const cwd = cwdOf(agent)
      if (!isDsClawPath(cwd)) return ''
      const id = agent && agent.id
      if (id && snapshots.has(id)) return snapshots.get(id)
      const text = renderFrozenPrompt(
        loadVaultSync(cwd, 'user').entries,
        loadVaultSync(cwd, 'memory').entries,
        loadDailySync(cwd),
      )
      if (id) snapshots.set(id, text)
      return text
    },
  })

  const stopBrief = ctx.systemPrompt.section({
    name: 'dsh-agent-memory-brief',
    order: 17,
    text: (assemble) => {
      const cwd = cwdOf(assemble && assemble.agent)
      if (isDsClawPath(cwd)) return ''
      return renderMainMemoryBrief(loadMainBriefs(dshHome))
    },
  })

  function memoryTool(root, sessionId) {
    return {
      name: 'memory',
      description: 'Persist durable Claw memory. target=user for preferences, target=memory for environment and lessons. Use note for daily process. Full vaults must be consolidated before add.',
      timeoutMs: 8000,
      parameters: {
        action: { type: 'string', required: true, description: 'add | replace | remove | note | pending | approve | reject' },
        target: { type: 'string', description: 'user or memory' },
        content: { type: 'string', description: 'Entry text for add/replace/note' },
        old_text: { type: 'string', description: 'Unique substring for replace/remove' },
        id: { type: 'string', description: 'Pending id for approve/reject' },
      },
      output: {
        schema: { type: 'object' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value || {}, null, 2) }]
        },
      },
      async execute(args, exec) {
        const agent = exec && exec.agent
        const cwd = cwdOf(agent) || root
        if (!isDsClawPath(cwd)) {
          return toolResult({ ok: false, error: 'memory is only available to Claw agents' })
        }
        const settings = loadSettingsSync(settingsPath())
        const result = await runOp(cwd, args || {}, settings)
        const id = sessionId || (agent && agent.id)
        if (result && result.ok && id) called.add(id)
        return toolResult(result)
      },
    }
  }

  function mountTool(agent) {
    const cwd = cwdOf(agent)
    if (!agent || !isDsClawPath(cwd)) return
    const tools = agent.ctx && agent.ctx.tools
    if (!tools || typeof tools.register !== 'function') return
    try { tools.register(memoryTool(cwd, agent.id)) } catch { /* already registered */ }
  }

  async function applyReviewOps(cwd, ops, settings) {
    for (const row of ops.add || []) {
      await runOp(cwd, { action: 'add', target: row.target || 'memory', content: row.content }, settings)
    }
    for (const row of ops.replace || []) {
      await runOp(cwd, { action: 'replace', target: row.target || 'memory', old_text: row.old_text, content: row.content }, settings)
    }
    for (const row of ops.remove || []) {
      await runOp(cwd, { action: 'remove', target: row.target || 'memory', old_text: row.old_text }, settings)
    }
    for (const row of ops.note || []) {
      await runOp(cwd, { action: 'note', content: typeof row === 'string' ? row : row.content }, settings)
    }
  }

  async function reviewSession(agent, session, cwd, settings, flags) {
    const opts = flags || {}
    const events = session && session.events
    const text = transcriptOf(events)
    if (!shouldReview({
      reviewEnabled: settings.review.enabled,
      isChild: Boolean(opts.isChild),
      memoryCalled: Boolean(agent && agent.id && called.has(agent.id)),
      turnChars: text.length,
      force: Boolean(opts.force),
    })) return
    const mark = ((agent && agent.id) || cwd) + ':' + (opts.mark || (session && session.seq) || 'flush')
    if (reviewed.has(mark)) return
    reviewed.add(mark)
    const runtime = llm
    if (!runtime || typeof runtime.stream !== 'function') return
    const route = resolveRoute(agent, session)
    if (!route) return
    const chunks = []
    for await (const chunk of runtime.stream({
      provider: route.provider,
      model: route.model,
      system: reviewSystemPrompt(),
      messages: [{
        id: 'review',
        role: 'user',
        content: [{ type: 'text', text: text }],
        source: { kind: 'user' },
      }],
      maxTokens: 600,
    })) {
      if (chunk && chunk.type === 'text-delta' && chunk.text) chunks.push(chunk.text)
    }
    await applyReviewOps(cwd, parseReviewJson(chunks.join('')), settings)
    if (agent && agent.id) called.delete(agent.id)
  }

  const onCreated = ctx.on && ctx.on('agent/created', (payload) => {
    mountTool(payload && (payload.agent || payload))
  })

  const onStart = ctx.on && ctx.on('agent/session-start', (payload) => {
    const agent = payload && (payload.agent || payload)
    const cwd = cwdOf(agent)
    if (!agent || !isDsClawPath(cwd)) return
    mountTool(agent)
    snapshotOf(cwd).then((text) => {
      if (agent.id) snapshots.set(agent.id, text)
    }).catch(() => {})
  })

  try {
    const already = liveAgents(ctx)
    for (let i = 0; i < already.length; i++) mountTool(already[i])
  } catch { /* optional agents service */ }

  const stopPre = ctx.on && ctx.on('tools/pre-execute', async (event, next) => {
    const toolName = event && (event.name || (event.execution && event.execution.name))
    if (toolName !== 'memory') return next()
    const agent = event && (event.agent || (event.execution && event.execution.agent))
    if (!isDsClawPath(cwdOf(agent))) return { kind: 'deny', reason: 'memory is only available to Claw agents' }
    return { kind: 'allow' }
  })

  const stopStop = ctx.on && ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const agent = payload && payload.agent
      const cwd = cwdOf(agent)
      if (!agent || !isDsClawPath(cwd)) return
      const settings = loadSettingsSync(settingsPath())
      await reviewSession(agent, agent.session, cwd, settings, {
        isChild: Boolean(payload && payload.parent),
      })
    } catch { /* review must never fail the user turn */ }
  })

  const stopFlush = ctx.on && ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'compaction/start') return
      const cwd = session && session.header && session.header.cwd
      if (!isDsClawPath(cwd)) return
      const settings = loadSettingsSync(settingsPath())
      const agent = agentForSession(ctx, session)
      void reviewSession(agent, session, cwd, settings, {
        force: true,
        mark: 'compaction:' + (event.data && event.data.compactionId || event.seq || ''),
      }).catch(() => {})
    } catch { /* flush must never fail compaction */ }
  })

  const handle = (fn) => async (req, res) => {
    if (!guard(req, res)) return
    try {
      const body = await readJsonBody(req)
      await fn(req, res, body)
    } catch (error) {
      writeJson(res, 400, { ok: false, error: String(error && error.message || error) })
    }
  }

  const routes = [
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-memory/read',
      handler: handle(async (_req, res, body) => {
        const root = body && body.root
        if (!isDsClawPath(root)) {
          writeJson(res, 400, { ok: false, error: 'invalid root' })
          return
        }
        const user = await loadVault(root, 'user')
        const memory = await loadVault(root, 'memory')
        const daily = await loadDaily(root)
        const pending = await listPending(root)
        const settings = await loadSettings(settingsPath())
        writeJson(res, 200, { ok: true, user, memory, daily, pending, settings })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-memory/write',
      handler: handle(async (_req, res, body) => {
        const root = body && body.root
        if (!isDsClawPath(root)) {
          writeJson(res, 400, { ok: false, error: 'invalid root' })
          return
        }
        const settings = loadSettingsSync(settingsPath())
        const result = await runOp(root, body || {}, settings)
        writeJson(res, result.ok ? 200 : 400, { ok: !!result.ok, ...result })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-memory/settings',
      handler: handle(async (_req, res, body) => {
        if (body && body.settings) {
          const saved = await saveSettings(settingsPath(), body.settings)
          writeJson(res, 200, { ok: true, settings: saved })
          return
        }
        writeJson(res, 200, { ok: true, settings: await loadSettings(settingsPath()) })
      }),
    }),
  ]

  ctx.effect(() => () => {
    snapshots.clear()
    called.clear()
    reviewed.clear()
    if (typeof stopPrompt === 'function') stopPrompt()
    if (typeof stopBrief === 'function') stopBrief()
    if (typeof onCreated === 'function') onCreated()
    if (typeof onStart === 'function') onStart()
    if (typeof stopPre === 'function') stopPre()
    if (typeof stopStop === 'function') stopStop()
    if (typeof stopFlush === 'function') stopFlush()
    for (const dispose of routes) {
      if (typeof dispose === 'function') dispose()
    }
  })
}

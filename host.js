import { applyVaultOp, appendNote, defaultDshHome, listPending, loadDaily, loadDailySync, loadSettings, loadSettingsSync, loadVault, loadVaultSync, removePending, saveDaily, saveRawVault, saveSettings, settingsFile, writePending } from './memory-store.mjs'
import { isDsClawPath } from 'dsh-claw-identity/files'
import { CODES, currentTraceId, operation, runWithTrace, setObserveHome } from 'dsh-claw-observability/observe'
import { httpError, registerJsonRoute } from 'dsh-claw-core/http'
import { renderFrozenPrompt } from './memory-prompt.mjs'
import { loadMainBriefs, renderMainMemoryBrief } from './memory-brief.mjs'
import { parseReviewJson, reviewSkipReason, reviewSystemPrompt, transcriptOf } from './memory-review.mjs'

export const name = 'dsh-claw-memory'
export const inject = ['tools', 'systemPrompt', 'connection']

function optionalService(ctx, key) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const got = ctx.get(key)
      if (got != null) return got
    } catch { /* not injected */ }
  }
  return undefined
}

const REVIEW_TIMEOUT_MS = 12000
const REVIEWED_CAP = 64

function clawPath(path) {
  return isDsClawPath(path, dshHome)
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
let briefCache = { at: 0, text: '' }

const _internal = {
  setDshHome(dir) {
    dshHome = dir
    briefCache = { at: 0, text: '' }
    setObserveHome(dir)
  },
  getDshHome() { return dshHome },
  snapshots,
}
export { _internal }

function turnKey(agent, session) {
  const id = (agent && agent.id) || ''
  const seq = (session && session.seq) || (agent && agent.session && agent.session.seq) || 'turn'
  return id + ':' + seq
}

function markReviewed(mark) {
  if (reviewed.has(mark)) return true
  reviewed.add(mark)
  while (reviewed.size > REVIEWED_CAP) {
    const first = reviewed.values().next().value
    reviewed.delete(first)
  }
  return false
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('memory review timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function mainBriefText() {
  const now = Date.now()
  if (briefCache.text && now - briefCache.at < 15000) return briefCache.text
  briefCache = { at: now, text: renderMainMemoryBrief(loadMainBriefs(dshHome)) }
  return briefCache.text
}

function withTrace(data) {
  const traceId = currentTraceId()
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  if (!traceId || data.traceId != null) return data
  return { ...data, traceId }
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
  const tracked = action === 'add' || action === 'replace' || action === 'remove' || action === 'approve' || action === 'reject' || action === 'save' || action === 'note'
  const obs = tracked
    ? operation({ plugin: 'dsh-claw-memory', feature: 'vault', operation: 'memory_' + String(action || 'op') })
    : null
  if (obs) obs.start()
  try {
    if (action === 'save' && (op.target === 'daily' || op.target === 'note')) {
      const saved = await saveDaily(root, op.key, op.content)
      if (obs) saved && saved.ok === false ? obs.fail(CODES.MEMORY_WRITE_FAILED, saved.error) : obs.success()
      return saved
    }
    if (action === 'save') {
      const saved = await saveRawVault(root, op.target || 'memory', op.content)
      if (obs) saved && saved.ok === false ? obs.fail(CODES.MEMORY_WRITE_FAILED, saved.error) : obs.success()
      return saved
    }
    if (action === 'note') {
      const saved = await appendNote(root, op.content)
      if (obs) saved && saved.ok === false ? obs.fail(CODES.MEMORY_WRITE_FAILED, saved.error) : obs.success()
      return saved
    }
    if (action === 'pending') return { ok: true, pending: await listPending(root) }
    if (action === 'approve') {
      const rows = await listPending(root)
      const row = rows.find((item) => item.id === op.id)
      if (!row) {
        if (obs) obs.reject(CODES.MEMORY_PENDING_NOT_FOUND)
        return { ok: false, error: 'pending id not found', code: CODES.MEMORY_PENDING_NOT_FOUND }
      }
      const applied = row.action === 'note'
        ? await appendNote(root, row.content)
        : await applyVaultOp(root, row.action, row.target, row.content, row.old_text)
      if (applied.ok) await removePending(root, row.id)
      if (obs) applied.ok ? obs.success() : obs.fail(CODES.MEMORY_WRITE_FAILED, applied.error)
      return applied
    }
    if (action === 'reject') {
      const ok = await removePending(root, op.id)
      if (!ok && obs) obs.reject(CODES.MEMORY_PENDING_ID_INVALID)
      else if (obs) obs.success()
      return { ok, error: ok ? undefined : 'pending id not found', code: ok ? undefined : CODES.MEMORY_PENDING_ID_INVALID }
    }
    const approval = settings && settings.writeApproval
    if (approval && (action === 'add' || action === 'replace' || action === 'remove' || action === 'note')) {
      const row = await writePending(root, op)
      if (obs) obs.success({ code: 'MEMORY_PENDING_QUEUED' })
      return { ok: true, pending: true, id: row.id }
    }
    const written = await applyVaultOp(root, action, op.target || 'memory', op.content, op.old_text)
    if (obs) written && written.ok === false ? obs.fail(CODES.MEMORY_WRITE_FAILED, written.error) : obs.success()
    return written
  } catch (error) {
    if (obs && !obs.finished) obs.fail(CODES.MEMORY_WRITE_FAILED, error, { state: 'clean' })
    throw error
  }
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
    name: 'dsh-claw-memory',
    order: 16,
    text: (assemble) => {
      const agent = assemble && assemble.agent
      const cwd = cwdOf(agent)
      if (!clawPath(cwd)) return ''
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
    name: 'dsh-claw-memory-brief',
    order: 17,
    text() {
      return ''
    },
  })

  function memoryTool(root, sessionId) {
    return {
      name: 'memory',
      description: 'Persist durable Claw memory. target=user for preferences, target=memory for environment and lessons. Use note for daily process. Full vaults must be consolidated before add.',
      timeoutMs: 8000,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'replace', 'remove', 'note', 'pending', 'approve', 'reject'],
            description: 'add | replace | remove | note | pending | approve | reject',
          },
          target: { type: 'string', enum: ['user', 'memory'], description: 'user or memory' },
          content: { type: 'string', description: 'Entry text for add/replace/note' },
          old_text: { type: 'string', description: 'Unique substring for replace/remove' },
          id: { type: 'string', description: 'Pending id for approve/reject' },
        },
        required: ['action'],
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
        if (!clawPath(cwd)) {
          return toolResult({ ok: false, error: 'memory is only available to Claw agents' })
        }
        const settings = loadSettingsSync(settingsPath())
        const result = await runOp(cwd, args || {}, settings)
        const key = turnKey(agent, agent && agent.session) || sessionId
        if (result && result.ok && key) called.add(key)
        return toolResult(result)
      },
    }
  }

  function mountTool(agent) {
    const cwd = cwdOf(agent)
    if (!agent || !clawPath(cwd)) return
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
    const key = turnKey(agent, session)
    const op = operation({
      plugin: 'dsh-claw-memory',
      feature: 'review',
      operation: opts.force ? 'compaction_flush' : 'turn_review',
      sessionId: session && session.id,
    })
    op.start()
    const skip = reviewSkipReason({
      reviewEnabled: settings.review.enabled,
      isChild: Boolean(opts.isChild),
      memoryCalled: Boolean(key && called.has(key)),
      turnChars: text.length,
      turnCount: Number(session && session.seq) || 0,
      minTurns: settings.review.minTurns,
      force: Boolean(opts.force),
    })
    if (skip) {
      op.degraded(CODES.MEMORY_REVIEW_SKIPPED, { skipReason: skip })
      return
    }
    const mark = ((agent && agent.id) || cwd) + ':' + (opts.mark || (session && session.seq) || 'flush')
    if (markReviewed(mark)) {
      op.degraded(CODES.MEMORY_REVIEW_SKIPPED, { skipReason: 'already_reviewed' })
      return
    }
    if (opts.signal && opts.signal.aborted) {
      op.degraded(CODES.MEMORY_REVIEW_SKIPPED, { skipReason: 'aborted' })
      return
    }
    const runtime = llm
    if (!runtime || typeof runtime.stream !== 'function') {
      op.degraded(CODES.MEMORY_REVIEW_LLM_FAILED, { skipReason: 'llm_unavailable' })
      return
    }
    const route = resolveRoute(agent, session)
    if (!route) {
      op.degraded(CODES.MEMORY_REVIEW_LLM_FAILED, { skipReason: 'no_route' })
      return
    }
    op.stage('llm_review')
    try {
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
        if (opts.signal && opts.signal.aborted) {
          op.degraded(CODES.MEMORY_REVIEW_SKIPPED, { skipReason: 'aborted' })
          return
        }
        if (chunk && chunk.type === 'text-delta' && chunk.text) chunks.push(chunk.text)
      }
      op.stage('apply_ops')
      await applyReviewOps(cwd, parseReviewJson(chunks.join('')), settings)
      if (key) called.delete(key)
      op.success()
    } catch (error) {
      const code = String(error && error.message || '').indexOf('timeout') >= 0
        ? CODES.MEMORY_FLUSH_TIMEOUT
        : CODES.MEMORY_REVIEW_LLM_FAILED
      if (!op.finished) op.fail(code, error, { state: 'clean' })
    }
  }

  // DSH 0.1.6+: agent/created is serial/awaited — mount tools and warm MEMORY.md
  // before the first model request. Do not also listen for agent/session-start (removed).
  const onCreated = ctx.on && ctx.on('agent/created', async (payload) => {
    const agent = payload && (payload.agent || payload)
    mountTool(agent)
    const cwd = cwdOf(agent)
    if (!agent || !clawPath(cwd)) return
    try {
      const text = await snapshotOf(cwd)
      if (agent.id) snapshots.set(agent.id, text)
    } catch {
      /* snapshot is best-effort; tool still mounts */
    }
  })

  try {
    const already = liveAgents(ctx)
    for (let i = 0; i < already.length; i++) mountTool(already[i])
  } catch { /* optional agents service */ }

  const stopPre = ctx.on && ctx.on('tools/pre-execute', async (event, next) => {
    const toolName = event && (event.name || (event.execution && event.execution.name))
    if (toolName !== 'memory') return next()
    const agent = event && (event.agent || (event.execution && event.execution.agent))
    if (!clawPath(cwdOf(agent))) return { kind: 'deny', reason: 'memory is only available to Claw agents' }
    return { kind: 'allow' }
  })

  const stopStop = ctx.on && ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload && payload.agent
      const cwd = cwdOf(agent)
      if (!agent || !clawPath(cwd)) return
      const settings = loadSettingsSync(settingsPath())
      const key = turnKey(agent, agent.session)
      void reviewSession(agent, agent.session, cwd, settings, {
        isChild: Boolean(payload && payload.parent),
        signal: payload && payload.signal,
      }).catch(() => {}).finally(() => {
        if (key) called.delete(key)
      })
    } catch { /* review must never fail the user turn */ }
  })

  const stopFlush = ctx.on && ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'compaction/start') return
      const cwd = session && session.header && session.header.cwd
      if (!clawPath(cwd)) return
      const settings = loadSettingsSync(settingsPath())
      const agent = agentForSession(ctx, session)
      return withTimeout(reviewSession(agent, session, cwd, settings, {
        force: true,
        mark: 'compaction:' + (event.data && event.data.compactionId || event.seq || ''),
      }), REVIEW_TIMEOUT_MS).catch(() => {})
    } catch { /* flush must never fail compaction */ }
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/memory/read',
    handle: async (body, request) => runWithTrace(request, async () => {
      const root = body && body.root
      if (!clawPath(root)) throw httpError(400, 'invalid root')
      const user = await loadVault(root, 'user')
      const memory = await loadVault(root, 'memory')
      const daily = await loadDaily(root)
      const pending = await listPending(root)
      const settings = await loadSettings(settingsPath())
      return withTrace({ user, memory, daily, pending, settings })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/memory/write',
    handle: async (body, request) => runWithTrace(request, async () => {
      const root = body && body.root
      if (!clawPath(root)) {
        const op = operation({ plugin: 'dsh-claw-memory', feature: 'vault', operation: 'memory_write' })
        op.start()
        op.reject(CODES.MEMORY_ROOT_INVALID)
        throw httpError(400, 'invalid root', CODES.MEMORY_ROOT_INVALID)
      }
      const settings = loadSettingsSync(settingsPath())
      const result = await runOp(root, body || {}, settings)
      if (!result || result.ok === false) {
        throw httpError(400, (result && result.error) || 'bad request', result && result.code)
      }
      return withTrace(result)
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/memory/settings',
    handle: async (body, request) => runWithTrace(request, async () => {
      if (body && body.settings) {
        const saved = await saveSettings(settingsPath(), body.settings)
        return withTrace({ settings: saved })
      }
      return withTrace({ settings: await loadSettings(settingsPath()) })
    }),
  })

  ctx.effect(() => () => {
    snapshots.clear()
    called.clear()
    reviewed.clear()
    if (typeof stopPrompt === 'function') stopPrompt()
    if (typeof stopBrief === 'function') stopBrief()
    if (typeof onCreated === 'function') onCreated()
    if (typeof stopPre === 'function') stopPre()
    if (typeof stopStop === 'function') stopStop()
    if (typeof stopFlush === 'function') stopFlush()
  })
}

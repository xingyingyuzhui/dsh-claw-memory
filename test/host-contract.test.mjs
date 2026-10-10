import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdir as mkdirAsync, mkdtemp as mkdtempAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, name, _internal } from '../host.js'

const hostSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'host.js'), 'utf8')

function fakeConnection() {
  const routes = []
  return {
    routes,
    connection: {
      fetch: {
        register(entry) {
          routes.push(entry)
          return () => { entry.disposed = true }
        },
      },
    },
  }
}

test('host named exports', () => {
  assert.equal(name, 'dsh-claw-memory')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'connection'])
  assert.doesNotMatch(hostSrc, /ctx\.llm/)
})

test('memory tool parameters are a JSON Schema object', () => {
  const home = join(tmpdir(), 'mem-schema-home')
  _internal.setDshHome(home)
  let registered
  const { connection } = fakeConnection()
  apply({
    systemPrompt: { section() { return () => {} } },
    connection,
    tools: { register() { return () => {} } },
    on(name, fn) {
      if (name === 'agent/created') {
        fn({
          agent: {
            id: 'wa_test',
            ctx: {
              tools: {
                register(def) {
                  registered = def
                  return () => {}
                },
              },
            },
            session: { header: { cwd: join(home, 'DSclaw', 'bot1') } },
          },
        })
      }
      return () => {}
    },
    effect() {},
  })
  assert.equal(registered && registered.name, 'memory')
  assert.equal(registered.parameters.type, 'object')
  assert.ok(registered.parameters.properties.action)
  assert.deepEqual(registered.parameters.required, ['action'])
})

test('apply registers prompt, Connection Fetch routes, and disposes', () => {
  const sections = []
  const events = []
  const effects = []
  const { connection, routes } = fakeConnection()
  const ctx = {
    systemPrompt: {
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    },
    connection,
    tools: { register() { return () => {} } },
    on(name, fn) {
      events.push(name)
      return () => {}
    },
    effect(fn) { effects.push(fn) },
  }
  apply(ctx)
  assert.deepEqual(sections.map((row) => row.name), ['dsh-claw-memory', 'dsh-claw-memory-brief'])
  assert.ok(events.includes('agent/created'))
  assert.ok(!events.includes('agent/session-start'))
  assert.ok(events.includes('agent/turn-stopping'))
  assert.ok(events.includes('session/event'))
  assert.ok(!events.includes('agent/pre-step'))
  assert.deepEqual(routes.map((row) => row.path), [
    '/api/dsh-claw/memory/read',
    '/api/dsh-claw/memory/write',
    '/api/dsh-claw/memory/settings',
  ])
  for (const row of routes) {
    assert.deepEqual(row.methods, ['POST'])
    assert.equal(row.requestBody, 'buffered')
    assert.equal(typeof row.fetch, 'function')
  }
  // registerJsonRoute registers its own dispose effects (3 routes + host cleanup)
  assert.ok(effects.length >= 3)
  for (const factory of effects) {
    const dispose = factory()
    if (typeof dispose === 'function') dispose()
  }
  assert.ok(routes.every((row) => row.disposed === true))
})

test('workspace sessions do not receive Claw memory briefs', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const home = await mkdtemp(join(tmpdir(), 'mem-main-'))
  const root = join(home, 'DSclaw', 'alpha')
  await mkdir(join(home, 'workspace-agents'), { recursive: true })
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'MEMORY.md'), 'Alpha uses worktrees for child writes.\n')
  await writeFile(join(home, 'workspace-agents', 'registry.json'), JSON.stringify({
    version: 1,
    agents: { wa_a: { agentId: 'wa_a', title: 'alpha', status: 'active', canonicalRoot: root } },
  }))
  _internal.setDshHome(home)
  const sections = []
  const { connection } = fakeConnection()
  apply({
    systemPrompt: {
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    },
    connection,
    tools: { register() { return () => {} } },
    on() { return () => {} },
    effect() {},
  })
  const brief = sections.find((row) => row.name === 'dsh-claw-memory-brief')
  const official = brief.text({ agent: { session: { header: { cwd: join(home, 'project') } } } })
  const claw = brief.text({ agent: { session: { header: { cwd: root } } } })
  assert.equal(official, '')
  assert.equal(claw, '')
})

test('pre-execute denies memory outside DSclaw', async () => {
  const home = join(tmpdir(), `memory-pre-${process.pid}`)
  _internal.setDshHome(home)
  let pre
  const { connection } = fakeConnection()
  apply({
    systemPrompt: { section() { return () => {} } },
    connection,
    tools: { register() { return () => {} } },
    on(name, fn) {
      if (name === 'tools/pre-execute') pre = fn
      return () => {}
    },
    effect(fn) { fn() },
  })
  const denied = await pre({
    name: 'memory',
    agent: { session: { header: { cwd: '/tmp/workspace' } } },
  }, () => ({ kind: 'allow' }))
  assert.equal(denied.kind, 'deny')
  const allowed = await pre({
    name: 'memory',
    agent: { session: { header: { cwd: join(home, 'DSclaw', 'test1') } } },
  }, () => ({ kind: 'next' }))
  assert.equal(allowed.kind, 'allow')
})

test('memory read rejects invalid root via Connection Fetch', async () => {
  const { connection, routes } = fakeConnection()
  apply({
    systemPrompt: { section() { return () => {} } },
    connection,
    tools: { register() { return () => {} } },
    on() { return () => {} },
    effect() {},
  })
  const read = routes.find((row) => row.path === '/api/dsh-claw/memory/read')
  const res = await read.fetch(new Request('dsh-app://host/api/dsh-claw/memory/read', {
    method: 'POST',
    body: JSON.stringify({ root: '/tmp/not-claw' }),
  }))
  assert.equal(res.status, 400)
  const payload = await res.json()
  assert.equal(payload.ok, false)
  assert.match(payload.error, /invalid root/)
})

test('corrupt pending entry is skipped on read and recorded as a diagnostic', async () => {
  const home = await mkdtempAsync(join(tmpdir(), 'mem-corrupt-'))
  const root = join(home, 'DSclaw', 'alpha')
  const pending = join(root, 'memory', '.pending')
  await mkdirAsync(pending, { recursive: true })
  await writeFileAsync(join(pending, 'aaaaaaaa.json'), '{broken')
  await writeFileAsync(join(pending, 'bbbbbbbb.json'), JSON.stringify({ id: 'bbbbbbbb', action: 'add', target: 'memory', content: 'ok', at: '2026-01-01T00:00:00.000Z' }))
  _internal.setDshHome(home)
  const { connection, routes } = fakeConnection()
  apply({
    systemPrompt: { section() { return () => {} } },
    connection,
    tools: { register() { return () => {} } },
    on() { return () => {} },
    effect() {},
  })
  const read = routes.find((row) => row.path === '/api/dsh-claw/memory/read')
  const res = await read.fetch(new Request('dsh-app://host/api/dsh-claw/memory/read', {
    method: 'POST',
    body: JSON.stringify({ root }),
  }))
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.deepEqual(payload.pending.map((row) => row.id), ['bbbbbbbb'])
  const diag = readFileSync(join(home, 'agent-observe', 'diag.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const hit = diag.find((row) => row.code === 'MEMORY_READ_FAILED')
  assert.ok(hit)
  assert.equal(hit.outcome, 'degraded')
  assert.equal(hit.skipReason, 'corrupt_entry')
  assert.equal(hit.reason, 'invalid json')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, name, _internal } from '../host.js'

const hostSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'host.js'), 'utf8')

test('host named exports', () => {
  assert.equal(name, 'dsh-agent-memory')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'webServer'])
  assert.doesNotMatch(hostSrc, /ctx\.llm/)
})

test('apply registers prompt, routes, and disposes', () => {
  const routes = []
  const sections = []
  const events = []
  let stop
  const ctx = {
    systemPrompt: {
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    },
    webServer: {
      register(entry) {
        routes.push(entry)
        return () => { entry.disposed = true }
      },
    },
    tools: { register() { return () => {} } },
    on(name, fn) {
      events.push(name)
      return () => {}
    },
    effect(fn) { stop = fn() },
  }
  apply(ctx)
  assert.deepEqual(sections.map((row) => row.name), ['dsh-agent-memory', 'dsh-agent-memory-brief'])
  assert.ok(events.includes('agent/created'))
  assert.ok(events.includes('agent/session-start'))
  assert.ok(events.includes('agent/turn-stopping'))
  assert.ok(events.includes('session/event'))
  assert.ok(!events.includes('agent/pre-step'))
  assert.deepEqual(routes.map((row) => row.path), [
    '/dsh-agent-memory/read',
    '/dsh-agent-memory/write',
    '/dsh-agent-memory/settings',
  ])
  if (typeof stop === 'function') stop()
})

test('official sessions get a desensitized brief; Claw sessions do not', async () => {
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
  apply({
    systemPrompt: {
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    },
    webServer: { register() { return () => {} } },
    tools: { register() { return () => {} } },
    on() { return () => {} },
    effect() {},
  })
  const brief = sections.find((row) => row.name === 'dsh-agent-memory-brief')
  const official = brief.text({ agent: { session: { header: { cwd: join(home, 'project') } } } })
  const claw = brief.text({ agent: { session: { header: { cwd: root } } } })
  assert.match(official, /alpha/)
  assert.match(official, /worktrees/)
  assert.equal(claw, '')
})

test('pre-execute denies memory outside DSclaw', async () => {
  let pre
  apply({
    systemPrompt: { section() { return () => {} } },
    webServer: { register() { return () => {} } },
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
    agent: { session: { header: { cwd: '/Users/qin/.dsh/DSclaw/test1' } } },
  }, () => ({ kind: 'next' }))
  assert.equal(allowed.kind, 'allow')
})

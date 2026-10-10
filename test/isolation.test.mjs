import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyVaultOp, appendNote, dateKey, loadDaily, loadDailySync, loadVault, loadVaultSync, saveRawVault } from '../memory-store.mjs'
import { renderFrozenPrompt } from '../memory-prompt.mjs'
import { loadMainBriefs } from '../memory-brief.mjs'
import { apply, _internal } from '../host.js'

async function clawRoot(home, slug) {
  const root = join(home, 'DSclaw', slug)
  await mkdir(root, { recursive: true })
  return root
}

test('two Claw agents keep separate USER and MEMORY vaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mem-iso-'))
  const a = await clawRoot(home, 'alpha')
  const b = await clawRoot(home, 'beta')
  const wrote = await applyVaultOp(a, 'add', 'user', 'Alpha prefers zh.')
  assert.equal(wrote.ok, true)
  await saveRawVault(a, 'memory', 'Alpha uses worktrees.')
  const vaultB = await loadVault(b, 'user')
  const memB = await loadVault(b, 'memory')
  assert.deepEqual(vaultB.entries, [])
  assert.deepEqual(memB.entries, [])
  const promptA = renderFrozenPrompt((await loadVault(a, 'user')).entries, (await loadVault(a, 'memory')).entries, null)
  const promptB = renderFrozenPrompt(vaultB.entries, memB.entries, null)
  assert.match(promptA, /Alpha prefers zh/)
  assert.match(promptA, /worktrees/)
  assert.doesNotMatch(promptB, /Alpha/)
})

test('same-named files symlinked to another agent are not cross-read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mem-xread-'))
  const a = await clawRoot(home, 'alpha')
  const b = await clawRoot(home, 'beta')
  const now = new Date('2026-08-18T12:00:00')
  await writeFile(join(b, 'MEMORY.md'), 'Beta private fact.\n')
  await writeFile(join(b, 'USER.md'), 'Beta user.\n')
  await mkdir(join(a, 'memory'), { recursive: true })
  await mkdir(join(b, 'memory'), { recursive: true })
  await writeFile(join(b, 'memory', dateKey(now) + '.md'), 'Beta diary.\n')
  await symlink(join(b, 'MEMORY.md'), join(a, 'MEMORY.md'))
  await symlink(join(b, 'USER.md'), join(a, 'USER.md'))
  await symlink(join(b, 'memory', dateKey(now) + '.md'), join(a, 'memory', dateKey(now) + '.md'))

  assert.deepEqual(loadVaultSync(a, 'memory').entries, [])
  assert.deepEqual(loadVaultSync(a, 'user').entries, [])
  assert.equal(loadDailySync(a, now).todayText, '')
  await assert.rejects(() => loadVault(a, 'memory'), { code: 'MEMORY_ROOT_INVALID' })
  await assert.rejects(() => loadDaily(a, now), { code: 'MEMORY_ROOT_INVALID' })
  await assert.rejects(() => applyVaultOp(a, 'add', 'memory', 'Alpha fact.'), { code: 'MEMORY_ROOT_INVALID' })
  await assert.rejects(() => appendNote(a, 'Alpha note.', now), { code: 'MEMORY_ROOT_INVALID' })
  assert.equal(await readFile(join(b, 'MEMORY.md'), 'utf8'), 'Beta private fact.\n')
  assert.equal(await readFile(join(b, 'memory', dateKey(now) + '.md'), 'utf8'), 'Beta diary.\n')

  _internal.setDshHome(home)
  const sections = []
  apply({
    systemPrompt: { section(entry) { sections.push(entry); return () => {} } },
    connection: { fetch: { register() { return () => {} } } },
    effect() {},
  })
  const memorySection = sections.find((row) => row.name === 'dsh-claw-memory')
  const textA = memorySection.text({ agent: { id: 'agent-a', session: { header: { cwd: a } } } })
  const textB = memorySection.text({ agent: { id: 'agent-b', session: { header: { cwd: b } } } })
  assert.doesNotMatch(textA, /Beta/)
  assert.match(textB, /Beta private fact/)
})

test('main brief skips registry roots outside DSclaw', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mem-brief-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'mem-brief-out-'))
  const a = await clawRoot(home, 'alpha')
  await writeFile(join(a, 'MEMORY.md'), 'Alpha keeps notes short.\n')
  await writeFile(join(outside, 'MEMORY.md'), 'Outside vault text.\n')
  await mkdir(join(home, 'workspace-agents'), { recursive: true })
  await writeFile(join(home, 'workspace-agents', 'registry.json'), JSON.stringify({
    agents: {
      wa_a: { agentId: 'wa_a', title: 'alpha', status: 'active', canonicalRoot: a },
      wa_x: { agentId: 'wa_x', title: 'rogue', status: 'active', canonicalRoot: outside },
    },
  }))
  const rows = loadMainBriefs(home)
  assert.deepEqual(rows.map((row) => row.slug || row.title), ['alpha'])
})

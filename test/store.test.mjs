import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyVaultOp, appendNote, loadDaily, loadVault, saveDaily } from '../memory-store.mjs'

test('vault ops persist atomically and notes stay in memory/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dam-'))
  const added = await applyVaultOp(root, 'add', 'memory', 'Prefer workspace-write.')
  assert.equal(added.ok, true)
  const loaded = await loadVault(root, 'memory')
  assert.deepEqual(loaded.entries, ['Prefer workspace-write.'])
  const note = await appendNote(root, 'Shipped search today.', new Date('2026-08-18T12:00:00'))
  assert.equal(note.ok, true)
  const daily = await loadDaily(root, new Date('2026-08-18T12:00:00'))
  assert.match(daily.todayText, /Shipped search/)
  const blocked = await applyVaultOp(root, 'add', 'user', 'password=hunter2')
  assert.equal(blocked.ok, false)
})

test('saveDaily overwrites today and refuses other dates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dam-'))
  const now = new Date('2026-08-18T12:00:00')
  const saved = await saveDaily(root, '2026-08-18', 'Shipped the picker.\n', now)
  assert.equal(saved.ok, true)
  const daily = await loadDaily(root, now)
  assert.equal(daily.todayText, 'Shipped the picker.\n')
  const refused = await saveDaily(root, '2026-01-01', 'old', now)
  assert.equal(refused.ok, false)
})

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import {
  applyVaultOp,
  appendNote,
  listPending,
  loadDaily,
  loadVault,
  pendingDir,
  pendingFile,
  removePending,
  saveDaily,
  saveRawVault,
  writePending,
} from '../memory-store.mjs'

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

test('pending reject cannot escape .pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dam-'))
  const victim = join(root, 'registry.json')
  await writeFile(victim, '{"keep":true}\n')
  assert.equal(pendingFile(root, '../../../../registry'), '')
  assert.equal(await removePending(root, '../../../../registry'), false)
  assert.equal(await readFile(victim, 'utf8'), '{"keep":true}\n')
  const row = await writePending(root, { action: 'add', content: 'x' })
  assert.equal(await removePending(root, row.id), true)
})

test('concurrent vault adds all persist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dam-'))
  await Promise.all(Array.from({ length: 20 }, (_, i) => applyVaultOp(root, 'add', 'memory', 'note-' + i)))
  const loaded = await loadVault(root, 'memory')
  assert.equal(loaded.entries.length, 20)
})

test('non-ENOENT read failures abort mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dam-'))
  await mkdir(join(root, 'MEMORY.md'))
  await assert.rejects(() => applyVaultOp(root, 'add', 'memory', 'note'))
})

test('corrupt pending entries are skipped with a reason instead of crashing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dam-'))
  const good = await writePending(root, { action: 'add', target: 'memory', content: 'keep' })
  const dir = pendingDir(root)
  await writeFile(join(dir, 'aaaaaaaa.json'), '{not json')
  await writeFile(join(dir, 'bbbbbbbb.json'), 'null')
  await writeFile(join(dir, 'cccccccc.json'), '[1,2]')
  await writeFile(join(dir, 'dddddddd.json'), JSON.stringify({ id: 'dddddddd' }))
  const skipped = []
  const rows = await listPending(root, (row) => skipped.push(row))
  assert.deepEqual(rows.map((row) => row.id), [good.id])
  assert.deepEqual(skipped.map((row) => row.reason).sort(), ['invalid json', 'missing action', 'not an object', 'not an object'])
  assert.deepEqual((await listPending(root)).map((row) => row.id), [good.id])
})

test('pending rows keep their generated id even if the op carries one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dam-'))
  const row = await writePending(root, { action: 'add', content: 'x', id: '../../evil' })
  assert.match(row.id, /^[a-f0-9]{8}$/)
  assert.deepEqual(await readdir(pendingDir(root)), [row.id + '.json'])
  assert.equal(await removePending(root, row.id), true)
})

test('failed vault and diary writes leave the old file intact', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dam-'))
  const now = new Date('2026-08-18T12:00:00')
  await saveRawVault(root, 'memory', 'Old fact.')
  await appendNote(root, 'Old note.', now)
  const vaultBefore = await readFile(join(root, 'MEMORY.md'), 'utf8')
  const noteBefore = await readFile(join(root, 'memory', '2026-08-18.md'), 'utf8')
  await chmod(root, 0o555)
  await chmod(join(root, 'memory'), 0o555)
  try {
    await assert.rejects(() => applyVaultOp(root, 'add', 'memory', 'New fact.'))
    await assert.rejects(() => saveRawVault(root, 'memory', 'Replaced.'))
    await assert.rejects(() => appendNote(root, 'New note.', now))
    await assert.rejects(() => saveDaily(root, '2026-08-18', 'Rewritten.', now))
  } finally {
    await chmod(root, 0o755)
    await chmod(join(root, 'memory'), 0o755)
  }
  assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), vaultBefore)
  assert.equal(await readFile(join(root, 'memory', '2026-08-18.md'), 'utf8'), noteBefore)
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), [])
  assert.deepEqual((await readdir(join(root, 'memory'))).filter((name) => name.endsWith('.tmp')), [])
})

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyVaultOp, loadVault, saveRawVault } from '../memory-store.mjs'
import { renderFrozenPrompt } from '../memory-prompt.mjs'

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

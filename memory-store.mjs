import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { LIMITS, addEntry, joinEntries, removeEntry, replaceEntry, splitEntries, usageOf } from './memory-entries.mjs'
import { scanMemoryText } from './memory-scan.mjs'

export function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function settingsFile(home) {
  return join(home || defaultDshHome(), 'agent-memory', 'settings.json')
}

export function emptySettings() {
  return {
    writeApproval: false,
    review: { enabled: true, minTurns: 1, notify: true },
  }
}

export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const review = value.review && typeof value.review === 'object' ? value.review : {}
  return {
    writeApproval: value.writeApproval === true,
    review: {
      enabled: review.enabled !== false,
      minTurns: Number.isFinite(Number(review.minTurns)) ? Math.max(1, Math.floor(Number(review.minTurns))) : 1,
      notify: review.notify !== false,
    },
  }
}

export async function loadSettings(file) {
  try {
    return normalizeSettings(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return emptySettings()
  }
}

export async function saveSettings(file, value) {
  const next = normalizeSettings(value)
  await enqueueWrite(file, () => atomicWrite(file, JSON.stringify(next, null, 2) + '\n'))
  return next
}

export function vaultPath(root, target) {
  const base = String(root || '').replace(/[/\\]+$/, '')
  if (target === 'user') return join(base, 'USER.md')
  return join(base, 'MEMORY.md')
}

export function noteDir(root) {
  return join(String(root || '').replace(/[/\\]+$/, ''), 'memory')
}

export function notePath(root, key) {
  return join(noteDir(root), key + '.md')
}

export function pendingDir(root) {
  return join(noteDir(root), '.pending')
}

export const PENDING_ID = /^[a-f0-9]{8}$/

const writeQueues = new Map()

export function enqueueWrite(key, fn) {
  const prev = writeQueues.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  writeQueues.set(key, next.then(() => {}, () => {}))
  return next
}

export function pendingFile(root, id) {
  if (!PENDING_ID.test(String(id || ''))) return ''
  const dir = resolve(pendingDir(root))
  const target = resolve(dir, id + '.json')
  const rel = relative(dir, target)
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) return ''
  return target
}

export function dateKey(now = new Date()) {
  const stamp = now instanceof Date ? now : new Date(now)
  const y = stamp.getFullYear()
  const m = String(stamp.getMonth() + 1).padStart(2, '0')
  const d = String(stamp.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + d
}

export function yesterdayKey(now = new Date()) {
  const stamp = now instanceof Date ? now : new Date(now)
  return dateKey(new Date(stamp.getTime() - 86400000))
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
}

export async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.' + process.pid + '.' + randomUUID() + '.tmp'
  await writeFile(tmp, text)
  await rename(tmp, path)
}

function readTextSync(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function loadVaultSync(root, target) {
  const path = vaultPath(root, target)
  const raw = readTextSync(path)
  const entries = splitEntries(raw)
  const limit = target === 'user' ? LIMITS.user : LIMITS.memory
  return { path, raw, entries, usage: usageOf(entries, limit), limit }
}

export function loadDailySync(root, now = new Date()) {
  const today = dateKey(now)
  const yesterday = yesterdayKey(now)
  return {
    today,
    yesterday,
    todayText: readTextSync(notePath(root, today)),
    yesterdayText: readTextSync(notePath(root, yesterday)),
  }
}

export async function loadVault(root, target) {
  const path = vaultPath(root, target)
  const raw = await readText(path)
  const entries = splitEntries(raw)
  const limit = target === 'user' ? LIMITS.user : LIMITS.memory
  return { path, raw, entries, usage: usageOf(entries, limit), limit }
}

export async function saveVault(root, target, entries) {
  const path = vaultPath(root, target)
  const text = joinEntries(entries)
  const suffix = text && !text.endsWith('\n') ? '\n' : ''
  await enqueueWrite(path, () => atomicWrite(path, text + suffix))
  return loadVault(root, target)
}

export async function saveRawVault(root, target, text) {
  const scan = scanMemoryText(text)
  if (scan) return { ok: false, error: scan }
  const entries = splitEntries(text)
  const limit = target === 'user' ? LIMITS.user : LIMITS.memory
  const usage = usageOf(entries, limit)
  if (usage.used > limit) {
    return { ok: false, error: 'Over limit (' + usage.used + '/' + limit + ').', usage, current_entries: entries }
  }
  const saved = await saveVault(root, target, entries)
  return { ok: true, target, entries: saved.entries, usage: saved.usage, path: saved.path }
}

export async function applyVaultOp(root, action, target, content, oldText) {
  if (action !== 'remove') {
    const scan = scanMemoryText(content || '')
    if (scan) return { ok: false, error: scan }
  }
  const path = vaultPath(root, target)
  return enqueueWrite(path, async () => {
    const vault = await loadVault(root, target)
    let result
    if (action === 'add') result = addEntry(vault.entries, content, vault.limit)
    else if (action === 'replace') result = replaceEntry(vault.entries, oldText, content, vault.limit)
    else if (action === 'remove') result = removeEntry(vault.entries, oldText, vault.limit)
    else return { ok: false, error: 'unknown action' }
    if (!result.ok) return result
    if (result.duplicate) return { ok: true, duplicate: true, target, ...result, path: vault.path }
    const text = joinEntries(result.entries)
    const suffix = text && !text.endsWith('\n') ? '\n' : ''
    await atomicWrite(path, text + suffix)
    const saved = await loadVault(root, target)
    return { ok: true, target, entries: saved.entries, usage: saved.usage, path: saved.path }
  })
}

export async function saveDaily(root, key, text, now = new Date()) {
  const today = dateKey(now)
  const yesterday = yesterdayKey(now)
  const stamp = String(key || today)
  if (stamp !== today && stamp !== yesterday) {
    return { ok: false, error: 'only today and yesterday daily notes can be edited' }
  }
  const scan = scanMemoryText(text || '')
  if (scan) return { ok: false, error: scan }
  const path = notePath(root, stamp)
  const next = String(text || '')
  if (next.length > LIMITS.note) {
    return { ok: false, error: 'Daily note at limit (' + next.length + '/' + LIMITS.note + ').' }
  }
  await enqueueWrite(path, () => atomicWrite(path, next))
  return { ok: true, target: 'daily', key: stamp, path, text: next }
}

export async function appendNote(root, content, now = new Date()) {
  const scan = scanMemoryText(content)
  if (scan) return { ok: false, error: scan }
  const note = String(content || '').trim()
  if (!note) return { ok: false, error: 'content required' }
  const key = dateKey(now)
  const path = notePath(root, key)
  return enqueueWrite(path, async () => {
    const prev = await readText(path)
    const next = (prev && !prev.endsWith('\n') ? prev + '\n' : prev) + note + '\n'
    if (next.length > LIMITS.note) {
      return { ok: false, error: 'Daily note at limit (' + prev.length + '/' + LIMITS.note + ').' }
    }
    await atomicWrite(path, next)
    return { ok: true, target: 'note', path, key, text: next }
  })
}

export async function loadDaily(root, now = new Date()) {
  const today = dateKey(now)
  const yesterday = yesterdayKey(now)
  return {
    today,
    yesterday,
    todayText: await readText(notePath(root, today)),
    yesterdayText: await readText(notePath(root, yesterday)),
  }
}

export async function writePending(root, op) {
  const dir = pendingDir(root)
  await mkdir(dir, { recursive: true })
  const id = randomUUID().slice(0, 8)
  const row = { id, at: new Date().toISOString(), ...op }
  await atomicWrite(join(dir, id + '.json'), JSON.stringify(row, null, 2) + '\n')
  return row
}

export async function listPending(root) {
  const dir = pendingDir(root)
  let names = []
  try {
    const { readdir } = await import('node:fs/promises')
    names = await readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
    } catch { /* skip */ }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

export async function removePending(root, id) {
  const { unlink } = await import('node:fs/promises')
  const path = pendingFile(root, id)
  if (!path) return false
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

export function loadSettingsSync(file) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptySettings()
  }
}

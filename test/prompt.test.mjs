import assert from 'node:assert/strict'
import test from 'node:test'
import { PROMPT_BUDGET, clipBytes, renderFrozenPrompt } from '../memory-prompt.mjs'

const daily = (todayText, yesterdayText) => ({ today: '2026-08-18', yesterday: '2026-08-17', todayText, yesterdayText })

test('every prompt block is labeled with its source file', () => {
  const text = renderFrozenPrompt(['Prefers zh.'], ['Uses worktrees.'], daily('Today note.', 'Yesterday note.'))
  assert.match(text, /## USER\.md\n\n[\s\S]*Prefers zh\./)
  assert.match(text, /## MEMORY\.md\n\n[\s\S]*Uses worktrees\./)
  assert.match(text, /## memory\/2026-08-17\.md\n\nYesterday note\./)
  assert.match(text, /## memory\/2026-08-18\.md\n\nToday note\./)
  assert.ok(text.indexOf('## memory/2026-08-17.md') < text.indexOf('## memory/2026-08-18.md'))
})

test('oversized files are clipped to the per-block and total byte budget', () => {
  const huge = '记'.repeat(20000)
  const text = renderFrozenPrompt([huge], [huge], daily(huge, huge))
  assert.ok(Buffer.byteLength(text, 'utf8') <= PROMPT_BUDGET.totalBytes)
  assert.match(text, /truncated to fit the memory prompt budget/)
  assert.doesNotMatch(text, /\uFFFD/)
  assert.match(text, /## USER\.md/)
})

test('a tight budget omits trailing blocks with an explicit marker', () => {
  const budget = { blockBytes: 512, totalBytes: 1600 }
  const text = renderFrozenPrompt(['a'.repeat(2000)], ['b'.repeat(2000)], daily('c'.repeat(2000), 'd'.repeat(2000)), budget)
  assert.ok(Buffer.byteLength(text, 'utf8') <= budget.totalBytes)
  assert.match(text, /omitted: memory prompt budget reached/)
})

test('clipBytes never splits a multi-byte character', () => {
  const clipped = clipBytes('é'.repeat(100), 101)
  assert.ok(Buffer.byteLength(clipped, 'utf8') <= 101)
  assert.doesNotMatch(clipped, /\uFFFD/)
  assert.equal(clipBytes('short', 100), 'short')
})

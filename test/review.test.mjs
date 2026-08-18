import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReviewJson, shouldReview, transcriptOf } from '../memory-review.mjs'

test('review json parser is tolerant', () => {
  const ops = parseReviewJson('sure\n{"add":[{"target":"user","content":"prefers zh"}],"note":["shipped"]}\n')
  assert.equal(ops.add[0].content, 'prefers zh')
  assert.deepEqual(ops.note, ['shipped'])
})

test('review skips children, empty turns, and turns that already wrote memory', () => {
  assert.equal(shouldReview({ reviewEnabled: false, turnChars: 200 }), false)
  assert.equal(shouldReview({ isChild: true, turnChars: 200 }), false)
  assert.equal(shouldReview({ memoryCalled: true, turnChars: 200 }), false)
  assert.equal(shouldReview({ turnChars: 10 }), false)
  assert.equal(shouldReview({ turnChars: 200 }), true)
  assert.equal(shouldReview({ force: true, memoryCalled: true, turnChars: 10 }), true)
  assert.equal(shouldReview({ force: true, reviewEnabled: false }), false)
})

test('transcript skips heartbeat lines', () => {
  const text = transcriptOf([
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '[heartbeat]\nnoop' }] } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'remember I use zsh' }] } } },
  ])
  assert.match(text, /zsh/)
  assert.doesNotMatch(text, /heartbeat/)
})

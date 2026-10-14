import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordEntries } from '../src/thread/read.ts'
import { commentReply, joinMessageParts } from '../web/src/board/chat.ts'
import { DEFAULT_KEYBOARD, keyboardError, resolveKey } from '../src/core/keyboard.ts'

test('Markdown messages split for transport reassemble across older pages without losing text', () => {
  const text = '# Plan\n\n```typescript\n' + 'const ready = true;\n'.repeat(130) + '```\n\nFinal paragraph.'
  const entries = recordEntries({ type: 'assistant', message: { content: [{ type: 'text', text }] } }, 42)
  assert.ok(entries.length > 2)
  const latest = joinMessageParts({ entries: entries.slice(1) })
  assert.equal(latest.length, 1)
  assert.ok(latest[0].part! > 0)
  const all = joinMessageParts({ entries })
  assert.equal(all.length, 1)
  assert.equal(all[0].text, text)
  assert.equal(all[0].messageId, '42:m0')
  assert.equal(all[0].role, 'assistant')
  assert.equal(joinMessageParts({ entries: [entries[0], entries[2]] }).length, 2, 'never bridge a missing part')
  assert.equal(joinMessageParts({ entries: [...entries, { ...entries[0], messageId: 'different' }] }).length, 2)
})

test('comments accompany the next reply as quoted, independently fenced blocks', () => {
  const comments = [
    { id: 'a', messageId: '42:m0', block: 1, offset: 24, quote: 'First line\nSecond line', text: 'Please expand.' },
    { id: 'b', messageId: '43:m0', block: 0, offset: 0, quote: '```js\nconst x = 1\n```', text: 'Use `let` here.' },
    { id: 'c', messageId: '44:m0', block: 2, offset: 50, quote: 'Unfinished', text: '   ' },
  ]
  const reply = commentReply({ draft: 'Next steps', comments })
  assert.match(reply, /^Next steps\n\n```pnyx-comment block=2 msg="42:m0" offset=24\n> First line\n> Second line\n\nPlease expand\.\n```/)
  assert.match(reply, /````pnyx-comment block=1 msg="43:m0" offset=0\n> ```js/)
  assert.ok(reply.endsWith('Use `let` here.\n````'))
  assert.doesNotMatch(reply, /Unfinished/)
  assert.equal(commentReply({ draft: 'literal draft\n', comments: [] }), 'literal draft\n')
  assert.match(commentReply({ draft: '', comments }), /^```pnyx-comment/)
})

test('Enter replies and c comments in the thread without consuming typed text', () => {
  const context = { scope: 'thread' as const, platform: 'mac' as const, characterShortcuts: true, now: 1 }
  assert.equal(keyboardError({ prefs: DEFAULT_KEYBOARD }), undefined)
  assert.equal(resolveKey({ event: { key: 'Enter' }, context, prefs: DEFAULT_KEYBOARD }).action, 'thread.reply')
  assert.equal(resolveKey({ event: { key: 'Enter' }, context: { ...context, scope: 'board' }, prefs: DEFAULT_KEYBOARD }).action, 'board.open')
  assert.equal(resolveKey({ event: { key: 'c' }, context, prefs: DEFAULT_KEYBOARD }).action, 'thread.comment')
  assert.equal(resolveKey({ event: { key: 'c' }, context: { ...context, editing: true }, prefs: DEFAULT_KEYBOARD }).consume, false)
  assert.equal(keyboardError({ prefs: { ...DEFAULT_KEYBOARD, bindings: { 'thread.comment': ['n'] } } }), undefined)
})

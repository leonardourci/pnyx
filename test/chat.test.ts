import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordEntries } from '../src/thread/read.ts'
import { commentReply, joinMessageParts, quoteInto } from '../web/src/hydra/chat.ts'
import { DEFAULT_KEYBOARD, keyboardError, resolveKey } from '../src/core/keyboard.ts'

test('Markdown messages split for transport reassemble across older pages without losing text', () => {
  const text = '# Plan\n\n```typescript\n' + 'const ready = true;\n'.repeat(130) + '```\n\nFinal paragraph.'
  const entries = recordEntries({ record: { type: 'assistant', message: { content: [{ type: 'text', text }] } }, offset: 42 })
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

test('comments identify each reply, quote nested passages and include context for short selections', () => {
  const comments = [
    { id: 'a', messageId: '42:m0', block: 1, offset: 24, at: '2026-10-15T10:00:00Z', quote: 'Reconnect safely', paragraph: 'Reconnect safely after the socket closes.', text: 'Please expand.' },
    { id: 'b', messageId: '42:m0', block: 1, offset: 24, at: '2026-10-15T10:00:00Z', quote: 'Reconnect', paragraph: 'Reconnect safely after the socket closes.', text: 'How long?' },
    { id: 'c', messageId: '44:m0', block: 2, offset: 50, quote: 'Unfinished', text: '   ' },
  ]
  const reply = commentReply({ draft: 'Next steps', comments, firstComment: true })
  assert.match(reply, /^> Internal note.*no reply needed/)
  assert.match(reply, /## Comments on your reply from 2026-10-15T10:00:00Z/)
  assert.match(reply, /1\. > Reconnect safely\n\nParagraph:\n\n> Reconnect safely after the socket closes\./)
  assert.match(reply, /2\. > Reconnect\n/)
  assert.ok(reply.endsWith('## Message\n\nNext steps'))
  assert.doesNotMatch(reply, /Unfinished|pnyx-comment|----/)
  assert.doesNotMatch(commentReply({ draft: '', comments }), /Internal note/)
  assert.equal(commentReply({ draft: 'literal draft\n', comments: [] }), 'literal draft\n')
})

test('Enter replies and c comments in the thread without consuming typed text', () => {
  const context = { scope: 'thread' as const, platform: 'mac' as const, characterShortcuts: true, now: 1 }
  assert.equal(keyboardError({ prefs: DEFAULT_KEYBOARD }), undefined)
  assert.equal(resolveKey({ event: { key: 'Enter' }, context, prefs: DEFAULT_KEYBOARD }).action, 'thread.reply')
  assert.equal(resolveKey({ event: { key: 'Enter' }, context: { ...context, scope: 'hydra' }, prefs: DEFAULT_KEYBOARD }).action, 'board.open')
  assert.equal(resolveKey({ event: { key: 'c' }, context, prefs: DEFAULT_KEYBOARD }).action, 'thread.comment')
  assert.equal(resolveKey({ event: { key: 'c' }, context: { ...context, editing: true }, prefs: DEFAULT_KEYBOARD }).consume, false)
  assert.equal(keyboardError({ prefs: { ...DEFAULT_KEYBOARD, bindings: { 'thread.comment': ['n'] } } }), undefined)
})

test('a quoted selection follows the draft as Markdown, ready for an answer under it', () => {
  assert.equal(quoteInto({ draft: '', text: ' First line\nSecond line ' }), '> First line\n> Second line\n\n')
  assert.equal(quoteInto({ draft: 'Context\n\n', text: 'Quoted' }), 'Context\n\n> Quoted\n\n')
})

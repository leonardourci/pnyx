import type { HydraMessage } from '../src/core/model.ts'
import type { ThreadEntry } from '../src/thread/read.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordEntries } from '../src/thread/read.ts'
import { hydraMessages, commentReply, duration, joinMessageParts, quoteInto, quoteSnippet, turnTimings } from '../web/src/hydra/chat.ts'
import { DEFAULT_KEYBOARD, keyboardError, resolveKey } from '../src/core/keyboard.ts'

test(
  'Markdown messages split for transport reassemble across older pages without losing text',
  () => {
    const text = '# Plan\n\n```typescript\n' + 'const ready = true;\n'.repeat(130) + '```\n\nFinal paragraph.'
    const entries = recordEntries({
      record: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text,
            },
          ],
        },
      },
      offset: 42,
    })
    assert.ok(entries.length > 2)
    const latest = joinMessageParts({ entries: entries.slice(1) })
    assert.equal(
      latest.length,
      1,
    )
    assert.ok(latest[0].part! > 0)
    const all = joinMessageParts({ entries })
    assert.equal(
      all.length,
      1,
    )
    assert.equal(
      all[0].text,
      text,
    )
    assert.equal(
      all[0].messageId,
      '42:m0',
    )
    assert.equal(
      all[0].role,
      'assistant',
    )
    assert.equal(
      joinMessageParts({
        entries: [
          entries[0],
          entries[2],
        ],
      }).length,
      2,
      'never bridge a missing part',
    )
    assert.equal(
      joinMessageParts({
        entries: [
          ...entries,
          {
            ...entries[0],
            messageId: 'different',
          },
        ],
      }).length,
      2,
    )
  },
)

test(
  'comments identify each reply, quote nested passages and include context for short selections',
  () => {
    const comments = [
      {
        id: 'a',
        messageId: '42:m0',
        block: 1,
        offset: 24,
        at: '2026-10-15T10:00:00Z',
        quote: 'Reconnect safely',
        paragraph: 'Reconnect safely after the socket closes.',
        text: 'Please expand.',
      },
      {
        id: 'b',
        messageId: '42:m0',
        block: 1,
        offset: 24,
        at: '2026-10-15T10:00:00Z',
        quote: 'Reconnect',
        paragraph: 'Reconnect safely after the socket closes.',
        text: 'How long?',
      },
      {
        id: 'c',
        messageId: '44:m0',
        block: 2,
        offset: 50,
        quote: 'Unfinished',
        text: '   ',
      },
    ]
    const reply = commentReply({
      draft: 'Next steps',
      comments,
      firstComment: true,
    })
    assert.match(
      reply,
      /^> Internal note.*no reply needed/,
    )
    assert.match(
      reply,
      /## Comments on your reply from 2026-10-15T10:00:00Z/,
    )
    assert.match(
      reply,
      /1\. > Reconnect safely\n\nParagraph:\n\n> Reconnect safely after the socket closes\./,
    )
    assert.match(
      reply,
      /2\. > Reconnect\n/,
    )
    assert.ok(reply.endsWith('## Message\n\nNext steps'))
    assert.doesNotMatch(
      reply,
      /Unfinished|pnyx-comment|----/,
    )
    assert.doesNotMatch(
      commentReply({
        draft: '',
        comments,
      }),
      /Internal note/,
    )
    assert.equal(
      commentReply({
        draft: 'literal draft\n',
        comments: [],
      }),
      'literal draft\n',
    )
  },
)

test(
  'an image alone makes a comment, and cards show the context the agent receives',
  () => {
    const comment = {
      id: 'a',
      messageId: '42:m0',
      block: 1,
      offset: 24,
      at: '2026-10-15T10:00:00Z',
      quote: 'safely',
      paragraph: 'Reconnect safely after the socket closes.',
      text: '',
      images: ['[image: /hydras/default/attachments/shot.png]'],
    }
    assert.match(
      commentReply({
        draft: 'See the screenshot',
        comments: [comment],
      }),
      /1\. > safely\n\nParagraph:\n\n> Reconnect safely after the socket closes\.\n\n\[image: \/hydras\/default\/attachments\/shot\.png\]\n\n## Message/,
    )
    assert.deepEqual(
      quoteSnippet({
        quote: comment.quote,
        context: comment.paragraph,
      }),
      {
        before: 'Reconnect ',
        match: 'safely',
        after: ' after the socket closes.',
      },
    )
    assert.deepEqual(
      quoteSnippet({ quote: 'Reconnect safely after the socket' }),
      {
        before: '',
        match: 'Reconnect safely after the socket',
        after: '',
      },
      'with no context, the quote stands alone',
    )
  },
)

test(
  'Enter replies and c comments in the thread without consuming typed text',
  () => {
    const context = {
      scope: 'thread' as const,
      platform: 'mac' as const,
      characterShortcuts: true,
      now: 1,
    }
    assert.equal(
      keyboardError({ prefs: DEFAULT_KEYBOARD }),
      undefined,
    )
    assert.equal(
      resolveKey({
        event: { key: 'Enter' },
        context,
        prefs: DEFAULT_KEYBOARD,
      }).action,
      'thread.reply',
    )
    assert.equal(
      resolveKey({
        event: { key: 'Enter' },
        context: {
          ...context,
          scope: 'hydra',
        },
        prefs: DEFAULT_KEYBOARD,
      }).action,
      'board.open',
    )
    assert.equal(
      resolveKey({
        event: { key: 'c' },
        context,
        prefs: DEFAULT_KEYBOARD,
      }).action,
      'thread.comment',
    )
    assert.equal(
      resolveKey({
        event: { key: 'c' },
        context: {
          ...context,
          editing: true,
        },
        prefs: DEFAULT_KEYBOARD,
      }).consume,
      false,
    )
    assert.equal(
      keyboardError({
        prefs: {
          ...DEFAULT_KEYBOARD,
          bindings: { 'thread.comment': ['n'] },
        },
      }),
      undefined,
    )
  },
)

test(
  'a quoted selection follows the draft as Markdown, ready for an answer under it',
  () => {
    assert.equal(
      quoteInto({
        draft: '',
        text: ' First line\nSecond line ',
      }),
      '> First line\n> Second line\n\n',
    )
    assert.equal(
      quoteInto({
        draft: 'Context\n\n',
        text: 'Quoted',
      }),
      'Context\n\n> Quoted\n\n',
    )
  },
)

const message = ({
  id,
  actor = 'web',
  text = 'Check this task',
}: {
  id: string
  actor?: string
  text?: string
}): HydraMessage =>
  ({
    id,
    actor,
    text,
    at: '2026-10-20T10:00:00Z',
    action: 'send',
    hydra: 'hydra',
  })

test(
  'Hydra chat labels system lines and matches user transcript copies once despite whitespace',
  () => {
    const transcript: ThreadEntry[] = [
      {
        id: 'native',
        kind: 'message',
        role: 'user',
        text: '  Check\nthis task\n',
      },
      {
        id: 'answer',
        kind: 'message',
        role: 'assistant',
        text: 'Check this task',
      },
    ]
    const entries = hydraMessages({
      messages: [
        message({ id: 'a' }),
        message({ id: 'b' }),
        message({
          id: 'system',
          actor: 'pnyx',
        }),
        message({
          id: 'hydra',
          actor: 'hydra',
        }),
      ],
      transcript,
    })

    assert.equal(
      entries.filter(entry => entry.role === 'user').length,
      2,
    )
    assert.equal(
      entries.find(entry => entry.id === 'system')?.role,
      'Pnyx',
    )
    assert.equal(
      entries.find(entry => entry.id === 'hydra')?.role,
      'assistant',
    )
    assert.equal(
      entries.find(entry => entry.id === 'a'),
      undefined,
    )
    assert.ok(entries.some(entry => entry.id === 'answer'))
    assert.equal(
      transcript[0]!.text,
      '  Check\nthis task\n',
    )
  },
)

test(
  'an owner message that references a task shows once, without the context Hydra received',
  () => {
    const entries = hydraMessages({
      messages: [
        {
          ...message({
            id: 'ask',
            text: 'Is [@Fix login](pnyx-task:t1) done?',
          }),
          context: 'Referenced tasks (context only):\n\nTask t1: Fix login',
        },
      ],
      transcript: [
        {
          id: 'native',
          kind: 'message',
          role: 'user',
          text: 'Is [@Fix login](pnyx-task:t1) done?\n\nReferenced tasks (context only):\n\nTask t1: Fix login',
          at: '2026-10-20T10:00:01Z',
        },
      ],
    })
    assert.deepEqual(
      entries.map(entry => [
        entry.id,
        entry.text,
      ]),
      [
        [
          'native',
          'Is [@Fix login](pnyx-task:t1) done?',
        ],
      ],
    )
  },
)

test(
  'Codex Hydra chat hides injected instructions while retaining owner messages and replies',
  () => {
    const transcript: ThreadEntry[] = [
      {
        id: 'instructions',
        kind: 'message',
        role: 'user',
        text: '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nUse the local skill.\n</INSTRUCTIONS>',
      },
      {
        id: 'owner',
        kind: 'message',
        role: 'user',
        text: 'Explain AGENTS.md instructions.',
      },
      {
        id: 'answer',
        kind: 'message',
        role: 'assistant',
        text: 'Hydra is ready.',
      },
    ]
    assert.deepEqual(
      hydraMessages({
        messages: [],
        transcript,
        provider: 'codex',
      }).map(e => e.id),
      [
        'owner',
        'answer',
      ],
    )
    assert.deepEqual(
      hydraMessages({
        messages: [],
        transcript,
        provider: 'claude-code',
      }),
      transcript,
    )
    const mixed = {
      ...transcript[0]!,
      text: `${transcript[0]!.text}\n\nExplain this policy.`,
    }
    assert.deepEqual(
      hydraMessages({
        messages: [],
        transcript: [mixed],
        provider: 'codex',
      }),
      [mixed],
    )
    const reply = {
      ...transcript[0]!,
      role: 'assistant',
    }
    assert.deepEqual(
      hydraMessages({
        messages: [],
        transcript: [reply],
        provider: 'codex',
      }),
      [reply],
    )
    assert.equal(
      transcript.length,
      3,
    )
  },
)

test(
  'Hydra chat hides a quiet reply, even while it streams in',
  () => {
    const entries = hydraMessages({
      messages: [],
      transcript: [
        {
          id: 'quiet',
          kind: 'message',
          role: 'assistant',
          text: 'NO_REPLY\n',
        },
        {
          id: 'streaming',
          kind: 'message',
          role: 'assistant · continued',
          text: 'NO_RE',
        },
        {
          id: 'said',
          kind: 'message',
          role: 'assistant',
          text: 'NO_REPLY is not all I said',
        },
        {
          id: 'owner',
          kind: 'message',
          role: 'user',
          text: 'NO',
        },
      ],
    })

    assert.deepEqual(
      entries.map(entry => entry.id),
      [
        'said',
        'owner',
      ],
    )
  },
)

test(
  'each finished turn ends with its timing and reply, and a running turn has none',
  () => {
    const entries: ThreadEntry[] = [
      {
        id: 'ask',
        kind: 'message',
        role: 'user',
        text: 'Plan it',
        at: '2026-10-21T10:00:00.000Z',
      },
      {
        id: 'look',
        kind: 'tool',
        role: 'Shell',
        text: 'ls',
        at: '2026-10-21T10:00:20.000Z',
      },
      {
        id: 'update',
        kind: 'message',
        role: 'Worker',
        text: 'Pushed',
        at: '2026-10-21T10:00:30.000Z',
        task: 'task-1',
      },
      {
        id: 'answer',
        kind: 'message',
        role: 'assistant',
        text: 'Here is the plan.',
        at: '2026-10-21T10:01:29.000Z',
      },
      {
        id: 'again',
        kind: 'message',
        role: 'user',
        text: 'Go',
        at: '2026-10-21T10:05:00.000Z',
      },
      {
        id: 'done',
        kind: 'message',
        role: 'assistant',
        text: 'Done.',
        at: '2026-10-21T10:06:00.000Z',
      },
    ]
    assert.deepEqual(
      [
        ...turnTimings({
          entries,
          working: false,
        }),
      ],
      [
        [
          'answer',
          {
            start: '2026-10-21T10:00:00.000Z',
            end: '2026-10-21T10:01:29.000Z',
            reply: 'Here is the plan.',
            latest: false,
          },
        ],
        [
          'done',
          {
            start: '2026-10-21T10:05:00.000Z',
            end: '2026-10-21T10:06:00.000Z',
            reply: 'Done.',
            latest: true,
          },
        ],
      ],
    )
    assert.deepEqual(
      [
        ...turnTimings({
          entries,
          working: true,
        }).keys(),
      ],
      ['answer'],
    )
    assert.deepEqual(
      [
        59_000,
        89_000,
        3_725_000,
      ].map(ms => duration({ ms })),
      [
        '59s',
        '1m 29s',
        '1h 2m',
      ],
    )
  },
)

test(
  'Hydra decisions keep their task reference with the question and answer',
  () => {
    const [entry] = hydraMessages({
      messages: [
        {
          ...message({
            id: 'decision',
            actor: 'hydra',
          }),
          task: 'task-example',
          details: 'Asked: Which layout?\nAnswered: A',
        },
      ],
      transcript: [],
    })
    assert.equal(
      entry?.task,
      'task-example',
    )
    assert.match(
      entry!.text,
      /Asked: Which layout\?\nAnswered: A/,
    )
  },
)

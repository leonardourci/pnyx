import { taskMention } from '../src/mentions/mentions.ts'
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { PaseoClient } from '@getpaseo/client'
import { commands } from '../src/cli/commands.ts'
import { sendReply } from '../src/cli/reply.ts'
import { hydraCheck } from '../src/cli/workers.ts'
import { decidePush } from '../src/core/decide.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { readEvents } from '../src/app/event-log.ts'

const scratch = mkdtempSync(join(
  tmpdir(),
  'pnyx-test-',
))
after(() => rmSync(
  scratch,
  {
    recursive: true,
    force: true,
  },
))

function fixture() {
  const home = realpathSync(mkdtempSync(join(
    scratch,
    'pnyx-digest-',
  )))
  process.env.PNYX_HOME = home
  commands.task([
    'create',
    '--key',
    'work',
    '--title',
    'Conversation task',
  ])
  const transcript = join(
    home,
    'worker.jsonl',
  )
  writeFileSync(
    transcript,
    '',
  )
  const state = () => loadHydra({ hydraId: 'default' }).state
  const task = state().keys.work!
  const push = ({ input }: { input: object }) => withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const d = decidePush({
        state: writer.state,
        newCardId: `c${writer.state.seq + 1}`,
        key: 'worker',
        input,
        meta: {
          at: '2026-10-15T12:00:00Z',
          actor: 'fixture',
        },
      })

      if ('event' in d) {
        writer.append({ event: d.event })
      }
    },
  })
  const message = ({
    role,
    text,
  }: {
    role: string
    text: string
  }) => appendFileSync(
    transcript,
    `${JSON.stringify({
      type: role,
      timestamp: '2026-10-15T12:01:00Z',
      message: { content: text },
    })}\n`,
  )
  const check = ({ after }: { after: number }) => hydraCheck({
    args: [
      'check',
      '--after',
      String(after),
    ],
  })

  return {
    home,
    transcript,
    task,
    state,
    push,
    message,
    check,
  }
}

type Digest = {
  task: string
  messages: {
    seq: number
    role: string
    text: string
  }[]
}[]

test(
  'the light check records direct conversation messages once, keeps repeated instructions and pages every change',
  async () => {
    const f = fixture()

    f.push({
      input: {
        agent: {
          provider: 'claude-code',
          sessionId: 'worker',
          transcriptPath: f.transcript,
        },
        terminal: { tty: '/dev/ttys123' },
      },
    })
    await commands.task([
      'attach',
      'work',
      '--session',
      'claude-code:worker',
    ])
    const after = f.state().seq
    f.message({
      role: 'user',
      text: 'Move the release review to tomorrow.',
    })
    f.message({
      role: 'assistant',
      text: 'I will keep the canary running. Token sk-live0123456789abcdefXYZ',
    })
    const first = await f.check({ after })
    const digest = first.conversations as Digest
    assert.equal(
      digest[0]?.task,
      f.task,
    )
    assert.equal(
      digest[0]?.messages.length,
      2,
    )
    assert.match(
      digest[0]!.messages[0]!.text,
      /release review to tomorrow/,
    )
    assert.match(
      digest[0]!.messages[1]!.text,
      /canary running/,
    )
    assert.doesNotMatch(
      JSON.stringify(first),
      /sk-live0123456789abcdefXYZ/,
    )
    assert.equal(
      (await f.check({ after: Number(first.through) })).conversations,
      undefined,
    )

    for (let i = 0; i < 25; i++) {
      f.message({
        role: 'user',
        text: `Continue ${i}. ${'Details '.repeat(60)}`,
      })
    }

    const page = await f.check({ after: Number(first.through) })
    const next = await f.check({ after: Number(page.through) })
    const messages = [
      ...(page.conversations as Digest)[0]!.messages,
      ...(next.conversations as Digest)[0]!.messages,
    ]
    assert.equal(
      messages.length,
      25,
    )
    assert.equal(
      new Set(messages.map(m => m.seq)).size,
      25,
    )
    assert.ok(messages.every(m => m.text.length <= 280))
    assert.equal(
      (await f.check({ after: Number(next.through) })).conversations,
      undefined,
    )
    await commands.task([
      'detach',
      'work',
    ])
    f.message({
      role: 'assistant',
      text: 'The final reply arrived after detach.',
    })
    const detached = await f.check({ after: Number(next.through) })
    assert.equal(
      (detached.conversations as Digest)[0]?.task,
      f.task,
    )
    assert.match(
      JSON.stringify(detached.conversations),
      /reply arrived after detach/,
    )
    const beforeQuestion = f.state().seq
    f.push({
      input: {
        attention: [
          {
            kind: 'question',
            key: 'hook:tool:ask',
            blocking: true,
            text: 'An unrelated session question.',
          },
        ],
      },
    })
    assert.match(
      String((await f.check({ after: beforeQuestion })).changes),
      /none: nothing Hydra tracks/,
    )
    rmSync(f.transcript)
    assert.match(
      JSON.stringify(commands.task([
        'history',
        'work',
        '--full',
        '--limit',
        '100',
      ])),
      /release review/,
    )
  },
)

test(
  'Hydra sends appear before a reply, consume one native echo, and keep a later repeated direct message',
  async () => {
    const f = fixture()

    const home = join(
      f.home,
      'firstmate',
    )
    cpSync(
      join(
        import.meta.dirname,
        'fixtures/firstmate-home',
      ),
      home,
      { recursive: true },
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const d = decidePush({
          state: writer.state,
          newCardId: `c${writer.state.seq + 1}`,
          key: 'work',
          input: {
            source: {
              adapter: 'firstmate',
              instanceId: home,
              objectId: 'api-v2',
            },
          },
          meta: {
            at: '2026-10-15T12:00:00Z',
            actor: 'fixture',
          },
        })
        assert.ok('event' in d)
        writer.append({ event: d.event })
      },
    })
    f.push({
      input: {
        agent: {
          provider: 'claude-code',
          sessionId: 'worker',
          transcriptPath: f.transcript,
        },
        terminal: { tty: '/dev/ttys123' },
      },
    })
    await commands.task([
      'attach',
      'work',
      '--session',
      'claude-code:worker',
    ])
    const after = f.state().seq
    await sendReply({
      hydraId: 'default',
      request: {
        card: f.task,
        text: 'continue',
        actor: 'web',
        homes: [home],
        id: 'owner-1',
      },
    })
    const immediate = await f.check({ after })
    assert.equal(
      (immediate.conversations as Digest)[0]?.messages[0]?.text,
      'continue',
    )
    f.message({
      role: 'user',
      text: 'continue',
    })
    f.message({
      role: 'assistant',
      text: 'Checking the canary.',
    })
    f.message({
      role: 'user',
      text: 'continue',
    })
    const next = await f.check({ after: Number(immediate.through) })
    assert.deepEqual(
      (next.conversations as Digest)[0]?.messages.map(m => m.role),
      [
        'assistant',
        'user',
      ],
    )
    assert.equal(
      (next.conversations as Digest)[0]?.messages[1]?.text,
      'continue',
    )
    assert.equal(
      readEvents({ hydraId: 'default' }).filter(e => e.type === 'chat.message').length,
      3,
    )
    await sendReply({
      hydraId: 'default',
      request: {
        card: f.task,
        text: 'Keep running.',
        actor: 'hydra',
        homes: [home],
        id: 'hydra-1',
      },
    })
    f.message({
      role: 'user',
      text: 'Keep running.',
    })
    assert.equal(
      (await f.check({ after: Number(next.through) })).conversations,
      undefined,
    )
    assert.match(
      readFileSync(
        join(
          home,
          'sent.log',
        ),
        'utf8',
      ),
      /continue/,
    )

    commands.task([
      'create',
      '--key',
      'referenced',
      '--title',
      'Related task',
      '--brief',
      'Context for the receiver',
    ])
    const referenced = f.state().keys.referenced!
    const mention = taskMention({
      id: referenced,
      title: 'Related task',
    })
    const beforeMention = f.state().seq
    await sendReply({
      hydraId: 'default',
      request: {
        card: f.task,
        text: mention,
        actor: 'web',
        homes: [home],
        id: 'mention-1',
      },
    })
    const mentionCheck = await f.check({ after: beforeMention })
    const event = readEvents({ hydraId: 'default' }).find(e => e.type === 'card.replied' && e.data.reply === 'mention-1' && e.data.context)
    assert.ok(event?.type === 'card.replied')
    f.message({
      role: 'user',
      text: [
        mention,
        event.data.context,
      ].join('\n\n'),
    })
    assert.equal(
      (await f.check({ after: Number(mentionCheck.through) })).conversations,
      undefined,
    )
  },
)

test(
  'Paseo messages are archived across pages and only completed assistant replies are committed',
  async () => {
    const f = fixture()

    f.push({
      input: {
        agent: {
          provider: 'codex',
          sessionId: 'paseo',
          paseoAgentId: 'paseo',
          paseoUrl: 'ws://127.0.0.1:16767/ws',
        },
      },
    })
    await commands.task([
      'attach',
      'work',
      '--session',
      'codex:paseo',
    ])
    let active = true
    let closed = 0
    const client = {
      agents: {
        ref: () => ({
          refresh: async () => undefined,
          get activeTurn() {
            return active ? {} : null
          },
          timeline: {
            refetch: async ({ direction }: { direction: string }) => {
              const before = direction === 'before'
              const seq = before ? 1 : 3

              return {
                epoch: 'epoch-1',
                hasOlder: !before,
                startCursor: {
                  epoch: 'epoch-1',
                  seq,
                },
                entries: [
                  {
                    seqStart: seq,
                    timestamp: '2026-10-15T12:01:00Z',
                    item: {
                      type: 'user_message',
                      text: before ? 'Original instruction.' : 'Revised instruction.',
                    },
                  },
                  {
                    seqStart: seq + 1,
                    timestamp: '2026-10-15T12:02:00Z',
                    item: {
                      type: 'assistant_message',
                      text: before ? 'Original answer.' : 'Final answer.',
                    },
                  },
                ],
              }
            },
          },
        }),
      },
      close: async () => {
        closed++
      },
    }
    const connect = async () => client as unknown as PaseoClient
    const after = f.state().seq
    const pending = await hydraCheck({
      args: [
        'check',
        '--after',
        String(after),
      ],
      connect,
    })
    assert.deepEqual(
      (pending.conversations as Digest)[0]?.messages.map(m => m.text),
      [
        'Original instruction.',
        'Revised instruction.',
      ],
    )
    active = false
    const done = await hydraCheck({
      args: [
        'check',
        '--after',
        String(pending.through),
      ],
      connect,
    })
    assert.deepEqual(
      (done.conversations as Digest)[0]?.messages.map(m => m.text),
      [
        'Original answer.',
        'Final answer.',
      ],
    )
    const count = f.state().seq
    await hydraCheck({
      args: [
        'check',
        '--after',
        String(done.through),
      ],
      connect,
    })
    assert.equal(
      f.state().seq,
      count,
    )
    assert.equal(
      closed,
      6,
    )
    commands.task([
      'create',
      '--key',
      'other',
      '--title',
      'Other task',
    ])
    await commands.task([
      'attach',
      'other',
      '--session',
      'codex:paseo',
    ])
    await commands.task([
      'detach',
      'other',
    ])
    const moreClient = {
      agents: {
        ref: () => ({
          refresh: async () => undefined,
          activeTurn: null,
          timeline: {
            refetch: async () => ({
              epoch: 'epoch-1',
              hasOlder: false,
              entries: [
                {
                  seqStart: 5,
                  timestamp: '2026-10-15T12:03:00Z',
                  item: {
                    type: 'assistant_message',
                    text: 'An unchecked result from the first task.',
                  },
                },
              ],
            }),
          },
        }),
      },
      close: async () => undefined,
    }
    await hydraCheck({
      args: [
        'check',
        '--after',
        String(done.through),
      ],
      connect: async () => moreClient as unknown as PaseoClient,
    })
    const oldReply = readEvents({ hydraId: 'default' }).find(e => e.type === 'chat.message' && e.data.text.includes('unchecked result'))
    assert.equal(
      oldReply?.cardId,
      f.task,
    )
    const failure = await hydraCheck({
      args: [
        'check',
        '--after',
        String(done.through),
      ],
      connect: async () => {
        throw new Error('Paseo unavailable')
      },
    })
    assert.match(
      JSON.stringify(failure.unavailable),
      /Paseo unavailable/,
    )
  },
)

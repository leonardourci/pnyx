import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { sendTaskMessage } from '../src/cli/task-message.ts'
import { decidePush } from '../src/core/decide.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { withWriter } from '../src/app/writer.ts'
import { loadHydra } from '../src/app/store.ts'
import { readEvents } from '../src/app/event-log.ts'
import { matchingTasks, mentionContext, mentionId, mentionQuery, taggedParagraphs, taskMention, taskMentions } from '../src/mentions/mentions.ts'

function fixture() {
  const home = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-mentions-',
  )))
  process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
  commands.hydra([
    'create',
    'default',
  ])
  commands.task([
    'create',
    '--key',
    'receiver',
    '--title',
    'Receiving task',
  ])
  commands.task([
    'create',
    '--key',
    'reference',
    '--title',
    'Migration [plan] *v2*',
    '--brief',
    'Preserve the violet rollback path',
    '--project',
    'API',
  ])
  const native = join(
    home,
    'firstmate',
  )
  cpSync(
    join(
      import.meta.dirname,
      'fixtures/firstmate-home',
    ),
    native,
    { recursive: true },
  )
  const state = () => loadHydra({ hydraId: 'default' }).state
  const referenced = state().cards[state().keys.reference!]!
  const text = `Use ${taskMention({
    id: referenced.id,
    title: referenced.title,
  })}`

  return {
    home,
    native,
    state,
    referenced,
    text,
    close: () => rmSync(
      home,
      {
        recursive: true,
        force: true,
      },
    ),
  }
}

test(
  'references round-trip stable IDs and captured titles including Markdown characters',
  () => {
    const mention = {
      id: 'c/a:b',
      title: 'A [plan] \\ with *code* <text> `v2`',
    }
    assert.deepEqual(
      taskMentions({ text: `Read ${taskMention(mention)} next` }),
      [mention],
    )
    assert.equal(
      mentionId({ href: 'pnyx-task:%ZZ' }),
      undefined,
    )
    assert.equal(
      mentionId({ href: 'javascript:alert(1)' }),
      undefined,
    )
    assert.deepEqual(
      taskMentions({ text: '@plan plain email@example.com' }),
      [],
    )
    assert.deepEqual(
      mentionQuery({
        text: 'Compare @Migration plan',
        cursor: 23,
      }),
      {
        start: 8,
        query: 'Migration plan',
      },
    )
    assert.equal(
      mentionQuery({
        text: 'email@example.com',
        cursor: 17,
      }),
      null,
    )
    assert.equal(
      mentionQuery({
        text: 'first @plan\nnext',
        cursor: 16,
      }),
      null,
    )
  },
)

test(
  'matching searches the title and original prompt across projects in this Hydra',
  () => {
    const f = fixture()

    try {
      commands.task([
        'brief',
        'reference',
        '--brief',
        'Replacement working brief',
      ])
      const cards = Object.values(f.state().cards)
      const matches = matchingTasks({
        cards,
        query: 'VIOLET',
      })
      assert.equal(
        matches.length,
        1,
      )
      assert.equal(
        matches[0]?.card.project,
        'API',
      )
      assert.match(
        matches[0]?.excerpt ?? '',
        /violet rollback/,
      )
      assert.equal(
        matchingTasks({
          cards,
          query: 'migration',
        }).length,
        1,
      )
      assert.equal(
        matchingTasks({
          cards,
          query: 'Replacement',
        }).length,
        0,
      )
      assert.equal(
        matchingTasks({
          cards: cards.map(card => ({
            ...card,
            automaticTask: true,
          })),
          query: '',
        }).length,
        0,
      )
    } finally {
      f.close()
    }
  },
)

test(
  'ticket title mentions ignore spaces and case while retaining the original reference',
  () => {
    const f = fixture()
    const title = 'commands and skills are not showing up properly in the composer when I type "/"'

    try {
      commands.task([
        'rename',
        'reference',
        '--title',
        title,
      ])
      const cards = Object.values(f.state().cards)
      const expected = cards.find(card => card.id === f.referenced.id)

      for (const query of [
        'commands and skills',
        'COMMANDS AND SKILLS',
        'commandsandskills',
        'CoMmAnDsAnDsKiLlS',
        '  commands  AND skills  ',
        'commands\tand skills',
      ]) {
        const matches = matchingTasks({
          cards,
          query,
        })
        assert.deepEqual(
          matches.map(({ card }) => card.id),
          [f.referenced.id],
          query,
        )
        assert.equal(
          matches[0]?.card,
          expected,
        )
        assert.equal(
          matches[0]?.card.title,
          title,
        )
      }

      assert.deepEqual(
        matchingTasks({
          cards,
          query: 'unrelated words',
        }),
        [],
      )
      assert.deepEqual(
        matchingTasks({
          cards,
          query: ' \t ',
        }),
        matchingTasks({
          cards,
          query: '',
        }),
      )
    } finally {
      f.close()
    }
  },
)

test(
  'Hydra receives referenced context while history retains the captured title after rename and replay',
  () => {
    const f = fixture()

    try {
      commands.task([
        'rename',
        'reference',
        '--title',
        'Current migration title',
      ])
      commands.task([
        'status',
        'reference',
        'working',
        '--note',
        'Rollback verified',
      ])
      commands.hydra([
        'send',
        '--text',
        f.text,
        '--event-id',
        'mention-hydra',
      ])
      commands.hydra([
        'send',
        '--text',
        f.text,
        '--event-id',
        'mention-hydra',
      ])
      const state = f.state()
      const message = state.hydraMessages?.at(-1)
      assert.equal(
        message?.text,
        f.text,
      )
      assert.match(
        message?.context ?? '',
        /Current migration title/,
      )
      assert.match(
        message?.context ?? '',
        /Initial prompt: Preserve the violet rollback path/,
      )
      assert.match(
        message?.context ?? '',
        /Latest update: Rollback verified/,
      )
      assert.equal(
        state.hydraMessages?.filter(message => message.id === 'mention-hydra').length,
        1,
      )
      assert.deepEqual(
        taskMentions({ text: message?.text ?? '' }),
        [
          {
            id: f.referenced.id,
            title: f.referenced.title,
          },
        ],
      )
      assert.deepEqual(
        replay({
          state: emptyHydra(),
          events: readEvents({ hydraId: 'default' }),
        }),
        state,
      )
      const context = mentionContext({
        state,
        text: `${f.text} ${f.text}`,
      })
      assert.equal(
        context.match(/Initial prompt:/g)?.length,
        1,
      )
      assert.match(
        mentionContext({
          state,
          text: taskMention({
            id: 'missing',
            title: 'Gone',
          }),
        }),
        /Unavailable in this Hydra/,
      )
    } finally {
      f.close()
    }
  },
)

test(
  'card mentions enrich only the receiving agent and Hydra, without attaching or messaging the reference',
  async () => {
    const f = fixture()

    try {
      commands.hydra([
        'set',
        '--firstmate',
        f.native,
      ])
      withWriter({
        hydraId: 'default',
        fn: ({ writer }) => {
          for (const key of [
            'receiver',
            'reference',
          ]) {
            const decision = decidePush({
              state: writer.state,
              key,
              input: {
                agent: {
                  provider: 'claude-code',
                  sessionId: key,
                },
                source: {
                  adapter: 'firstmate',
                  instanceId: f.native,
                  objectId: key,
                },
              },
              meta: {
                at: new Date().toISOString(),
                actor: 'fixture',
              },
            })
            assert.ok('event' in decision); writer.append({ event: decision.event })
          }
        },
      })
      const before = f.state().cards[f.referenced.id]
      const send = () => sendTaskMessage({
        hydraId: 'default',
        request: {
          card: 'receiver',
          text: f.text,
          id: 'mention-message',
          homes: [f.native],
          actor: 'web',
        },
      })
      const receipt = await send()
      assert.equal(
        receipt.state,
        'delivered',
      )
      const sent = readFileSync(
        join(
          f.native,
          'sent.log',
        ),
        'utf8',
      )
      assert.match(
        sent,
        /arg=receiver/,
      )
      assert.doesNotMatch(
        sent,
        /arg=reference\n/,
      )
      assert.match(
        sent,
        /Initial prompt: Preserve the violet rollback path/,
      )
      assert.ok(readEvents({ hydraId: 'default' }).some(event => event.type === 'card.replied' && event.data.reply === 'mention-message' && event.data.text === f.text))
      const notes = JSON.parse(readFileSync(
        join(
          f.native,
          'inbox.json',
        ),
        'utf8',
      )) as { body: string }[]
      assert.match(
        notes[0]?.body ?? '',
        /Initial prompt: Preserve the violet rollback path/,
      )
      assert.deepEqual(
        f.state().cards[f.referenced.id],
        before,
      )
      await send()
      assert.equal(
        readFileSync(
          join(
            f.native,
            'sent.log',
          ),
          'utf8',
        ),
        sent,
      )
    } finally {
      f.close()
    }
  },
)

test(
  'mention-only messages on unassigned cards save context without starting or contacting a worker',
  async () => {
    const f = fixture()

    try {
      const receipt = await sendTaskMessage({
        hydraId: 'default',
        request: {
          card: 'receiver',
          text: f.text,
          homes: [f.native],
        },
      })
      assert.deepEqual(
        receipt.routes,
        { hydra: { state: 'queued' } },
      )
      assert.equal(
        f.state().cards[f.state().keys.receiver!]?.agent,
        undefined,
      )
      assert.equal(
        f.state().cards[f.referenced.id]?.agent,
        undefined,
      )
      assert.equal(
        existsSync(join(
          f.native,
          'sent.log',
        )),
        false,
      )
      assert.match(
        f.state().hydraMessages?.at(-1)?.context ?? '',
        /violet rollback/,
      )
    } finally {
      f.close()
    }
  },
)

test(
  'only paragraphs and list items that start with a task chip are tagged, without the chip, and code blocks never tag',
  () => {
    const chip = ({ id }: { id: string }) => taskMention({
      id,
      title: `Task ${id}`,
    })

    assert.deepEqual(
      taggedParagraphs({
        text: [
          'Captain, here is where things stand.',
          `${chip({ id: 'a' })} A worker started.\nIt runs the tests next.`,
          `- **${chip({ id: 'b' })}**: waiting for review.`,
          `Next, ${chip({ id: 'c' })} only links.`,
          chip({ id: 'd' }),
          `- ${chip({ id: 'e' })} merged.\n- ${chip({ id: 'f' })} waits for review.`,
          `**${chip({ id: 'g' })}:** shipped.`,
          `\`\`\`\n- ${chip({ id: 'x' })} inside code\n\`\`\``,
        ].join('\n\n'),
      }).map(({
        id,
        text,
      }) => [
        id,
        text,
      ]),
      [
        [
          'a',
          'A worker started.\nIt runs the tests next.',
        ],
        [
          'b',
          'waiting for review.',
        ],
        [
          'e',
          'merged.',
        ],
        [
          'f',
          'waits for review.',
        ],
        [
          'g',
          'shipped.',
        ],
      ],
    )
  },
)

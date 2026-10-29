import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { project } from '#projects/cli.ts'
import { loadHydra } from '#app/store.ts'
import { matchingTasks, mentionId, mentionQuery, taggedParagraphs, taskMention, taskMentions } from './mentions.ts'

async function fixture() {
  const home = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-mentions-',
  )))
  process.env.PNYX_HOME = home
  commands.hydra([
    'create',
    'default',
  ])
  const api = join(
    home,
    'API',
  )
  mkdirSync(api)
  await project([
    'add',
    api,
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
      '../integrations/firstmate/fixtures/firstmate-home',
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
    api,
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
  'ticket title mentions ignore spaces and case while retaining the original reference',
  async () => {
    const f = await fixture()
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
  'task suggestions find the owner example and rank title matches before prompt matches',
  async () => {
    const f = await fixture()

    try {
      const cards = [
        {
          ...f.referenced,
          id: 'inside',
          title: 'Rechat comment',
          initialPrompt: '',
        },
        {
          ...f.referenced,
          id: 'owner',
          title: 'Update the chat comment feature prompt',
          initialPrompt: '',
        },
        {
          ...f.referenced,
          id: 'prefix',
          title: 'Chat comment',
          initialPrompt: '',
        },
        {
          ...f.referenced,
          id: 'prompt',
          title: 'Other work',
          initialPrompt: 'Discuss chat',
        },
      ]
      assert.deepEqual(
        matchingTasks({
          cards,
          query: 'thechat',
        }).map(({ card }) => card.id),
        ['owner'],
      )
      assert.deepEqual(
        matchingTasks({
          cards,
          query: 'chatfea',
        }).map(({ card }) => card.id),
        ['owner'],
      )
      assert.deepEqual(
        matchingTasks({
          cards,
          query: 'THE.CHAT',
        }).map(({ card }) => card.id),
        ['owner'],
      )
      assert.deepEqual(
        matchingTasks({
          cards,
          query: 'chat',
        }).map(({ card }) => card.id),
        [
          'prefix',
          'owner',
          'inside',
          'prompt',
        ],
      )
    } finally {
      f.close()
    }
  },
)

test(
  'fuzzy prompt highlights survive excerpt truncation',
  async () => {
    const f = await fixture()

    try {
      const matches = matchingTasks({
        cards: [
          {
            ...f.referenced,
            title: 'Other work',
            initialPrompt: 'chat' + 'x'.repeat(500) + 'feature',
          },
        ],
        query: 'chatfea',
      })
      assert.equal(
        matches.length,
        1,
      )
      assert.equal(
        matches[0]?.excerptHighlights.map(({
          from,
          to,
        }) => matches[0]?.excerpt.slice(
          from,
          to,
        )).join(''),
        'chat',
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

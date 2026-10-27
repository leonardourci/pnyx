import {
  ORCHESTRATE_SKILL,
  SET_UP_SKILL,
  INSCRIBE_SKILL,
} from '../src/integrations/skills/names.ts'
import { checkRegistryLockOrder } from '../src/test-harness/registry-lock-order.ts'
import { project } from '../src/projects/cli.ts'
import assert from 'node:assert/strict'
import { commandCapture } from './command-capture.ts'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands, type Output } from '../src/cli/commands.ts'
import { startTask } from '../src/cli/start.ts'
import { hydraCheck, workerCommands } from '../src/cli/workers.ts'
import { decideLink, decidePush } from '../src/core/decide.ts'
import { DEFAULT_VIEW, DEFAULT_WIDTHS, patchView, traces, viewFor } from '../src/core/view.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { HYDRA_MEMORY_BUDGET, OWNER_MEMORY_BUDGET, TEMPLATE_NUDGE } from '../src/core/digest.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { readEvents } from '../src/app/event-log.ts'

// The digest's setup check reads harness configs; keep it off the real ones.
const harnesses = mkdtempSync(join(
  tmpdir(),
  'pnyx-context-harness-',
))
process.env.CLAUDE_CONFIG_DIR = join(
  harnesses,
  'claude',
)
process.env.CODEX_HOME = join(
  harnesses,
  'codex',
)

function fixture() {
  const home = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-context-',
  )))
  process.env.PNYX_HOME = home
  const run = ({
    name,
    args = [],
    hydraId = 'default',
  }: {
    name: keyof typeof commands
    args?: string[]
    hydraId?: string
  }): Output | Promise<Output> => commands[name]([
    ...args,
    '--hydra',
    hydraId,
  ])
  const state = () => loadHydra({ hydraId: 'default' }).state
  const push = ({
    key,
    input,
  }: {
    key: string
    input: object
  }) => withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const d = decidePush({
        state: writer.state,
        newCardId: `c${writer.state.seq + 1}`,
        key,
        input,
        meta: {
          at: '2026-10-15T12:00:00Z',
          actor: 'test',
        },
      })

      if ('event' in d) {
        writer.append({ event: d.event })
      }
    },
  })

  return {
    home,
    run,
    state,
    push,
  }
}

test(
  'a brief update is idempotent by event id, hiding leaves the list, and declaring done moves the task to Done',
  async () => {
    const f = fixture()

    try {
      await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'work',
          '--title',
          'Work',
          '--brief',
          'Check the canary.',
          '--column',
          'in_progress',
        ],
      })
      const id = f.state().keys.work!
      await f.run({
        name: 'task',
        args: [
          'brief',
          'work',
          '--brief',
          'Check the canary and rollback.',
          '--event-id',
          'brief-v2',
        ],
      })
      assert.equal(
        f.state().cards[id]?.brief,
        'Check the canary and rollback.',
      )
      assert.equal(
        f.state().cards[id]?.column,
        'in_progress',
      )
      assert.deepEqual(
        replay({
          state: emptyHydra(),
          events: readEvents({ hydraId: 'default' }),
        }),
        f.state(),
      )
      const seq = f.state().seq
      await f.run({
        name: 'task',
        args: [
          'brief',
          'work',
          '--brief',
          'Ignored retry',
          '--event-id',
          'brief-v2',
        ],
      })
      assert.equal(
        f.state().seq,
        seq,
      )
      await f.run({
        name: 'task',
        args: [
          'hide',
          'work',
        ],
      })
      assert.equal(
        f.state().cards[id]?.hidden,
        true,
      )
      assert.match(
        JSON.stringify(await f.run({
          name: 'task',
          args: ['list'],
        })),
        /none: no tasks/,
      )
      assert.match(
        JSON.stringify(await f.run({
          name: 'task',
          args: [
            'show',
            'work',
          ],
        })),
        /Check the canary and rollback/,
      )
      await f.run({
        name: 'task',
        args: [
          'status',
          'work',
          'done',
        ],
      })
      assert.equal(
        f.state().cards[id]?.column,
        'done',
      )
      assert.equal(
        f.state().cards[id]?.hidden,
        true,
      )
      await f.run({
        name: 'task',
        args: [
          'unhide',
          'work',
        ],
      })
      assert.equal(
        f.state().cards[id]?.hidden,
        false,
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'descriptions and widths persist, resetting widths preserves the rest of the view',
  async () => {
    const f = fixture()

    try {
      await f.run({
        name: 'column',
        args: [
          'describe',
          'needs_you',
          '--description',
          'Questions only.',
        ],
      })
      assert.equal(
        f.state().config?.columns.find(c => c.id === 'needs_you')?.description,
        'Questions only.',
      )
      await f.run({
        name: 'column',
        args: [
          'create',
          '--id',
          'custom:review',
          '--title',
          'Review',
          '--description',
          'Results awaiting review.',
        ],
      })
      await f.run({
        name: 'view',
        args: [
          'set',
          '--json',
          '{"theme":"dark","fontSize":18,"lastMessageOnCards":true,"focusMode":false}',
        ],
      })
      await f.run({
        name: 'column',
        args: [
          'resize',
          'custom:review',
          '--width',
          '420',
        ],
      })
      await f.run({
        name: 'hydra',
        args: [
          'resize',
          '--width',
          '480',
        ],
      })
      assert.equal(
        viewFor({ state: f.state() }).columnWidths['custom:review'],
        420,
      )
      assert.equal(
        viewFor({ state: f.state() }).hydraWidth,
        480,
      )
      const state = f.state()
      assert.equal(
        viewFor({ state }).lastMessageOnCards,
        true,
      )
      assert.deepEqual(
        [
          traces({
            view: viewFor({ state }),
            card: 'c1',
          }).tools,
          traces({
            view: viewFor({ state }),
            card: 'c1',
          }).thinking,
        ],
        [
          true,
          true,
        ],
      )
      const focused = patchView({
        state,
        input: {
          focusMode: true,
          toolDetails: true,
          thinkingDetails: true,
        },
      })
      assert.deepEqual(
        [
          traces({
            view: focused,
            card: 'c1',
          }).tools,
          traces({
            view: focused,
            card: 'c1',
          }).thinking,
        ],
        [
          false,
          false,
        ],
      )
      assert.equal(
        viewFor({
          state: {
            ...state,
            view: undefined,
          },
        }).lastMessageOnCards,
        DEFAULT_VIEW.lastMessageOnCards,
      )
      assert.deepEqual(
        replay({
          state: emptyHydra(),
          events: readEvents({ hydraId: 'default' }),
        }),
        state,
      )
      const deletion = await f.run({
        name: 'column',
        args: [
          'delete',
          'custom:review',
        ],
      })
      await f.run({
        name: 'column',
        args: [
          'delete',
          'custom:review',
          '--confirm',
          String(deletion.token),
        ],
      })
      assert.throws(() => f.run({
        name: 'hydra',
        args: [
          'resize',
          '--width',
          '20',
        ],
      }))
      await f.run({
        name: 'layout',
        args: ['reset'],
      })
      const view = viewFor({ state: f.state() })
      assert.equal(
        view.hydraWidth,
        DEFAULT_WIDTHS.hydra,
      )
      assert.deepEqual(
        view.columnWidths,
        {},
      )
      assert.equal(
        view.theme,
        'dark',
      )
      assert.equal(
        view.fontSize,
        18,
      )
      await f.run({
        name: 'view',
        args: [
          'set',
          '--json',
          JSON.stringify({
            defaultHydraWidth: 400,
            defaultColumnWidths: { needs_you: 310 },
          }),
        ],
      })
      await f.run({
        name: 'layout',
        args: ['reset'],
      })
      const reset = f.state()
      assert.equal(
        reset.view?.hydraWidth,
        400,
      )
      assert.equal(
        reset.view?.columnWidths.needs_you,
        310,
      )
      assert.equal(
        reset.config?.columns.find(c => c.id === 'needs_you')?.description,
        'Questions only.',
      )
      assert.deepEqual(
        replay({
          state: emptyHydra(),
          events: readEvents({ hydraId: 'default' }),
        }),
        reset,
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'moves and deletes confirm the exact action and reject a token after the target changes',
  async () => {
    const f = fixture()

    try {
      await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'work',
          '--title',
          'Work',
        ],
      })
      const args = [
        'work',
        'done',
        '--actor',
        'hydra',
        '--reason',
        'The worker finished',
        '--event-id',
        'move-work',
      ]
      const first = await f.run({
        name: 'move',
        args,
      })
      const id = f.state().keys.work!
      assert.equal(
        first.confirmation,
        'needed',
      )
      assert.equal(
        f.state().cards[id]?.column,
        'queued',
      )
      await f.run({
        name: 'task',
        args: [
          'rename',
          'work',
          '--title',
          'Changed task',
        ],
      })
      const stale = await f.run({
        name: 'move',
        args: [
          ...args,
          '--confirm',
          String(first.token),
        ],
      })
      assert.equal(
        stale.confirmation,
        'needed',
      )
      assert.notEqual(
        stale.token,
        first.token,
      )
      await f.run({
        name: 'move',
        args: [
          ...args,
          '--confirm',
          String(stale.token),
        ],
      })
      assert.equal(
        f.state().cards[id]?.column,
        'done',
      )
      const deletion = await f.run({
        name: 'column',
        args: [
          'delete',
          'done',
          '--to',
          'parked',
        ],
      })
      assert.equal(
        deletion.confirmation,
        'needed',
      )
      const other = await f.run({
        name: 'column',
        args: [
          'delete',
          'done',
          '--to',
          'needs_you',
          '--confirm',
          String(deletion.token),
        ],
      })
      assert.equal(
        other.confirmation,
        'needed',
      )
      await f.run({
        name: 'column',
        args: [
          'delete',
          'done',
          '--to',
          'parked',
          '--confirm',
          String(deletion.token),
        ],
      })
      assert.equal(
        f.state().cards[id]?.column,
        'parked',
      )
      const reorder = await f.run({
        name: 'column',
        args: [
          'reorder',
          'parked',
          '--before',
          'queued',
        ],
      })
      assert.equal(
        reorder.confirmation,
        'needed',
      )
      await f.run({
        name: 'column',
        args: [
          'reorder',
          'parked',
          '--before',
          'queued',
          '--confirm',
          String(reorder.token),
        ],
      })
      assert.equal(
        f.state().config?.columns[0]?.id,
        'parked',
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Hydra changes keep their reasons on events without posting chat lines',
  async () => {
    const f = fixture()

    try {
      const hydra = [
        '--actor',
        'hydra',
      ]
      await assert.rejects(
        async () => f.run({
          name: 'task',
          args: [
            'create',
            '--key',
            'work',
            '--title',
            'API cleanup',
            ...hydra,
          ],
        }),
        { code: 'VALIDATION_ERROR' },
      )
      const created = await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'work',
          '--title',
          'API cleanup',
          ...hydra,
          '--reason',
          'the owner asked for it',
        ],
      })
      assert.equal(
        created.posted,
        undefined,
      )
      await assert.rejects(
        async () => f.run({
          name: 'task',
          args: [
            'brief',
            'work',
            '--brief',
            'Check it.',
            ...hydra,
            '--reason',
            ' ',
          ],
        }),
        /--reason/,
      )
      const why = [
        '--reason',
        'its agent asked which schema to use',
        '--details',
        'It found two schemas: v1 in the API and v2 in the migration.',
      ]
      const asked = await f.run({
        name: 'move',
        args: [
          'work',
          'needs_you',
          ...hydra,
          ...why,
        ],
      })
      assert.equal(
        asked.posted,
        undefined,
      )
      const moved = await f.run({
        name: 'move',
        args: [
          'work',
          'needs_you',
          ...hydra,
          ...why,
          '--event-id',
          'move-1',
          '--confirm',
          String(asked.token),
        ],
      })
      assert.equal(
        moved.posted,
        undefined,
      )
      await f.run({
        name: 'move',
        args: [
          'work',
          'done',
          '--actor',
          'web',
        ],
      })
      await f.run({
        name: 'task',
        args: [
          'brief',
          'work',
          '--brief',
          'Owner edit.',
        ],
      })
      const summaries = (await f.run({
        name: 'task',
        args: [
          'history',
          'work',
        ],
      }) as { events: { summary: string }[] }).events.map(e => e.summary)
      assert.deepEqual(
        summaries,
        [
          'Task brief updated',
          'needs_you -> done',
          'queued -> needs_you (why: its agent asked which schema to use)',
          'Created task: API cleanup (why: the owner asked for it)',
        ],
      )

      const history = await f.run({
        name: 'task',
        args: [
          'history',
          'work',
          '--full',
        ],
      }) as {
        events: {
          type: string
          reason?: string
          details?: string
        }[]
      }
      const move = history.events.find(event => event.type === 'card.moved' && event.reason)
      assert.equal(
        move?.details,
        'It found two schemas: v1 in the API and v2 in the migration.',
      )
      assert.equal(
        f.state().hydraMessages?.length ?? 0,
        0,
      )
      const check = await hydraCheck({
        args: [
          'check',
          '--after',
          '0',
          '--hydra',
          'default',
        ],
      }) as {
        changes: {
          type: string
          actor: string
          summary: string
        }[]
      }
      const own = check.changes.filter(c => c.type === 'hydra.message').map(c => c.summary)
      assert.deepEqual(
        own,
        [],
      )
      assert.ok(check.changes.some(c => c.actor === 'owner (web)'))
      assert.ok(!check.changes.some(c => c.actor === 'hydra' && c.type !== 'hydra.message'))
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Hydra starts, undos and returns stay out of chat and receipts carry the current revision',
  async () => {
    const f = fixture()

    try {
      const hydra = [
        '--actor',
        'hydra',
      ]
      await f.run({
        name: 'hydra',
        args: [
          'set',
          '--command',
          'true',
        ],
      })
      await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'work',
          '--title',
          'Docs',
          '--folder',
          f.home,
        ],
      })
      const id = f.state().keys.work!
      const started = await f.run({
        name: 'task',
        args: [
          'start',
          'work',
          '--via',
          'command',
          ...hydra,
          '--reason',
          'the brief is ready',
        ],
      })
      assert.equal(
        started.posted,
        undefined,
      )
      const hidden = await f.run({
        name: 'task',
        args: [
          'hide',
          'work',
          ...hydra,
          '--reason',
          'the owner paused it',
        ],
      }) as { card: { revision: number } }
      assert.equal(
        hidden.card.revision,
        f.state().cards[id]!.revision,
      )
      const shown = await f.run({
        name: 'task',
        args: [
          'unhide',
          'work',
          ...hydra,
          '--reason',
          'the owner resumed it',
          '--details',
          'Resume after the release.',
        ],
      })
      assert.equal(
        shown.posted,
        undefined,
      )
      const moved = await f.run({
        name: 'move',
        args: [
          'work',
          'done',
          '--actor',
          'web',
        ],
      }) as { event: { id: string } }
      const undone = await f.run({
        name: 'undo',
        args: [
          moved.event.id,
          ...hydra,
          '--reason',
          'the work is not finished',
        ],
      })
      assert.equal(
        undone.posted,
        undefined,
      )
      assert.equal(
        f.state().hydraMessages?.length ?? 0,
        0,
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'the digest prints columns, open tasks, what waits, owner memory and Hydra memory, each within its budget',
  async () => {
    const f = fixture()

    try {
      await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'api',
          '--title',
          'API cleanup',
          '--column',
          'in_progress',
        ],
      })
      await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'old',
          '--title',
          'Old work',
          '--column',
          'done',
        ],
      })
      await f.run({
        name: 'task',
        args: [
          'status',
          'api',
          'needs_you',
          '--note',
          'Which schema?',
        ],
      })
      f.push({
        key: 'api',
        input: {
          attention: [
            {
              kind: 'question',
              key: 'q1',
              blocking: true,
              text: 'Use v2 or v3?',
            },
          ],
        },
      })
      await f.run({
        name: 'owner',
        args: [
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Short PRs.',
        ],
      })
      await f.run({
        name: 'hydra',
        args: [
          'memory',
          'set',
          '--key',
          'scope',
          '--text',
          'API work.',
        ],
      })
      const digest = await workerCommands.hydra([
        'digest',
        '--hydra',
        'default',
      ]) as unknown as string
      assert.match(
        digest,
        new RegExp(`^<pnyx-digest hydra="default" through="${f.state().seq}">`),
      )
      assert.match(
        digest,
        /- needs_you · Needs you · 1 · owner-question OR reminder-due · Work that needs the owner/,
      )
      assert.match(
        digest,
        /· API cleanup · Needs you · needs_you: Which schema\? · no worker\n {2}waiting: question "Use v2 or v3\?"/,
      )
      assert.doesNotMatch(
        digest,
        /Old work/,
      )
      assert.match(
        digest,
        /1 done tasks not listed/,
      )
      assert.match(
        digest,
        /Owner preferences \(owner memory key preferences\):\nShort PRs\.\n/,
      )
      assert.match(
        digest,
        /Learnings \(owner memory key learnings\):\nnone yet/,
      )
      assert.match(
        digest,
        new RegExp(`Owner memory uses 10 of ${OWNER_MEMORY_BUDGET} characters\\.\n\nHydra memory \\(this Hydra only\\):\n- scope: API work\\.\nHydra memory uses 9 of ${HYDRA_MEMORY_BUDGET} characters\\.\n`),
      )
      assert.ok(digest.includes(`\nSetup needed (load ${SET_UP_SKILL}):\n- config: ${TEMPLATE_NUDGE} · you: pnyx-axi rule init --shared --hydra default\n`))
      assert.throws(
        () => f.run({
          name: 'hydra',
          args: [
            'memory',
            'set',
            '--key',
            'preferences',
            '--text',
            'Long PRs.',
          ],
        }),
        /Pnyx-wide owner memory/,
      )

      await f.run({
        name: 'owner',
        args: [
          'memory',
          'set',
          '--key',
          'constructor',
          '--text',
          'Kept.',
        ],
      })
      assert.match(
        await workerCommands.hydra([
          'digest',
          '--hydra',
          'default',
        ]) as unknown as string,
        /Other owner memory:\n- constructor: Kept\./,
      )
      await f.run({
        name: 'owner',
        args: [
          'memory',
          'forget',
          '--key',
          'constructor',
        ],
      })

      for (const skill of [
        ORCHESTRATE_SKILL,
        INSCRIBE_SKILL,
      ]) {
        assert.match(
          readFileSync(
            join(
              import.meta.dirname,
              '..',
              'skills',
              skill,
              'SKILL.md',
            ),
            'utf8',
          ),
          new RegExp(`${OWNER_MEMORY_BUDGET}[\\s\\S]*${HYDRA_MEMORY_BUDGET}|${HYDRA_MEMORY_BUDGET}[\\s\\S]*${OWNER_MEMORY_BUDGET}`),
        )
      }

      for (const [
        name,
        key,
        budget,
        used,
      ] of [
          [
            'owner',
            'learnings',
            OWNER_MEMORY_BUDGET,
            10,
          ],
          [
            'hydra',
            'notes',
            HYDRA_MEMORY_BUDGET,
            9,
          ],
        ] as const) {
        assert.throws(
          () => f.run({
            name,
            args: [
              'memory',
              'set',
              '--key',
              key,
              '--text',
              'x'.repeat(budget - used + 1),
            ],
          }),
          new RegExp(`would use ${budget + 1} of ${budget}`),
        )
        await f.run({
          name,
          args: [
            'memory',
            'set',
            '--key',
            key,
            '--text',
            'x'.repeat(budget - used),
          ],
        })
        assert.match(
          JSON.stringify(await f.run({
            name,
            args: ['memory'],
          })),
          new RegExp(`${budget} of ${budget} characters`),
        )
      }

      assert.match(
        await workerCommands.hydra([
          'digest',
          '--hydra',
          'default',
        ]) as unknown as string,
        new RegExp(String.raw`Owner memory uses 24000 of 24000 characters\. Load the ${INSCRIBE_SKILL} skill[\s\S]*Hydra memory uses 1500 of 1500 characters\. Load the ${INSCRIBE_SKILL} skill`),
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Hydra memory replaces by key, survives switching Hydra and isolates Hydras',
  async () => {
    const f = fixture()

    try {
      await f.run({
        name: 'hydra',
        args: [
          'memory',
          'set',
          '--key',
          'review-policy',
          '--text',
          'Check the canary.',
        ],
      })
      await f.run({
        name: 'hydra',
        args: [
          'memory',
          'set',
          '--key',
          'review-policy',
          '--text',
          'Check canary and rollback.',
        ],
      })
      await f.run({
        name: 'hydra',
        args: [
          'set',
          '--identity',
          'new-hydra',
        ],
      })
      assert.equal(
        f.state().hydraMemory?.['review-policy']?.text,
        'Check canary and rollback.',
      )
      assert.match(
        JSON.stringify(await f.run({
          name: 'hydra',
          hydraId: 'other',
          args: ['memory'],
        })),
        /none: no Hydra memory/,
      )
      assert.throws(() => f.run({
        name: 'hydra',
        args: [
          'memory',
          'set',
          '--key',
          '../escape',
          '--text',
          'No.',
        ],
      }))
      await f.run({
        name: 'hydra',
        args: [
          'memory',
          'forget',
          '--key',
          'review-policy',
        ],
      })
      assert.deepEqual(
        f.state().hydraMemory,
        {},
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'attaching hands the brief to the agent once and Firstmate start includes it',
  async t => {
    const f = fixture()

    try {
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
      await f.run({
        name: 'hydra',
        args: [
          'set',
          '--firstmate',
          home,
        ],
      })
      const projectPath = join(
        home,
        'projects',
        'api',
      )
      mkdirSync(
        projectPath,
        { recursive: true },
      )
      await project([
        'memory',
        'set',
        '--project',
        projectPath,
        '--key',
        'preferences',
        '--text',
        'Project handoff preference.',
      ])
      await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'work',
          '--title',
          'Work',
          '--brief',
          'Verify the canary.',
          '--project',
          projectPath,
        ],
      })
      f.push({
        key: 'work',
        input: {
          source: {
            adapter: 'firstmate',
            instanceId: home,
            objectId: 'api-v2',
          },
        },
      })
      f.push({
        key: 'agent',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'worker',
          },
          terminal: { tty: '/dev/ttys123' },
        },
      })
      const attach = [
        'attach',
        'work',
        '--session',
        'claude-code:worker',
        '--event-id',
        'attach-worker',
      ]
      const sent = await f.run({
        name: 'task',
        args: attach,
      })
      assert.equal(
        (sent.brief as Output).state,
        'delivered',
      )
      const log = readFileSync(
        join(
          home,
          'sent.log',
        ),
        'utf8',
      )
      assert.match(
        log,
        /Verify the canary/,
      )
      assert.match(
        log,
        /Project handoff preference/,
      )
      assert.match(
        log,
        /project show.*--hydra default/,
      )
      await f.run({
        name: 'task',
        args: attach,
      })
      assert.equal(
        readFileSync(
          join(
            home,
            'sent.log',
          ),
          'utf8',
        ),
        log,
      )
      await f.run({
        name: 'task',
        args: [
          'detach',
          'work',
        ],
      })
      f.push({
        key: 'replacement',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'replacement',
          },
          terminal: { tty: '/dev/ttys124' },
        },
      })
      await f.run({
        name: 'task',
        args: [
          'attach',
          'work',
          '--session',
          'claude-code:replacement',
        ],
      })
      const replacementLog = readFileSync(
        join(
          home,
          'sent.log',
        ),
        'utf8',
      )
      const retry = await f.run({
        name: 'task',
        args: attach,
      })
      assert.equal(
        (retry.brief as Output).state,
        'failed',
      )
      assert.equal(
        readFileSync(
          join(
            home,
            'sent.log',
          ),
          'utf8',
        ),
        replacementLog,
      )
      await f.run({
        name: 'task',
        args: [
          'detach',
          'work',
        ],
      })
      checkRegistryLockOrder({
        t,
        hydraId: 'default',
      })
      await startTask({
        hydraId: 'default',
        task: 'work',
        via: 'firstmate',
        meta: {
          at: '2026-10-15T12:00:00Z',
          actor: 'test',
        },
      })
      assert.match(
        readFileSync(
          join(
            home,
            'inbox.json',
          ),
          'utf8',
        ),
        /Verify the canary/,
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'the Hydra command receives the task brief before explicit opening instructions',
  async t => {
    const capture = commandCapture({ t })
    const f = fixture()

    try {
      await f.run({
        name: 'hydra',
        args: [
          'set',
          '--command',
          'node -e \'const fs=require("fs");fs.writeFileSync("prompt.json.tmp", JSON.stringify(process.env.PNYX_PROMPT));fs.renameSync("prompt.json.tmp","prompt.json")\'',
        ],
      })
      await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'work',
          '--title',
          'Work',
          '--folder',
          f.home,
          '--brief',
          'Verify the canary.',
        ],
      })
      await startTask({
        hydraId: 'default',
        task: 'work',
        via: 'command',
        prompt: 'Then report the result.',
        meta: {
          at: '2026-10-15T12:00:00Z',
          actor: 'test',
        },
      })
      const path = join(
        f.home,
        'prompt.json',
      )

      await capture.completed()

      assert.match(
        JSON.parse(readFileSync(
          path,
          'utf8',
        )),
        /^<pnyx-worker [^>]*>[\s\S]*<\/pnyx-worker>\n\nVerify the canary\.\n\nThen report the result\.$/,
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a linked pull request with an unknown state prevents early completion',
  async () => {
    const f = fixture()

    try {
      await f.run({
        name: 'task',
        args: [
          'create',
          '--key',
          'unread-pr',
          '--title',
          'Wait for merge evidence',
        ],
      })
      withWriter({
        hydraId: 'default',
        fn: ({ writer }) => {
          const decision = decideLink({
            state: writer.state,
            ref: 'unread-pr',
            url: 'https://github.com/example/project/pull/1',
            link: {
              kind: 'github_pr',
              url: 'https://github.com/example/project/pull/1',
            },
            meta: {
              at: '2026-10-24T00:00:00Z',
              actor: 'fixture',
            },
          })

          if ('event' in decision) {
            writer.append({ event: decision.event })
          }
        },
      })
      assert.throws(
        () => f.run({
          name: 'task',
          args: [
            'status',
            'unread-pr',
            'done',
          ],
        }),
        { code: 'NOT_LANDED' },
      )
    } finally {
      rmSync(
        f.home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

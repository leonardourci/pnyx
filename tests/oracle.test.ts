import { readEvents } from '#app/event-log.ts'
import { workerLine } from './setup/worker-log.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadHydra } from '#app/store.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { appendFileSync, existsSync } from 'node:fs'
import { transcriptPath } from '#workers/claude.ts'
import { join } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import { parsed, operation, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

interface Result {
  card: string
  title: string
  snippets: {
    snippet: string
    parts?: {
      text: string
      matched: boolean
    }[]
  }[]
}

const search = async ({
  hydra,
  args,
}: {
  hydra: Hydra
  args: string[]
}) => ((await hydra.owner({
  args: [
    'oracle',
    ...args,
  ],
})).results) as Result[] | string

test(
  'the Oracle finds a new task at once by its title, brief and status notes, ranks a title match first, hides secrets and never reads agent transcripts',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'billing' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Invoice export nightly',
        '--key',
        'export',
        '--folder',
        folder,
        '--brief',
        'Move the job to 2am UTC; token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Tidy the ledger',
        '--key',
        'ledger',
        '--brief',
        'The invoice totals are off by a cent',
      ],
    })

    const byTitle = await search({
      hydra,
      args: ['invoice'],
    })
    expect((byTitle as Result[]).map(result => result.title)).toEqual([
      'Invoice export nightly',
      'Tidy the ledger',
    ])
    expect(JSON.stringify(byTitle)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    expect(JSON.stringify(byTitle)).toContain('[redacted]')
    const ledger = (byTitle as Result[]).find(result => result.title === 'Tidy the ledger')
    expect(ledger?.snippets).toContainEqual(expect.objectContaining({
      snippet: expect.stringContaining('[invoice]'),
    }))

    for (const query of [
      'invoices',
      'invoi*',
    ]) {
      expect((await search({
        hydra,
        args: [query],
      }) as Result[]).map(result => result.title)).toEqual([
        'Invoice export nightly',
        'Tidy the ledger',
      ])
    }

    const fuzzy = await hydra.owner({
      args: [
        'oracle',
        'invoce',
      ],
    })
    expect(fuzzy.mode).toBe('fuzzy')
    expect(fuzzy.results).toContainEqual(expect.objectContaining({ title: 'Tidy the ledger' }))

    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('<pnyx-worker'),
      reply: 'Checked the zebracorn scheduler config.',
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'export',
      ],
    })
    const worker = await hydra.agent({ cwd: folder })
    await until({
      what: 'the worker\'s turn',
      check: () => worker.answered === 1,
    })
    await workerLine({
      hydra,
      key: 'export',
      line: 'note: Found the cron drift in the scheduler',
    })

    expect(await search({
      hydra,
      args: ['cron drift'],
    })).toEqual([expect.objectContaining({ title: 'Invoice export nightly' })])

    const fromAgent = await hydra.as({ session: worker }).run({
      args: [
        'oracle',
        'cron drift',
      ],
    })
    expect(fromAgent.results).toEqual([expect.objectContaining({ title: 'Invoice export nightly' })])
    appendFileSync(
      transcriptPath({
        cwd: worker.cwd,
        session: worker.id,
        folder: worker.env.CLAUDE_CONFIG_DIR,
      }),
      [
        JSON.stringify({
          type: 'user',
          timestamp: new Date().toISOString(),
          uuid: 'ledger-owner-answer',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'ledger-choice',
                content: 'Use cobalt',
              },
            ],
          },
          toolUseResult: {
            questions: [{ question: 'Which ledger color?' }],
            answers: { 'Which ledger color?': 'Use cobalt' },
          },
        }),
        JSON.stringify({
          type: 'summary',
          timestamp: new Date().toISOString(),
          leafUuid: 'ledger-summary',
          summary: 'Keep amber reconciliation enabled.',
        }),
        JSON.stringify({
          type: 'custom-title',
          timestamp: new Date().toISOString(),
          customTitle: 'Native title metadata only',
        }),
      ].join('\n') + '\n',
    )
    await hydra.owner({
      args: [
        'harvest',
        '--card',
        'export',
      ],
    })
    const notes = await hydra.owner({
      args: [
        'card',
        'export',
        '--full',
      ],
    })
    expect(notes.notes.decisions).toEqual([
      expect.objectContaining({
        text: 'Which ledger color?\nAnswer: Use cobalt',
      }),
    ])
    expect(notes.notes.summary).toEqual([expect.objectContaining({ text: 'Keep amber reconciliation enabled.' })])
    expect(readEvents({
      hydraId: hydra.id,
      cardId: notes.card.id,
      types: ['card.noted'],
    }).filter(event => event.actor === 'harvest')
      .map(event => ({ kind: event.type === 'card.noted' ? event.data.kind : undefined }))).toEqual([
      { kind: 'decision' },
      { kind: 'summary' },
    ])
    expect(await search({
      hydra,
      args: ['cobalt'],
    })).toEqual([expect.objectContaining({ title: 'Invoice export nightly' })])
    expect(await search({
      hydra,
      args: ['amber'],
    })).toEqual([expect.objectContaining({ title: 'Invoice export nightly' })])
    await pnyx.restart()
    const restored = await hydra.owner({
      args: [
        'card',
        'export',
        '--full',
      ],
    })
    expect(restored.notes.decisions).toEqual([
      expect.objectContaining({
        text: 'Which ledger color?\nAnswer: Use cobalt',
      }),
    ])
    expect(restored.notes.summary).toEqual([expect.objectContaining({ text: 'Keep amber reconciliation enabled.' })])
    expect(await search({
      hydra,
      args: ['cobalt'],
    })).toEqual([expect.objectContaining({ title: 'Invoice export nightly' })])
    expect(await search({
      hydra,
      args: ['amber'],
    })).toEqual([expect.objectContaining({ title: 'Invoice export nightly' })])
    expect(await search({
      hydra,
      args: ['cron drift'],
    })).toEqual([expect.objectContaining({ title: 'Invoice export nightly' })])
    expect(await search({
      hydra,
      args: ['zebracorn'],
    })).toBe('none: no matches for "zebracorn"')
  },
)

test(
  'column and date filters narrow a search the same way from the page and the CLI, and a bad filter is refused',
  async () => {
    const hydra = await pnyx.hydra()
    const done = await hydra.column({ role: 'done' })

    for (const key of [
      'open',
      'closed',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          `Release checklist ${key}`,
          '--key',
          key,
        ],
      })
    }

    await hydra.owner({
      args: [
        'outcome',
        'closed',
        'done',
      ],
    })

    const inDone = await search({
      hydra,
      args: [
        'checklist',
        '--column',
        done,
      ],
    }) as Result[]
    expect(inDone.map(result => result.title)).toEqual(['Release checklist closed'])

    const page = await hydra.page()
    const fromPage = await page.send({
      name: 'oracle',
      args: [
        'checklist',
        '',
        '',
        JSON.stringify({ columns: [done] }),
      ],
    }) as unknown as { hits: Result[] }
    expect(fromPage.hits.map(hit => hit.card)).toEqual(inDone.map(result => result.card))
    expect(fromPage.hits.some(hit => hit.snippets.some(snippet =>
      snippet.parts?.some(part => part.matched && part.text.toLowerCase() === 'checklist')))).toBe(true)
    page.close()

    expect((await search({
      hydra,
      args: ['ship'],
    }) as Result[]).map(result => result.title).toSorted()).toEqual([
      'Release checklist closed',
      'Release checklist open',
    ])

    expect(await search({
      hydra,
      args: [
        'checklist',
        '--since',
        '2099-01-01',
      ],
    })).toBe('none: no matches for "checklist"')
    expect((await search({
      hydra,
      args: [
        'checklist',
        '--since',
        '2020-01-01',
      ],
    }) as Result[]).map(result => result.title).toSorted()).toEqual([
      'Release checklist closed',
      'Release checklist open',
    ])
    expect((await hydra.ownerRefused({
      args: [
        'oracle',
        'checklist',
        '--since',
        'not-a-date',
      ],
    })).code).toBe('VALIDATION_ERROR')
  },
)

test(
  'the project filter keeps only the tasks of the named project, from the CLI and from the page',
  async () => {
    const hydra = await pnyx.hydra()
    const projects = {} as Record<'alpha' | 'beta', string>

    for (const name of [
      'alpha',
      'beta',
    ] as const) {
      const path = hydra.folder({ name })

      for (const args of [
        [
          'init',
          '-q',
          '-b',
          'main',
        ],
        [
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ],
      ]) {
        git({
          cwd: path,
          args,
        })
      }

      await hydra.owner({
        args: [
          'project',
          'add',
          path,
        ],
      })
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          `Roadmap ${name}`,
          '--key',
          name,
          '--project',
          path,
        ],
      })
      projects[name] = path
    }

    expect((await search({
      hydra,
      args: ['roadmap'],
    }) as Result[]).map(result => result.title).toSorted()).toEqual([
      'Roadmap alpha',
      'Roadmap beta',
    ])
    expect((await search({
      hydra,
      args: [
        'roadmap',
        '--project',
        projects.alpha,
      ],
    }) as Result[]).map(result => result.title)).toEqual(['Roadmap alpha'])
    expect((await search({
      hydra,
      args: [
        'roadmap',
        '--project',
        'beta',
      ],
    }) as Result[]).map(result => result.title)).toEqual(['Roadmap beta'])

    const page = await hydra.page()
    const fromPage = await page.send({
      name: 'oracle',
      args: [
        'roadmap',
        '',
        '',
        JSON.stringify({ projects: [projects.beta] }),
      ],
    }) as unknown as { hits: Result[] }
    expect(fromPage.hits.map(hit => hit.title)).toEqual(['Roadmap beta'])
    page.close()
  },
)

test(
  'the Oracle follows task log tails across restart and a folder move',
  async () => {
    const source = await pnyx.hydra()
    const destination = await pnyx.hydra()
    const created = await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'travel',
        '--title',
        'Portable notes',
      ],
    })
    await workerLine({
      hydra: source,
      key: 'travel',
      line: 'note: nebularocket continuity evidence',
    })
    await workerLine({
      hydra: source,
      key: 'travel',
      line: 'note: Later report without the earlier keyword',
    })
    const find = async ({ hydra }: { hydra: Hydra }) => search({
      hydra,
      args: ['nebularocket'],
    })
    const portable = expect.objectContaining({ card: created.card.id })
    const concurrent = await Promise.all([
      find({ hydra: source }),
      find({ hydra: source }),
    ])
    expect(concurrent).toEqual([
      [portable],
      [portable],
    ])
    await pnyx.restart()
    expect(await find({ hydra: source })).toEqual([portable])
    await source.owner({
      args: [
        'task',
        'rename',
        'travel',
        '--title',
        'Moved notes',
      ],
    })
    await source.owner({
      args: [
        'task',
        'move',
        'travel',
        '--to-hydra',
        destination.id,
      ],
    })
    expect(await find({ hydra: source })).toEqual(expect.any(String))
    expect(await find({ hydra: destination })).toEqual([
      expect.objectContaining({
        card: created.card.id,
        title: 'Moved notes',
      }),
    ])
    await pnyx.restart()
    expect(await find({ hydra: destination })).toEqual([
      expect.objectContaining({
        card: created.card.id,
        title: 'Moved notes',
      }),
    ])
  },
)

test(
  'the Oracle refuses a Hydra that does not exist and makes no folder for it',
  async () => {
    const run = await operation({
      args: [
        'oracle',
        'invoice',
        '--hydra',
        'typo-oracle',
      ],
      env: process.env,
    })

    expect(run.status).not.toBe(0)
    expect(parsed(run)).toMatchObject({
      code: 'NOT_FOUND',
      error: 'unknown Hydra: typo-oracle',
    })
    expect(existsSync(join(
      process.env.PNYX_HOME!,
      'hydras',
      'typo-oracle',
    ))).toBe(false)
  },
)

test(
  'Oracle result metadata and family previews include a child’s live native work',
  async () => {
    const hydra = await pnyx.hydra()
    const parent = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Family preview',
        '--key',
        'preview-family',
      ],
    })
    const child = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Live child',
        '--parent',
        'preview-family',
      ],
    })
    const held = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes(`<pnyx-worker task="${child.card.id}"`),
      reply: 'Child turn complete',
      hold: true,
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        child.card.id,
        '--folder',
        hydra.folder({ name: 'preview-child' }),
      ],
    })
    await until({
      what: 'the child turn to start',
      check: async () => (await hydra.task({ key: child.card.id })).status === 'running',
    })
    const state = structuredClone(loadHydra({ hydraId: hydra.id }).state)
    const actions: Record<string, CurrentAction> = {}
    // Web modules are source-only; a runtime import keeps them out of the CLI's TypeScript emit graph.
    const resultsModule: string = '#web-oracle/results.ts'
    const previewModule: string = '#web-oracle/oracle-preview.tsx'
    const {
      resultMeta,
      oracleResults,
    } = await import(resultsModule)
    vi.stubGlobal(
      'CSS',
      { supports: () => false },
    )
    const { ResultPreview } = await import(previewModule)
    vi.unstubAllGlobals()
    const result = {
      kind: 'task',
      id: parent.card.id,
      card: state.cards[parent.card.id],
      title: 'Family preview',
      at: parent.card.updatedAt,
    }
    expect(resultMeta({
      result,
      state,
      actions,
      keys: () => '',
      now: Date.now(),
    })).toContain('Thinking')
    const markup = renderToStaticMarkup(createElement(
      ResultPreview,
      {
        result,
        state,
        cardActions: actions,
        terms: [],
        connected: true,
        settings: {},
        choose: () => {},
      },
    ))
    expect(markup).toContain('activity-working')
    expect(markup).toContain('Thinking')
    const nativeTools: Record<string, CurrentAction> = {
      [child.card.id]: {
        at: '2000-01-01T00:00:00.000Z',
        done: false,
        calls: [
          {
            id: 'current-native-tool',
            tool: 'Bash',
          },
        ],
        work: {
          runningTurns: ['current-turn'],
          runningTools: ['current-native-tool'],
          unsettledInputs: [],
          pendingControls: [],
          queue: {
            knowledge: 'known',
            count: 0,
          },
          background: {
            knowledge: 'known',
            tasks: [],
          },
        },
      },
    }
    expect(resultMeta({
      result,
      state,
      actions: nativeTools,
      keys: () => '',
      now: Date.now(),
    })).toContain('Working')
    const matches = ({
      text,
      actions,
    }: {
      text: string
      actions: Record<string, CurrentAction>
    }) => oracleResults({
      state,
      hits: [],
      projects: [],
      actions: [],
      cardActions: actions,
      hydra: {
        id: hydra.id,
        name: 'Status search',
      },
      text,
      badges: [],
      now: Date.now(),
    }).flatMap((group: { results: { id: string }[] }) => group.results.map(result => result.id))
    expect(matches({
      text: 'working',
      actions: nativeTools,
    })).toContain(`task:${child.card.id}`)
    expect(matches({
      text: 'thinking',
      actions: nativeTools,
    })).not.toContain(`task:${child.card.id}`)
    expect(matches({
      text: 'thinking',
      actions,
    })).toContain(`task:${child.card.id}`)
    expect(matches({
      text: 'working',
      actions,
    })).not.toContain(`task:${child.card.id}`)
    held.release()
  },
)

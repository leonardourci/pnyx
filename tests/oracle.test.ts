import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { parsed, pnyxAxi, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

interface Result {
  card: string
  title: string
  snippets: { snippet: string }[]
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
    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'status',
        'export',
        'working',
        '--note',
        'Found the cron drift in the scheduler',
      ],
    })

    expect((await search({
      hydra,
      args: ['cron drift'],
    }) as Result[]).map(result => result.title)).toEqual(['Invoice export nightly'])
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
          '--title',
          `Release checklist ${key}`,
          '--key',
          key,
        ],
      })
    }

    await hydra.owner({
      args: [
        'task',
        'status',
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
    page.close()

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
  'the Oracle refuses a Hydra that does not exist and makes no folder for it',
  async () => {
    const run = await pnyxAxi({
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

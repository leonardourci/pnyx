import { discoverPullRequests } from '#tasks/delivery/discover.ts'
import { symlinkSync as linkCopyFolder, unlinkSync as unlinkCopyFolder } from 'node:fs'
import { withWriter } from '#app/writer.ts'
import { base } from '#app/command-meta.ts'
import * as processes from '#app/run-process.ts'
import { workerLine } from './setup/worker-log.ts'
import { readEvents } from '#app/event-log.ts'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import { parsed, operation, startOthrys, until, type Othrys } from './setup/othrys.ts'

const PAGE_COMMAND = join(
  import.meta.dirname,
  'setup',
  'fixtures',
  'page-command.mjs',
)
import { git } from './setup/upgrade.ts'
import { legacyDuplicate } from './setup/legacy.ts'
import { createTaskBranch } from '#projects/git.ts'
import { createProject } from './setup/projects.ts'

let othrys: Othrys
const github = join(
  process.env.TMPDIR!,
  'github',
)

beforeAll(async () => {
  mkdirSync(
    join(
      github,
      'o',
      'shop',
    ),
    { recursive: true },
  )
  // Pull request state comes from this fake gh-axi, never GitHub.
  process.env.OTHRYS_FAKE_GITHUB = github
  process.env.OTHRYS_GH_AXI = join(
    import.meta.dirname,
    'setup',
    'fixtures',
    'gh-axi.mjs',
  )
  othrys = await startOthrys({ queueDelay: 100 })
})

const pullRequest = ({
  number,
  state,
}: {
  number: number
  state: 'open' | 'merged'
}) => writeFileSync(
  join(
    github,
    'o',
    'shop',
    `${number}.json`,
  ),
  JSON.stringify({
    state,
    title: 'Add the cart',
  }),
)

test(
  'Titans share the home copy pool and keep another Titan’s attached checkout reserved',
  async () => {
    const source = await othrys.titan()
    const target = await othrys.titan()
    const project = await createProject({
      titan: source,
      landing: 'branch',
      name: 'shared-copy-pool',
    })
    await target.owner({
      args: [
        'project',
        'add',
        project,
        '--landing',
        'branch',
      ],
    })

    const starts = []

    for (const titan of [
      source,
      target,
    ]) {
      const created = await titan.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          'Use the shared pool',
          '--project',
          project,
        ],
      })
      starts.push(await titan.owner({
        args: [
          'task',
          'start',
          created.card.id,
        ],
      }))
    }

    const first = starts[0]!.agent.folder as string
    const second = starts[1]!.agent.folder as string
    const pool = join(
      process.env.OTHRYS_HOME!,
      'copies',
    )
    expect(first.startsWith(`${pool}/`)).toBe(true)
    expect(second.startsWith(`${pool}/`)).toBe(true)
    expect(second).not.toBe(first)
    expect((await source.agent({ cwd: first })).closed).toBe(false)
    expect(git({
      cwd: first,
      args: [
        'branch',
        '--show-current',
      ],
    })).not.toBe(git({
      cwd: second,
      args: [
        'branch',
        '--show-current',
      ],
    }))

    await source.owner({
      args: [
        'task',
        'copy',
        starts[0]!.task,
        'remove',
        '--safe',
      ],
    })
    await source.owner({
      args: [
        'task',
        'detach',
        starts[0]!.task,
      ],
    })
    const firstTask = (await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'First concurrent checkout',
        '--project',
        project,
      ],
    })).card.id as string
    const secondTask = (await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Second concurrent checkout',
        '--project',
        project,
      ],
    })).card.id as string
    const bin = source.folder({ name: 'paused-git' })
    const entered = join(
      bin,
      'entered',
    )
    const release = join(
      bin,
      'release',
    )
    const previousPath = process.env.PATH
    const gitExecutable = spawnSync(
      'sh',
      [
        '-c',
        'command -v git',
      ],
      { encoding: 'utf8' },
    )
    expect(gitExecutable.status).toBe(0)
    writeFileSync(
      join(
        bin,
        'git',
      ),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync } = require('node:fs')
const args = process.argv.slice(2)
;(async () => {
  if (args[0] === '-C' && args[1] === ${JSON.stringify(first)} && args[2] === 'status' && args.includes('--untracked-files=normal') && !existsSync(${JSON.stringify(entered)})) {
    mkdirSync(${JSON.stringify(entered)})
    const end = Date.now() + 20000
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() > end) throw new Error('checkout gate was never released')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const result = spawnSync(${JSON.stringify(gitExecutable.stdout.trim())}, args)
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  process.exitCode = result.status ?? 1
})().catch(error => { console.error(error); process.exitCode = 1 })
`,
      { mode: 0o755 },
    )
    process.env.PATH = `${bin}:${previousPath}`
    const pending = source.owner({
      args: [
        'task',
        'start',
        firstTask,
      ],
    })

    try {
      await until({
        what: 'the first reservation pauses inside Git before its checkout changes',
        check: () => existsSync(entered),
      })
      expect((await source.ownerRefused({
        args: [
          'task',
          'move',
          firstTask,
          '--to-titan',
          target.id,
        ],
      })).code).toBe('CONFLICT')
      expect((await source.task({ key: firstTask })).id).toBe(firstTask)
      const competing = (await target.owner({
        args: [
          'task',
          'start',
          secondTask,
        ],
      })).agent.folder as string
      expect(competing).not.toBe(first)
      writeFileSync(
        join(
          competing,
          'competing-work.txt',
        ),
        'Keep the other worker’s saved work',
      )
      writeFileSync(
        release,
        '',
      )
      expect((await pending).agent.folder).toBe(first)
      expect(readFileSync(
        join(
          competing,
          'competing-work.txt',
        ),
        'utf8',
      )).toBe('Keep the other worker’s saved work')
      await source.owner({
        args: [
          'task',
          'move',
          firstTask,
          '--to-titan',
          target.id,
        ],
      })
      expect((await target.owner({
        args: [
          'task',
          'show',
          firstTask,
          '--full',
        ],
      })).task.agent.cwd).toBe(first)
      await target.owner({
        args: [
          'task',
          'copy',
          firstTask,
          'remove',
          '--safe',
        ],
      })
      await target.owner({
        args: [
          'task',
          'detach',
          firstTask,
        ],
      })
      const legacy = join(
        process.env.OTHRYS_HOME!,
        'titans',
        target.id,
        'copies',
        'retained-checkout',
      )
      mkdirSync(
        join(
          legacy,
          '..',
        ),
        { recursive: true },
      )
      git({
        cwd: project,
        args: [
          'worktree',
          'move',
          first,
          legacy,
        ],
      })
      const recordedPath = `${legacy}-recorded`
      linkCopyFolder(
        legacy,
        recordedPath,
        'dir',
      )
      await withWriter({
        titanId: target.id,
        fn: ({ writer }) => {
          const card = writer.state.cards[firstTask]!
          writer.append({
            event: {
              ...base({
                state: writer.state,
                cardId: firstTask,
                meta: {
                  actor: 'fixture',
                  at: new Date().toISOString(),
                },
              }),
              type: 'task.copy',
              data: {
                before: card.copy!,
                after: {
                  ...card.copy!,
                  path: recordedPath,
                },
              },
            },
          })
        },
      })
      expect((await target.ownerRefused({
        args: [
          'task',
          'start',
          firstTask,
        ],
      })).code).toBe('COPY_FAILED')
      unlinkCopyFolder(recordedPath)
      git({
        cwd: project,
        args: [
          'worktree',
          'move',
          legacy,
          recordedPath,
        ],
      })
      expect((await target.owner({
        args: [
          'task',
          'start',
          firstTask,
        ],
      })).agent.folder).toBe(recordedPath)
    } finally {
      writeFileSync(
        release,
        '',
      )
      await Promise.allSettled([pending])
      process.env.PATH = previousPath
    }
  },
)

test(
  'a create behind a worker on the same project queues it, a start that fails leaves it queued, a start takes it out of the queue for a worker of its own, once detached it is not shown as never started, and a replayed create or queue keeps its answer after the worker leaves',
  async () => {
    const titan = await othrys.titan()
    await createProject({
      titan,
      landing: 'branch',
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Lead',
        '--key',
        'lead',
        '--project',
        'shop',
      ],
    })
    const lead = await titan.owner({
      args: [
        'task',
        'start',
        'lead',
      ],
    })
    await titan.agent({ cwd: lead.agent.folder })
    expect(await titan.owner({
      args: [
        'task',
        'create',
        '--title',
        'Follow',
        '--key',
        'follow',
        '--project',
        'shop',
        '--brief',
        'Follow the lead',
        '--behind',
        'lead',
      ],
    })).toMatchObject({ launch: 'queued' })

    const failedStarts = {
      NOT_FOUND: [
        '--rule',
        'no-such-rule',
      ],
    }

    for (const [
      code,
      flags,
    ] of Object.entries(failedStarts)) {
      expect(
        (await titan.ownerRefused({
          args: [
            'task',
            'start',
            'follow',
            ...flags,
          ],
        })).code,
        flags.join(' '),
      ).toBe(code)
    }

    expect((await titan.task({ key: 'follow' })).queue).toBeDefined()

    const started = await titan.owner({
      args: [
        'task',
        'start',
        'follow',
      ],
    })
    expect(started.unqueued).toContain('was queued behind worker')
    expect((await titan.task({ key: 'follow' })).queue).toBeUndefined()
    expect(started.agent.folder).not.toBe(lead.agent.folder)
    expect((await titan.agent({ cwd: started.agent.folder })).received[0]).toContain('Follow the lead')

    await titan.owner({
      args: [
        'task',
        'detach',
        'follow',
      ],
    })
    expect((await titan.task({ key: 'follow' })).worker).toBe('none')

    const second = [
      'task',
      'create',
      '--title',
      'Follow again',
      '--project',
      'shop',
      '--behind',
      'lead',
      '--event-id',
      'follow-again',
    ]
    expect(await titan.owner({ args: second })).toMatchObject({ launch: 'queued' })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Wait for the lead',
        '--key',
        'wait',
        '--project',
        'shop',
      ],
    })
    const queueWait = [
      'task',
      'queue',
      'wait',
      '--behind',
      'lead',
      '--event-id',
      'queue-wait',
    ]
    await titan.owner({
      args: [
        'task',
        'hide',
        'wait',
      ],
    })
    const hiddenQueue = await titan.owner({
      args: [
        'task',
        'queue',
        'wait',
        '--behind',
        'lead',
      ],
    })
    expect(hiddenQueue.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('hidden task') }))
    expect((await titan.task({ key: 'wait' })).queue).toBeDefined()
    await titan.owner({
      args: [
        'task',
        'unqueue',
        'wait',
      ],
    })
    await titan.owner({ args: queueWait })
    expect((await titan.task({ key: 'wait' })).queue).toBeDefined()
    await titan.owner({
      args: [
        'task',
        'detach',
        'lead',
      ],
    })
    const sessions = othrys.claude.sessions.length
    expect(await titan.owner({ args: second })).toMatchObject({ launch: 'queued' })
    expect(othrys.claude.sessions).toHaveLength(sessions)
    const replayedQueue = await titan.owner({ args: queueWait })
    expect(replayedQueue.queued).toBeUndefined()
    expect(replayedQueue.duplicate).toBeDefined()
  },
)

test(
  'a merged pull request is information only: the task keeps its badge and stays open until Titan marks it done',
  async () => {
    const titan = await othrys.titan()
    await createProject({
      titan,
      landing: 'pr',
      remote: 'https://github.com/o/shop.git',
    })
    await titan.chat({ text: 'Watch the shop' })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Write the cart notes',
        '--key',
        'notes',
        '--project',
        'shop',
      ],
    })
    pullRequest({
      number: 8,
      state: 'open',
    })
    await titan.owner({
      args: [
        'link',
        'notes',
        '--url',
        'https://github.com/o/shop/pull/8',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Add the cart',
        '--key',
        'cart',
        '--project',
        'shop',
      ],
    })
    pullRequest({
      number: 7,
      state: 'open',
    })
    await titan.owner({
      args: [
        'link',
        'cart',
        '--url',
        'https://github.com/o/shop/pull/7',
      ],
    })
    const checkedCart = await until({
      what: 'the card to read the open pull request',
      check: async () => {
        const { task } = await titan.owner({
          args: [
            'task',
            'show',
            'cart',
            '--full',
          ],
        })

        return task.links[0]?.checkedAt && task
      },
    })
    expect(checkedCart.links[0].state).toBe('open')
    expect(checkedCart.doneAt).toBeUndefined()

    pullRequest({
      number: 8,
      state: 'merged',
    })
    await until({
      what: 'the notes pull request to be recorded merged',
      check: async () => (await titan.owner({
        args: [
          'task',
          'show',
          'notes',
          '--full',
        ],
      })).task.links[0]?.state === 'merged',
    })
    pullRequest({
      number: 7,
      state: 'merged',
    })
    const merged = await until({
      what: 'the cart pull request to be recorded merged',
      check: async () => {
        const { task } = await titan.owner({
          args: [
            'task',
            'show',
            'cart',
            '--full',
          ],
        })

        return task.links[0]?.state === 'merged' && task
      },
    })
    expect(merged.doneAt).toBeUndefined()
    expect((await titan.task({ key: 'cart' })).status).toBe('not started, no reason given')
    expect((await titan.task({ key: 'notes' })).status).toBe('not started, no reason given')
    expect(merges({ number: 7 })).toBe(0)

    await titan.owner({
      args: [
        'outcome',
        'cart',
        'done',
        '--actor',
        'titan',
      ],
    })
    expect((await titan.task({ key: 'cart' })).status).toBe('done')
  },
)

const merges = ({ number }: { number: number }) => readFileSync(
  join(
    github,
    'calls.jsonl',
  ),
  'utf8',
).split('\n')
  .filter(line => line.includes('PUT') && line.includes(`/pulls/${number}/merge`)).length

test(
  'Titan submits a merge despite owner defaults, Hold and red checks, shows the facts, and submits once after restart',
  async () => {
    const titan = await othrys.titan()
    await createProject({
      titan,
      landing: 'pr',
      remote: 'https://github.com/o/shop.git',
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Add the cart',
        '--key',
        'gate',
        '--project',
        'shop',
      ],
    })
    const url = 'https://github.com/o/shop/pull/21'
    const publish = ({
      checks,
      mergeBehavior,
    }: {
      checks: string
      mergeBehavior?: string
    }) => writeFileSync(
      join(
        github,
        'o',
        'shop',
        '21.json',
      ),
      JSON.stringify({
        state: 'open',
        title: 'Add the cart',
        head: 'c'.repeat(40),
        checks,
        mergeBehavior,
      }),
    )
    publish({
      checks: '0 passed, 1 failed, 1 total',
      mergeBehavior: 'queued',
    })
    await titan.owner({
      args: [
        'link',
        'gate',
        '--url',
        url,
      ],
    })
    const ask = await until({
      what: 'the merge question',
      check: async () => (await titan.owner({
        args: [
          'task',
          'show',
          'gate',
          '--full',
        ],
      })).task.asks?.find((candidate: { kind: string }) => candidate.kind === 'merge'),
    })
    await workerLine({
      titan,
      key: 'gate',
      line: 'done: Implementation ready for review',
    })
    const reviewedTask = await until({
      what: 'the done report to appear on the task',
      check: async () => {
        const { task } = await titan.owner({
          args: [
            'task',
            'show',
            'gate',
            '--full',
          ],
        })

        return task.workerLog?.status?.code === 'done' && task
      },
    })
    const questionAfterReport = reviewedTask.asks?.find(
      (candidate: { id: string }) => candidate.id === ask.id,
    )
    expect(questionAfterReport).toBeDefined()
    expect(questionAfterReport?.closed).toBeUndefined()
    const session = await titan.chat({ text: 'Review the open pull requests.' })
    const asTitan = titan.as({ session })
    const merge = [
      'task',
      'merge',
      'gate',
      '--url',
      url,
    ]

    await titan.owner({
      args: [
        'task',
        'answer',
        'gate',
        ask.id,
        '--choice',
        'Hold',
      ],
    })
    publish({
      checks: '0 passed, 1 failed, 1 total',
      mergeBehavior: 'rejected',
    })
    expect((await asTitan.refused({
      args: [
        ...merge,
        '--event-id',
        'rejected-merge',
      ],
    })).code).toBe('MERGE_FAILED')
    const rejected = await titan.owner({
      args: [
        'task',
        'show',
        'gate',
        '--full',
      ],
    })
    const rejectedLink = rejected.task.links.find((entry: { url: string }) => entry.url === url)
    expect(rejectedLink.mergeAttempt ?? null).toBeNull()
    publish({
      checks: '0 passed, 1 failed, 1 total',
      mergeBehavior: 'queued',
    })
    const submitted = await asTitan.run({
      args: [
        ...merge,
        '--event-id',
        'corrected-merge',
      ],
    })
    const notices = submitted.notices.map((notice: { reason: string }) => notice.reason).join('\n')
    expect(notices).toContain('owner')
    expect(notices).toContain('red')
    expect([
      'queued',
      'unknown',
    ]).toContain(submitted.merge)
    expect(merges({ number: 21 })).toBe(2)

    await othrys.restart()
    await asTitan.run({ args: merge })
    expect(merges({ number: 21 })).toBe(2)
  },
)

test(
  'Titan submits private-repository merges with unreadable or failing evidence and records each gap',
  async () => {
    const repo = 'private'
    const rulesError = 'error: "Insufficient permissions for this action"\ncode: FORBIDDEN'
    const titan = await othrys.titan()
    const folder = join(
      github,
      'o',
      repo,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    await createProject({
      titan,
      landing: 'pr',
      remote: `https://github.com/o/${repo}.git`,
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Fix private merge',
        '--key',
        'private',
        '--project',
        'shop',
      ],
    })
    const head = 'd'.repeat(40)
    const url = `https://github.com/o/${repo}/pull/22`
    writeFileSync(
      join(
        folder,
        '22.json',
      ),
      JSON.stringify({
        state: 'open',
        head,
        checks: '1 passed, 0 failed, 1 total',
      }),
    )
    const evidenceFile = join(
      folder,
      'evidence.json',
    )
    const classicRule = {
      requiresStatusChecks: true,
      requiredStatusChecks: [
        {
          context: 'ci',
          app: { databaseId: 42 },
        },
      ],
    }
    const run = {
      name: 'ci',
      head_sha: head,
      app: { id: 42 },
      status: 'completed',
      conclusion: 'success',
    }
    const publish = ({
      error = rulesError,
      check = run,
      classic = classicRule,
      rules = [],
    }: {
      error?: string
      check?: typeof run
      classic?: unknown
      rules?: unknown
    } = {}) => writeFileSync(
      evidenceFile,
      JSON.stringify({
        rulesError: error,
        classicRule: classic,
        checkRuns: [check],
        rules,
      }),
    )
    publish()
    await titan.owner({
      args: [
        'link',
        'private',
        '--url',
        url,
      ],
    })
    const session = await titan.chat({ text: 'Review the private repository pull request.' })
    const asTitan = titan.as({ session })
    const merge = [
      'task',
      'merge',
      'private',
      '--url',
      url,
    ]
    const cases = [
      {
        evidence: {
          classic: null,
          check: {
            ...run,
            conclusion: 'failure',
          },
        },
        reason: 'check is not green',
      },
      {
        evidence: {
          error: 'error: HTTP 404: Not Found',
          classic: {},
        },
        reason: 'classic protection unreadable',
      },
      {
        evidence: {
          error: 'error: HTTP 403: Forbidden',
          classic: {},
        },
        reason: 'classic protection unreadable',
      },
      {
        evidence: {
          error: 'error: "Resource not found"\ncode: NOT_FOUND',
          classic: {},
        },
        reason: 'classic protection unreadable',
      },
      {
        evidence: {
          check: {
            ...run,
            status: 'in_progress',
            conclusion: '',
          },
        },
        reason: 'check still running',
      },
      {
        evidence: {
          check: {
            ...run,
            app: { id: 43 },
          },
        },
        reason: 'missing required check',
      },
      {
        evidence: { error: 'error: HTTP 500: server error' },
        reason: 'branch rules unreadable',
      },
      {
        evidence: {
          error: '',
          rules: {},
        },
        reason: 'branch rules unreadable',
      },
      {
        evidence: { classic: {} },
        reason: 'classic protection unreadable',
      },
    ]

    for (const sample of cases) {
      writeFileSync(
        join(
          folder,
          '22.json',
        ),
        JSON.stringify({
          state: 'open',
          head,
          checks: '1 passed, 0 failed, 1 total',
          mergeBehavior: 'queued',
        }),
      )
      publish(sample.evidence)
      await titan.owner({
        args: [
          'link',
          'private',
          '--url',
          url,
          '--remove',
        ],
      })
      await titan.owner({
        args: [
          'link',
          'private',
          '--url',
          url,
        ],
      })
      const submittedBefore = merges({ number: 22 })
      const result = await asTitan.run({ args: merge })
      expect(result.merge).toBe('queued')
      expect(merges({ number: 22 }) - submittedBefore).toBe(1)
      const reason = expect.stringContaining(sample.reason)
      const expectedNotice = expect.objectContaining({ reason })
      expect(result.notices).toEqual(expect.arrayContaining([expectedNotice]))
      expect((await titan.task({ key: 'private' })).notices).toBeDefined()
    }

    writeFileSync(
      join(
        folder,
        '22.json',
      ),
      JSON.stringify({
        state: 'open',
        head,
        checks: '1 passed, 0 failed, 1 total',
      }),
    )
    publish({ classic: null })
    await titan.owner({
      args: [
        'link',
        'private',
        '--url',
        url,
        '--remove',
      ],
    })
    await titan.owner({
      args: [
        'link',
        'private',
        '--url',
        url,
      ],
    })
    const result = await asTitan.run({ args: merge })
    expect(result.merge).toBe('merged')
    expect(result.head).toBe(head)
    const calls = readFileSync(
      join(
        github,
        'calls.jsonl',
      ),
      'utf8',
    ).trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    const submissions = calls.filter(args => args.includes('PUT') && args.includes(`/repos/o/${repo}/pulls/22/merge`))
    expect(submissions).toHaveLength(10)
    expect(submissions[0]).toContain(`sha=${head}`)
  },
)

const gitSucceeded = ({
  cwd,
  args,
  env = {},
}: {
  cwd: string
  args: string[]
  env?: NodeJS.ProcessEnv
}) => spawnSync(
  'git',
  [
    '-C',
    cwd,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    ...args,
  ],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  },
).status === 0

const upstreamOf = ({
  cwd,
  branch,
}: {
  cwd: string
  branch: string
}) => git({
  cwd,
  args: [
    'for-each-ref',
    '--format=%(upstream)',
    `refs/heads/${branch}`,
  ],
})

test(
  'task branches never track the default branch, so a plain push from a task copy never lands on main',
  async () => {
    const titan = await othrys.titan()
    const project = await createProject({
      titan,
      landing: 'pr',
    })
    const origin = `${project}.git`
    git({
      cwd: project,
      args: [
        'config',
        'push.default',
        'upstream',
      ],
    })
    writeFileSync(
      join(
        project,
        '.git',
        'info',
        'exclude',
      ),
      'pool-proof\n',
    )
    const mainOf = () => git({
      cwd: origin,
      args: [
        'rev-parse',
        'refs/heads/main',
      ],
    })
    const main = mainOf()

    const start = async ({
      key,
      harness = 'claude',
    }: {
      key: string
      harness?: 'claude' | 'codex'
    }) => {
      await titan.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          key,
          '--key',
          key,
          '--project',
          'shop',
          '--ask',
          'Work',
        ],
      })
      const started = await titan.owner({
        args: [
          'task',
          'start',
          key,
          '--harness',
          harness,
        ],
      })
      const path = started.agent.folder as string

      return {
        path,
        branch: git({
          cwd: path,
          args: [
            'branch',
            '--show-current',
          ],
        }),
      }
    }

    const first = await start({ key: 'first' })
    writeFileSync(
      join(
        first.path,
        'pool-proof',
      ),
      'keep this ignored file\n',
    )
    expect(upstreamOf({
      cwd: first.path,
      branch: first.branch,
    })).toBe('')
    writeFileSync(
      join(
        first.path,
        'work.txt',
      ),
      'synthetic work\n',
    )
    git({
      cwd: first.path,
      args: [
        'add',
        'work.txt',
      ],
    })
    git({
      cwd: first.path,
      args: [
        'commit',
        '-qm',
        'work',
      ],
    })
    expect(gitSucceeded({
      cwd: first.path,
      args: ['push'],
    })).toBe(false)
    expect(mainOf()).toBe(main)
    git({
      cwd: first.path,
      args: [
        'push',
        '-q',
        '-u',
        'origin',
        `HEAD:refs/heads/${first.branch}`,
      ],
    })
    expect(git({
      cwd: origin,
      args: [
        'rev-parse',
        `refs/heads/${first.branch}`,
      ],
    })).toBe(git({
      cwd: first.path,
      args: [
        'rev-parse',
        'HEAD',
      ],
    }))
    expect(mainOf()).toBe(main)
    expect(upstreamOf({
      cwd: first.path,
      branch: first.branch,
    })).toBe(`refs/remotes/origin/${first.branch}`)

    const worker = await titan.agent({ cwd: first.path })
    expect(worker.env.GIT_CONFIG_COUNT).toBe('1')

    for (const args of [
      [
        'switch',
        '--quiet',
        '-c',
        'fix/own',
        'origin/main',
      ],
      [
        'checkout',
        '--quiet',
        '-B',
        'fix/rebuilt',
        'origin/main',
      ],
    ]) {
      expect(gitSucceeded({
        cwd: first.path,
        args,
        env: worker.env,
      })).toBe(true)
      expect(upstreamOf({
        cwd: first.path,
        branch: args.at(-2)!,
      })).toBe('')
    }

    expect(gitSucceeded({
      cwd: first.path,
      args: ['push'],
      env: worker.env,
    })).toBe(false)
    expect(mainOf()).toBe(main)
    git({
      cwd: first.path,
      args: [
        'switch',
        '--quiet',
        first.branch,
      ],
    })

    const codexed = await start({
      key: 'codexed',
      harness: 'codex',
    })
    expect((await titan.agent({ cwd: codexed.path })).config).toMatchObject({
      'shell_environment_policy.set.GIT_CONFIG_COUNT': '1',
      'shell_environment_policy.set.GIT_CONFIG_KEY_0': 'branch.autoSetupMerge',
    })

    git({
      cwd: first.path,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        first.branch,
      ],
    })

    for (const branch of [
      'othrys/other-task-1',
      'fix/feature-work',
    ]) {
      git({
        cwd: project,
        args: [
          'branch',
          '--track',
          branch,
          'origin/main',
        ],
      })
    }

    await start({ key: 'second' })
    expect(upstreamOf({
      cwd: first.path,
      branch: first.branch,
    })).toBe('')
    expect(upstreamOf({
      cwd: project,
      branch: 'othrys/other-task-1',
    })).toBe('')
    expect(upstreamOf({
      cwd: project,
      branch: 'fix/feature-work',
    })).toBe('refs/remotes/origin/main')
    git({
      cwd: first.path,
      args: [
        'branch',
        `--set-upstream-to=origin/${first.branch}`,
        first.branch,
      ],
    })
    await start({ key: 'third' })
    expect(upstreamOf({
      cwd: first.path,
      branch: first.branch,
    })).toBe(`refs/remotes/origin/${first.branch}`)

    git({
      cwd: project,
      args: [
        'branch',
        'othrys/custom-refspec-1',
        'origin/main',
      ],
    })
    git({
      cwd: project,
      args: [
        'config',
        'branch.othrys/custom-refspec-1.remote',
        'origin',
      ],
    })
    git({
      cwd: project,
      args: [
        'config',
        'branch.othrys/custom-refspec-1.merge',
        'refs/heads/main',
      ],
    })
    git({
      cwd: project,
      args: [
        'config',
        'remote.origin.fetch',
        '+refs/heads/othrys/*:refs/remotes/origin/othrys/*',
      ],
    })
    expect(upstreamOf({
      cwd: project,
      branch: 'othrys/custom-refspec-1',
    })).toBe('')
    await start({ key: 'fourth' })
    expect(gitSucceeded({
      cwd: project,
      args: [
        'config',
        'branch.othrys/custom-refspec-1.merge',
      ],
    })).toBe(false)
    git({
      cwd: project,
      args: [
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ],
    })

    const gone = await start({ key: 'gone' })
    await titan.owner({
      args: [
        'task',
        'detach',
        'gone',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'rename',
        'gone',
        '--title',
        'Renamed after allocation',
      ],
    })
    git({
      cwd: project,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        gone.branch,
      ],
    })
    writeFileSync(
      join(
        gone.path,
        'uncommitted.txt',
      ),
      'scratch work',
    )
    const flagged = await titan.owner({
      args: [
        'task',
        'copy',
        'gone',
        'remove',
      ],
    })
    expect(flagged.copy.state).toBe('flagged')
    rmSync(
      gone.path,
      {
        recursive: true,
        force: true,
      },
    )
    const again = await titan.owner({
      args: [
        'task',
        'start',
        'gone',
      ],
    })
    expect(existsSync(again.agent.folder)).toBe(true)
    expect(git({
      cwd: again.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe(gone.branch)
    expect(upstreamOf({
      cwd: project,
      branch: gone.branch,
    })).toBe('')

    git({
      cwd: first.path,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD:refs/heads/main',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'copy',
        'first',
        'remove',
        '--safe',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'detach',
        'first',
      ],
    })
    const pooled = await start({ key: 'pooled' })
    expect(pooled.path).toBe(first.path)
    expect(existsSync(join(
      pooled.path,
      'pool-proof',
    ))).toBe(true)
    expect(upstreamOf({
      cwd: pooled.path,
      branch: pooled.branch,
    })).toBe('')
  },
)

test(
  'attaching a repository to another Titan succeeds with its existing owner visible and keeps existing work',
  async () => {
    const owner = await othrys.titan()
    const other = await othrys.titan()
    const path = owner.folder({ name: 'owned-project' })
    await owner.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const task = await owner.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Keep this work',
        '--project',
        path,
      ],
    })
    const attached = await other.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const expectedOwner = expect.objectContaining({ reason: expect.stringContaining(owner.id) })
    expect(attached.notices).toEqual(expect.arrayContaining([expectedOwner]))
    expect((await owner.task({ key: task.card.id })).title).toBe('Keep this work')
    expect((await other.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path,
        state: 'attached',
      }),
    ]))
  },
)

test(
  'a keeper choice moves open work atomically, reports its defaults and preserves dependencies within the moved group',
  async () => {
    const owner = await othrys.titan()
    const path = owner.folder({ name: 'legacy-shared' })
    await owner.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const id = 'legacy-project-owner'
    await withWriter({
      titanId: id,
      create: true,
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: 1,
            id: 'legacy-project',
            at: '2026-10-21T10:01:00Z',
            actor: 'cli',
            cardId: '$projects',
            type: 'titan.project',
            data: {
              before: null,
              after: {
                path,
                name: 'legacy-shared',
                detached: false,
              },
              sharedWith: [],
            },
          },
        })
      },
    })
    const legacy = await othrys.titan({
      id,
      create: false,
    })
    const task = await legacy.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Legacy work',
        '--project',
        path,
      ],
    })
    expect((await legacy.task({ key: task.card.id })).project).toBe('legacy-shared')
    await legacy.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const setupRun = await operation({
      env: process.env,
      args: [
        'setup',
        'check',
        '--titan',
        legacy.id,
      ],
    })
    expect(setupRun.status).toBe(1)
    const setup = parsed(setupRun)
    expect(setup.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: `project-owner:${path}`,
        missing: expect.stringContaining(owner.id),
        by: 'owner',
      }),
    ]))
    expect(setup.missing.find((item: { name: string }) => item.name === `project-owner:${path}`).missing).toContain(legacy.id)
    expect((await owner.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path,
        state: 'attached',
      }),
    ]))
    const dependent = await legacy.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Dependent work',
        '--project',
        path,
      ],
    })
    const free = await legacy.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Independent work',
        '--project',
        path,
      ],
    })
    await legacy.owner({
      args: [
        'task',
        'depend',
        dependent.card.id,
        '--on',
        task.card.id,
      ],
    })
    expect((await legacy.task({ key: free.card.id })).title).toBe('Independent work')
    expect((await legacy.task({ key: task.card.id })).title).toBe('Legacy work')
    expect((await legacy.task({ key: dependent.card.id })).title).toBe('Dependent work')
    expect((await owner.ownerRefused({
      args: [
        'task',
        'show',
        free.card.id,
      ],
    })).code).toBe('NOT_FOUND')
    const extra = legacy.folder({ name: 'legacy-extra' })
    await legacy.owner({
      args: [
        'project',
        'add',
        extra,
      ],
    })
    expect((await owner.ownerRefused({
      args: [
        'project',
        'keep',
        path,
        '--if-revision',
        '0',
      ],
    })).code).toBe('REVISION_CONFLICT')
    const kept = await owner.owner({
      args: [
        'project',
        'keep',
        path,
        '--if-revision',
        '1',
      ],
    })
    expect(kept.moved).toEqual(expect.arrayContaining([
      task.card.id,
      dependent.card.id,
      free.card.id,
    ]))
    expect((await owner.task({ key: task.card.id })).title).toBe('Legacy work')
    expect((await owner.task({ key: dependent.card.id })).title).toBe('Dependent work')
    const prerequisites = (await owner.task({ key: dependent.card.id })).prerequisites
    expect(prerequisites).toContainEqual(expect.objectContaining({ id: task.card.id }))
    expect(kept.notices).toBeDefined()
    expect((await owner.task({ key: free.card.id })).title).toBe('Independent work')
    expect(readEvents({
      titanId: owner.id,
      cardId: task.card.id,
      types: ['task.moved-in'],
    }))
      .toContainEqual(expect.objectContaining({
        data: expect.objectContaining({ from: legacy.id }),
      }))
    expect((await legacy.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toEqual([
      expect.objectContaining({
        path: extra,
        state: 'attached',
      }),
      expect.objectContaining({
        path,
        state: 'detached',
      }),
    ])
    expect((await owner.owner({
      args: [
        'project',
        'keep',
        path,
      ],
    })).moved).toEqual([])
    const departure = readEvents({
      titanId: legacy.id,
      cardId: task.card.id,
    })
    expect(departure.filter(event => event.type === 'task.moved-out')).toHaveLength(1)
    expect(readEvents({
      titanId: owner.id,
      cardId: task.card.id,
    }))
      .toContainEqual(expect.objectContaining({ type: 'task.created' }))
    const changed = await owner.owner({
      args: [
        'task',
        'rename',
        task.card.id,
        '--title',
        'Work after the move',
      ],
    })
    await othrys.restart()
    expect((await owner.task({ key: task.card.id })).title).toBe('Work after the move')
    const sourceHistory = readEvents({
      titanId: legacy.id,
      cardId: task.card.id,
    })
    expect(sourceHistory.map(event => event.id)).toEqual(departure.map(event => event.id))
    expect(sourceHistory).not.toContainEqual(expect.objectContaining({ id: changed.event.id }))
    expect(readEvents({
      titanId: owner.id,
      cardId: task.card.id,
    }))
      .toContainEqual(expect.objectContaining({ id: changed.event.id }))
  },
)

test(
  'parent-folder attachment preserves rules, guards one revision and retries once',
  async () => {
    const titan = await othrys.titan()
    const parent = titan.folder({ name: 'repositories' })
    const first = join(
      parent,
      'atlas',
    )
    const second = join(
      parent,
      'boreal',
    )
    mkdirSync(
      join(
        first,
        '.git',
      ),
      { recursive: true },
    )
    mkdirSync(
      join(
        second,
        '.git',
      ),
      { recursive: true },
    )
    const args = [
      'project',
      'add',
      parent,
      '--landing',
      'branch',
      '--merge',
      'titan',
      '--if-revision',
      '0',
      '--event-id',
      'constructor',
    ]
    await titan.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { chatCollapsed: true } }),
        '--event-id',
        'constructor:0',
      ],
    })
    await titan.owner({ args })
    expect((await titan.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toEqual([
      expect.objectContaining({
        path: first,
        landing: 'branch',
        merge: 'titan',
      }),
      expect.objectContaining({
        path: second,
        landing: 'branch',
        merge: 'titan',
      }),
    ])
    const noOpArgs = [
      ...args.slice(
        0,
        -4,
      ),
      '--if-revision',
      String((await titan.owner({
        args: [
          'project',
          'list',
        ],
      })).revision),
      '--event-id',
      '__proto__',
    ]
    await titan.owner({ args: noOpArgs })
    await othrys.restart()
    const third = join(
      parent,
      'cedar',
    )
    mkdirSync(
      join(
        third,
        '.git',
      ),
      { recursive: true },
    )
    await titan.owner({ args: noOpArgs })
    await titan.owner({ args })
    expect((await titan.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toHaveLength(2)
    expect((await titan.ownerRefused({
      args: [
        'project',
        'add',
        parent,
        '--if-revision',
        '0',
      ],
    })).code).toBe('REVISION_CONFLICT')
  },
)

test(
  'readable branch names strip accents and punctuation, shorten at words, and avoid local and remote collisions',
  async () => {
    const titan = await othrys.titan()
    const cwd = await createProject({
      titan,
      landing: 'branch',
    })
    const titleTitan = await othrys.titan()
    const titleProject = await createProject({
      titan: titleTitan,
      landing: 'branch',
    })
    await titleTitan.owner({
      args: [
        'titan',
        'set',
        '--name',
        'Poséidon!',
      ],
    })

    const start = async ({
      title,
      key,
    }: {
      title: string
      key: string
    }) => {
      await titleTitan.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          title,
          '--key',
          key,
          '--project',
          'shop',
        ],
      })
      const started = await titleTitan.owner({
        args: [
          'task',
          'start',
          key,
        ],
      })

      const { id } = await titleTitan.task({ key })

      if (typeof id !== 'string') {
        throw new Error('Expected the created task ID')
      }

      return {
        id,
        branch: git({
          cwd: started.agent.folder,
          args: [
            'branch',
            '--show-current',
          ],
        }),
      }
    }

    expect((await start({
      title: 'Clientes atendídos / ven\u1ab0das: chart!',
      key: 'accents',
    })).branch).toBe('poseidon/clientes-atendidos-vendas-chart')
    expect((await start({
      title: 'The chart of the vendas and clientes atendidos across projects',
      key: 'filler',
    })).branch).toBe('poseidon/chart-vendas-clientes-atendidos-across')
    const punctuation = await start({
      title: '!!!',
      key: 'punctuation',
    })
    expect(punctuation.branch).toBe(`poseidon/${punctuation.id.replace(
      /^task-/,
      '',
    ).slice(
      0,
      8,
    )}`)
    git({
      cwd: titleProject,
      args: [
        'commit',
        '--allow-empty',
        '-m',
        'Local project commit',
      ],
    })
    git({
      cwd: titleProject,
      args: [
        'branch',
        'origin/main',
      ],
    })
    git({
      cwd: titleProject,
      args: [
        'branch',
        'Poseidon/Chart',
      ],
    })
    git({
      cwd: titleProject,
      args: [
        'push',
        'origin',
        'HEAD:refs/heads/poseidon/chart-2',
      ],
    })
    expect((await start({
      title: 'Chart',
      key: 'head-chart',
    })).branch).toBe('poseidon/chart-3')
    expect(git({
      cwd: titleProject,
      args: [
        'log',
        '-1',
        '--format=%s',
        'refs/heads/poseidon/chart-3',
      ],
    })).toBe('init')
    await titleTitan.owner({
      args: [
        'titan',
        'set',
        '--name',
        'HEAD',
      ],
    })
    expect((await start({
      title: 'Symref',
      key: 'symref',
    })).branch).toBe('head-2/symref')
    let active = true
    expect(await createTaskBranch({
      cwd,
      titanName: 'Iris',
      task: 'task-cancelled',
      title: 'Cancelled',
      start: 'HEAD',
      active: () => active,
      prepare: async () => {
        active = false

        return true
      },
    })).toBeUndefined()
    expect(git({
      cwd,
      args: [
        'branch',
        '--list',
        'iris/cancelled',
      ],
    })).toBe('')
    const simultaneous = await Promise.all([
      createTaskBranch({
        cwd,
        titanName: 'Iris',
        task: 'task-one',
        title: 'Chart',
        start: 'HEAD',
      }),
      createTaskBranch({
        cwd,
        titanName: 'Iris',
        task: 'task-two',
        title: 'Chart',
        start: 'HEAD',
      }),
    ])
    expect(simultaneous.sort()).toEqual([
      'iris/chart',
      'iris/chart-2',
    ])
    git({
      cwd,
      args: [
        'branch',
        'poseidon',
      ],
    })
    git({
      cwd,
      args: [
        'push',
        'origin',
        'HEAD:refs/heads/poseidon-2/chart/details',
      ],
    })
    await titan.owner({
      args: [
        'titan',
        'set',
        '--name',
        'Poséidon',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Chart',
        '--key',
        'chart',
        '--project',
        'shop',
      ],
    })
    git({
      cwd,
      args: [
        'remote',
        'add',
        'unavailable',
        join(
          cwd,
          'missing-remote.git',
        ),
      ],
    })
    expect(await titan.ownerRefused({
      args: [
        'task',
        'start',
        'chart',
      ],
    })).toMatchObject({
      code: 'COPY_FAILED',
      error: expect.stringContaining('remote unavailable'),
    })
    expect(git({
      cwd,
      args: [
        'branch',
        '--list',
        'poseidon-2/chart-2',
      ],
    })).toBe('')
    git({
      cwd,
      args: [
        'remote',
        'remove',
        'unavailable',
      ],
    })
    const started = await titan.owner({
      args: [
        'task',
        'start',
        'chart',
      ],
    })
    expect(git({
      cwd: started.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/chart-2')
    git({
      cwd,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        'poseidon-2/chart-2',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'detach',
        'chart',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'copy',
        'chart',
        'remove',
        '--safe',
      ],
    })
    const failingHooks = join(
      cwd,
      'failing-hooks',
    )
    mkdirSync(failingHooks)
    writeFileSync(
      join(
        failingHooks,
        'post-checkout',
      ),
      '#!/bin/sh\necho "fixture copy hook failure" >&2\nexit 1\n',
      { mode: 0o700 },
    )
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Retry allocation',
        '--key',
        'retry',
        '--project',
        'shop',
      ],
    })
    git({
      cwd,
      args: [
        'config',
        'core.hooksPath',
        failingHooks,
      ],
    })
    const keptHead = git({
      cwd,
      args: [
        'rev-parse',
        'refs/heads/poseidon-2/chart-2',
      ],
    })
    expect(await titan.ownerRefused({
      args: [
        'task',
        'start',
        'retry',
      ],
    })).toMatchObject({
      code: 'COPY_FAILED',
      error: expect.stringContaining('fixture copy hook failure'),
    })
    expect(git({
      cwd,
      args: [
        'rev-parse',
        'refs/heads/poseidon-2/chart-2',
      ],
    })).toBe(keptHead)
    expect(git({
      cwd,
      args: [
        'branch',
        '--format=%(upstream:short)',
        '--list',
        'poseidon-2/chart-2',
      ],
    })).toBe('')
    const reserved = git({
      cwd,
      args: [
        'rev-parse',
        'refs/heads/poseidon-2/retry-allocation',
      ],
    })
    writeFileSync(
      join(
        failingHooks,
        'post-checkout',
      ),
      '#!/bin/sh\ngit update-ref --no-deref HEAD "$(git rev-parse HEAD)"\n',
    )
    expect(await titan.ownerRefused({
      args: [
        'task',
        'start',
        'retry',
      ],
    })).toMatchObject({
      code: 'COPY_FAILED',
      error: expect.stringContaining('did not stay on branch poseidon-2/retry-allocation-2'),
    })
    git({
      cwd,
      args: [
        'config',
        '--unset',
        'core.hooksPath',
      ],
    })
    const retried = await titan.owner({
      args: [
        'task',
        'start',
        'retry',
      ],
    })
    expect(git({
      cwd: retried.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/retry-allocation-3')
    expect(git({
      cwd,
      args: [
        'rev-parse',
        'refs/heads/poseidon-2/retry-allocation',
      ],
    })).toBe(reserved)
    const other = await legacyDuplicate({
      othrys,
      id: 'legacy-branch-names',
      projects: [
        {
          path: cwd,
          landing: 'branch',
        },
      ],
    })
    await other.owner({
      args: [
        'titan',
        'set',
        '--name',
        'Póseídon',
      ],
    })
    await other.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Shared name',
        '--key',
        'shared',
        '--project',
        'shop',
      ],
    })
    const otherStarted = await other.owner({
      args: [
        'task',
        'start',
        'shared',
      ],
    })
    expect(git({
      cwd: otherStarted.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/shared-name')
    git({
      cwd: otherStarted.agent.folder,
      args: [
        'switch',
        '--detach',
        'HEAD',
      ],
    })
    git({
      cwd,
      args: [
        'branch',
        '-D',
        'poseidon-2/shared-name',
      ],
    })
    expect(git({
      cwd,
      args: [
        'branch',
        '--list',
        'poseidon-2/shared-name',
      ],
    })).toBe('')
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Shared name',
        '--key',
        'shared',
        '--project',
        'shop',
      ],
    })
    const shared = await titan.owner({
      args: [
        'task',
        'start',
        'shared',
      ],
    })
    expect(git({
      cwd: shared.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/shared-name-2')
    await titan.owner({
      args: [
        'task',
        'rename',
        'chart',
        '--title',
        'Renamed chart',
      ],
    })
    const reopened = await titan.owner({
      args: [
        'task',
        'start',
        'chart',
      ],
    })
    expect(git({
      cwd: reopened.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/chart-2')
  },
)

test(
  'a projectless worker starts in scratch and gets directions to its project copy when a project is attached',
  async () => {
    const titan = await othrys.titan()
    const created = await titan.owner({
      args: [
        'task',
        'create',
        '--title',
        'Sketch an idea',
        '--key',
        'idea',
        '--brief',
        'Sketch the idea',
        '--harness',
        'claude',
      ],
    })
    expect(created.launch).toBe('started')
    const task = (await titan.task({ key: 'idea' })).id as string
    const scratch = realpathSync(join(
      process.env.OTHRYS_HOME!,
      'runtime',
      'tasks',
      task,
      'scratch',
    ))
    const worker = await titan.agent({ cwd: scratch })
    await until({
      what: 'the idea worker’s first turn',
      check: () => worker.answered === 1,
    })
    const sketch = join(
      scratch,
      'sketch.md',
    )
    writeFileSync(
      sketch,
      'first sketch\n',
    )

    const missing = titan.folder({ name: 'missing-project' })
    await titan.owner({
      args: [
        'project',
        'add',
        missing,
      ],
    })
    writeFileSync(
      join(
        missing,
        '.git',
      ),
      'invalid git metadata\n',
    )
    const unreadable = await titan.owner({
      args: [
        'task',
        'project',
        'idea',
        '--project',
        'missing-project',
      ],
    })
    expect(unreadable.worker).toContain('could not inspect the project repository')

    rmSync(
      missing,
      { recursive: true },
    )
    const unavailable = await titan.owner({
      args: [
        'task',
        'project',
        'idea',
        '--project',
        'missing-project',
      ],
    })
    expect(unavailable.worker).toContain('the project folder is unavailable')

    const notes = titan.folder({ name: 'idea-notes' })
    await titan.owner({
      args: [
        'project',
        'add',
        notes,
      ],
    })
    const plain = await titan.owner({
      args: [
        'task',
        'project',
        'idea',
        '--project',
        notes,
      ],
    })
    const destination = realpathSync(notes)
    expect(plain.worker).toBe(`asked to continue in ${destination}`)
    const saved = await titan.owner({
      args: [
        'task',
        'show',
        'idea',
        '--full',
      ],
    })
    expect(saved.task.folder).toBe(destination)
    await until({
      what: 'the worker to receive the plain project folder',
      check: () => worker.received.some(text => text.includes(`Continue the work in ${JSON.stringify(destination)}`)),
    })

    const project = await createProject({
      titan,
      landing: 'pr',
      name: 'later',
    })
    const attached = await titan.owner({
      args: [
        'task',
        'project',
        'idea',
        '--project',
        'later',
      ],
    })
    const { copy } = await titan.owner({
      args: [
        'task',
        'copy',
        'idea',
      ],
    })
    expect(copy).toMatchObject({
      project: realpathSync(project),
      state: 'active',
    })
    expect(copy.path).not.toBe(realpathSync(project))
    expect(attached.worker).toBe(`asked to continue in ${copy.path}`)
    const told = await until({
      what: 'the worker to be told where to continue',
      check: () => worker.received.find(text => text.includes(`Continue the work in ${JSON.stringify(copy.path)}`)),
    })
    expect(told).toContain(scratch)
    expect(readFileSync(
      sketch,
      'utf8',
    )).toBe('first sketch\n')

    const other = titan.folder({ name: 'other-project' })
    await titan.owner({
      args: [
        'project',
        'add',
        other,
      ],
    })
    const reassigned = await titan.owner({
      args: [
        'task',
        'project',
        'idea',
        '--project',
        other,
      ],
    })
    expect(reassigned.worker).toContain('the task still has a copy')
    expect(reassigned.worker).toContain(copy.path)
  },
)

test(
  'a plain folder outside git attaches as a project, and its task’s worker works in that folder with no copy',
  async () => {
    const titan = await othrys.titan()
    const notes = titan.folder({ name: 'notes' })
    writeFileSync(
      join(
        notes,
        'todo.md',
      ),
      'tidy up\n',
    )
    await titan.owner({
      args: [
        'project',
        'add',
        notes,
      ],
    })
    expect((await titan.owner({
      args: [
        'task',
        'create',
        '--title',
        'Tidy the notes',
        '--key',
        'tidy',
        '--brief',
        'Tidy the notes',
        '--project',
        'notes',
        '--harness',
        'claude',
      ],
    })).launch).toBe('started')

    const worker = await titan.agent({ cwd: realpathSync(notes) })
    await until({
      what: 'the notes worker’s first turn',
      check: () => worker.answered === 1,
    })
    expect((await titan.owner({
      args: [
        'task',
        'copy',
        'tidy',
      ],
    })).copy).toBe('none: this task has no copy of its own')
  },
)

test(
  'a project reassigned by a checkout hook refuses the old copy and starts in the new project',
  async () => {
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'titan',
        'set',
        '--name',
        'Iris',
      ],
    })
    const project = await createProject({
      titan,
      landing: 'branch',
    })
    const other = await createProject({
      titan,
      landing: 'branch',
      name: 'other',
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Reassign',
        '--key',
        'drift',
        '--project',
        'shop',
      ],
    })
    const hooks = join(
      project,
      'drift-hooks',
    )
    const orphanMarker = join(
      project,
      'unrecorded-folder',
    )
    mkdirSync(hooks)
    writeFileSync(
      join(
        hooks,
        'post-checkout',
      ),
      `#!${process.execPath}
const { execFileSync } = require('node:child_process')
require('node:fs').writeFileSync(${JSON.stringify(orphanMarker)}, process.cwd())
execFileSync(process.execPath, ${JSON.stringify([
  PAGE_COMMAND,
  titan.id,
  'task',
  'project',
  'drift',
  '--project',
  'other',
])})
`,
      { mode: 0o700 },
    )
    git({
      cwd: project,
      args: [
        'config',
        'core.hooksPath',
        hooks,
      ],
    })

    try {
      expect((await titan.ownerRefused({
        args: [
          'task',
          'start',
          'drift',
        ],
      })).code).toBe('CONFLICT')
      const moved = (await titan.owner({
        args: [
          'task',
          'show',
          'drift',
          '--full',
        ],
      })).task
      expect(moved.project).toBe(other)
      expect(moved.copy).toBeUndefined()
      expect(moved.sessionIds ?? []).toEqual([])
    } finally {
      git({
        cwd: project,
        args: [
          'config',
          '--unset',
          'core.hooksPath',
        ],
      })
    }

    await titan.owner({
      args: [
        'task',
        'start',
        'drift',
      ],
    })
    expect((await titan.owner({
      args: [
        'task',
        'copy',
        'drift',
      ],
    })).copy.project).toBe(other)
    const orphan = readFileSync(
      orphanMarker,
      'utf8',
    )
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Reuse clean slot',
        '--key',
        'reuse',
        '--project',
        'shop',
      ],
    })
    const reused = await titan.owner({
      args: [
        'task',
        'start',
        'reuse',
      ],
    })
    expect(reused.agent.folder).toBe(orphan)
    expect(git({
      cwd: project,
      args: [
        'branch',
        '--list',
        'iris/reassign',
      ],
    })).toContain('iris/reassign')
  },
)

test(
  'unrecorded slots preserve and report dirty or unlanded work, then reuse it after landing',
  async () => {
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'titan',
        'set',
        '--name',
        'Iris',
      ],
    })
    const project = await createProject({
      titan,
      landing: 'branch',
    })
    const hooks = join(
      project,
      'unrecorded-hooks',
    )
    const marker = join(
      project,
      'unrecorded-path',
    )
    mkdirSync(hooks)
    writeFileSync(
      join(
        hooks,
        'post-checkout',
      ),
      `#!${process.execPath}
const { writeFileSync } = require('node:fs')
writeFileSync(${JSON.stringify(marker)}, process.cwd())
writeFileSync('keep.txt', 'unfinished work')
throw new Error('fixture allocation refusal')
`,
      { mode: 0o700 },
    )
    git({
      cwd: project,
      args: [
        'config',
        'core.hooksPath',
        hooks,
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Unrecorded',
        '--key',
        'unrecorded',
        '--project',
        'shop',
      ],
    })

    try {
      expect((await titan.ownerRefused({
        args: [
          'task',
          'start',
          'unrecorded',
        ],
      })).code).toBe('COPY_FAILED')
    } finally {
      git({
        cwd: project,
        args: [
          'config',
          '--unset',
          'core.hooksPath',
        ],
      })
    }

    const orphan = readFileSync(
      marker,
      'utf8',
    )
    git({
      cwd: project,
      args: [
        'config',
        'status.showUntrackedFiles',
        'no',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Next',
        '--key',
        'next',
        '--project',
        'shop',
      ],
    })
    const other = await createProject({
      titan,
      landing: 'branch',
      name: 'other',
    })
    const foreignSlot = join(
      orphan,
      '..',
      'shop-0',
    )
    git({
      cwd: other,
      args: [
        'worktree',
        'add',
        '--detach',
        foreignSlot,
        'main',
      ],
    })
    writeFileSync(
      join(
        foreignSlot,
        'foreign.txt',
      ),
      'another project’s work',
    )
    const next = await titan.owner({
      args: [
        'task',
        'start',
        'next',
      ],
    })
    expect(next.agent.folder).not.toBe(orphan)
    expect(readFileSync(
      join(
        orphan,
        'keep.txt',
      ),
      'utf8',
    )).toBe('unfinished work')
    const dirtyMessages = await titan.owner({
      args: [
        'titan',
        'messages',
        '--full',
      ],
    })
    expect(JSON.stringify(dirtyMessages.messages)).not.toContain(foreignSlot)
    expect(readFileSync(
      join(
        foreignSlot,
        'foreign.txt',
      ),
      'utf8',
    )).toBe('another project’s work')
    expect(dirtyMessages.messages.find((event: { data: { text: string } }) => event.data.text.includes(orphan) && event.data.text.includes('uncommitted'))).toBeDefined()
    git({
      cwd: orphan,
      args: [
        'add',
        'keep.txt',
      ],
    })
    git({
      cwd: orphan,
      args: [
        'commit',
        '-qm',
        'Unlanded work',
      ],
    })
    const unlanded = git({
      cwd: orphan,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Later',
        '--key',
        'later',
        '--project',
        'shop',
      ],
    })
    const later = await titan.owner({
      args: [
        'task',
        'start',
        'later',
      ],
    })
    expect(later.agent.folder).not.toBe(orphan)
    expect(git({
      cwd: orphan,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })).toBe(unlanded)
    const unlandedMessages = await titan.owner({
      args: [
        'titan',
        'messages',
        '--full',
      ],
    })
    expect(unlandedMessages.messages.find((event: { data: { text: string } }) => event.data.text.includes(orphan) && event.data.text.includes('not landed'))).toBeDefined()
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Still unlanded',
        '--key',
        'again',
        '--project',
        'shop',
      ],
    })
    const again = await titan.owner({
      args: [
        'task',
        'start',
        'again',
      ],
    })
    expect(again.agent.folder).not.toBe(orphan)
    const repeated = await titan.owner({
      args: [
        'titan',
        'messages',
        '--full',
      ],
    })
    const orphanNotices = repeated.messages.filter(
      (event: { data: { text: string } }) => event.data.text.includes(orphan),
    )
    expect(orphanNotices).toHaveLength(2)
    git({
      cwd: orphan,
      args: [
        'push',
        'origin',
        'HEAD:refs/heads/main',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Recovered',
        '--key',
        'recovered',
        '--project',
        'shop',
      ],
    })
    const recovered = await titan.owner({
      args: [
        'task',
        'start',
        'recovered',
      ],
    })
    expect(recovered.agent.folder).toBe(orphan)
    expect(readFileSync(
      join(
        orphan,
        'keep.txt',
      ),
      'utf8',
    )).toBe('unfinished work')
    expect(git({
      cwd: orphan,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('iris/recovered')
    expect(git({
      cwd: project,
      args: [
        'rev-parse',
        'iris/unrecorded',
      ],
    })).toBe(unlanded)
  },
)

test(
  'helper-agent records do not block keeper selection or individual task moves',
  async () => {
    const keeper = await othrys.titan()
    const path = keeper.folder({ name: 'helpers-project' })
    await keeper.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const source = await legacyDuplicate({
      othrys,
      id: 'helper-project-source',
      projects: [
        {
          path,
          landing: 'branch',
        },
      ],
    })
    const created = await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Finished work',
        '--project',
        path,
      ],
    })
    const parent = created.card.id
    await source.owner({
      args: [
        'push',
        '--key',
        'helper-record',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'general-purpose helper',
        parent,
        activity: 'finished',
        agent: {
          provider: 'claude',
          sessionId: 'helper-session',
          agentId: 'helper',
        },
        source: {
          adapter: 'hooks',
          objectId: 'helper-record',
        },
      }),
    })
    const workChild = await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Real subtask',
        '--project',
        path,
      ],
    })
    await source.owner({
      args: [
        'task',
        'parent',
        workChild.card.id,
        parent,
      ],
    })
    await source.owner({
      args: [
        'task',
        'depend',
        workChild.card.id,
        '--on',
        parent,
      ],
    })
    const moved = await source.owner({
      args: [
        'task',
        'move',
        parent,
        '--to-titan',
        keeper.id,
      ],
    })
    expect(moved.notices).toBeDefined()
    expect((await source.task({ key: workChild.card.id })).parent).toBe('none')
    expect((await source.task({ key: workChild.card.id })).prerequisites).toEqual([])
    expect((await source.task({ key: workChild.card.id })).notices).toBeDefined()
    await keeper.owner({
      args: [
        'project',
        'keep',
        path,
      ],
    })
    expect((await keeper.task({ key: parent })).title).toBe('Finished work')
    expect((await source.owner({
      args: [
        'task',
        'sessions',
      ],
    })).sessions).toContainEqual(expect.objectContaining({
      id: 'claude:helper-session/helper',
      task: 'none',
    }))
    expect((await keeper.ownerRefused({
      args: [
        'task',
        'show',
        'helper-record',
      ],
    })).code).toBe('NOT_FOUND')
    const target = await othrys.titan()
    await keeper.owner({
      args: [
        'project',
        'remove',
        path,
      ],
    })
    await target.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    await keeper.owner({
      args: [
        'push',
        '--key',
        'second-helper',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Second helper',
        parent,
        activity: 'finished',
        agent: {
          provider: 'codex',
          sessionId: 'second-session',
          agentId: 'second',
        },
        source: {
          adapter: 'hooks',
          objectId: 'second-helper',
        },
      }),
    })
    const movedTask = (await keeper.owner({
      args: [
        'task',
        'show',
        parent,
        '--full',
      ],
    })).task
    const stream = join(
      movedTask.workerLogDir,
      'worker.log',
    )
    mkdirSync(
      join(
        stream,
        '..',
      ),
      { recursive: true },
    )
    appendFileSync(
      stream,
      'note: Immediately before the move\n',
    )
    await keeper.owner({
      args: [
        'task',
        'move',
        parent,
        '--to-titan',
        target.id,
      ],
    })
    expect((await target.task({ key: parent })).title).toBe('Finished work')
    expect((await target.owner({
      args: [
        'task',
        'show',
        parent,
        '--full',
      ],
    })).task.workerLog.latest.text).toBe('Immediately before the move')
    appendFileSync(
      stream,
      'note: Written to the same stream after the move\n',
    )
    await until({
      what: 'the moved worker stream to keep following',
      check: async () => (await target.owner({
        args: [
          'task',
          'show',
          parent,
          '--full',
        ],
      })).task.workerLog?.latest.text === 'Written to the same stream after the move',
    })

    expect((await keeper.owner({
      args: [
        'task',
        'sessions',
      ],
    })).sessions).toContainEqual(expect.objectContaining({
      id: 'codex:second-session/second',
      task: 'none',
    }))
    expect((await target.ownerRefused({
      args: [
        'task',
        'show',
        'second-helper',
      ],
    })).code).toBe('NOT_FOUND')
  },
)

test(
  'ready review becomes an update when its task changes to Titan merges',
  async () => {
    const titan = await othrys.titan()
    await createProject({
      titan,
      landing: 'pr',
      remote: 'https://github.com/o/shop.git',
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Review cart',
        '--key',
        'review-update',
        '--project',
        'shop',
      ],
    })
    const url = 'https://github.com/o/shop/pull/77'
    writeFileSync(
      join(
        github,
        'o',
        'shop',
        '77.json',
      ),
      JSON.stringify({
        state: 'open',
        title: 'Review cart',
        head: 'd'.repeat(40),
        checks: '1 passed, 0 failed, 1 total',
      }),
    )
    await titan.owner({
      args: [
        'link',
        'review-update',
        '--url',
        url,
      ],
    })
    const question = await until({
      what: 'an owner merge decision',
      check: async () => (await titan.owner({
        args: [
          'task',
          'show',
          'review-update',
          '--full',
        ],
      })).task.asks?.find((ask: { kind: string }) => ask.kind === 'merge'),
    })
    const landingReceipt = await titan.owner({
      args: [
        'task',
        'landing',
        'review-update',
        '--landing',
        'pr',
        '--merge',
        'titan',
      ],
    })
    const current = await titan.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    const retired = current.task.asks.find((ask: { id: string }) => ask.id === question.id)
    expect(retired).toMatchObject({ closed: { at: expect.any(String) } })
    const events = await readEvents({ titanId: titan.id })
    const landingEvent = events.find(event => event.id === landingReceipt.event.id)
    expect(landingEvent).toMatchObject({
      type: 'task.landing',
      at: retired?.closed?.at,
    })
    expect(landingReceipt.card.revision).toBe(current.task.revision)
    const updates = await titan.owner({
      args: [
        'task',
        'updates',
        'review-update',
      ],
    })
    expect(JSON.stringify(updates)).toContain(url)
    await titan.owner({
      args: [
        'task',
        'landing',
        'review-update',
        '--landing',
        'pr',
        '--merge',
        'owner',
      ],
    })
    const restored = await titan.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    expect(restored.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(1)
    const alias = await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Shared review',
        '--project',
        'shop',
      ],
    })
    await titan.owner({
      args: [
        'link',
        alias.card.id,
        '--url',
        url,
      ],
    })
    await titan.owner({
      args: [
        'task',
        'landing',
        'review-update',
        '--landing',
        'pr',
        '--merge',
        'titan',
      ],
    })
    const shared = await titan.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    expect(shared.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(1)
    await titan.owner({
      args: [
        'outcome',
        alias.card.id,
        'cancelled',
        '--note',
        'Shared review was abandoned',
      ],
    })
    const settled = await titan.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    expect(settled.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(0)
    await titan.owner({
      args: [
        'task',
        'landing',
        'review-update',
        '--clear',
      ],
    })
    const beforeProjectChange = await titan.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    const taskId = beforeProjectChange.task.id
    const pendingBeforeMove = beforeProjectChange.task.asks.filter((ask: { closed?: unknown }) =>
      !ask.closed)
    expect(pendingBeforeMove).toHaveLength(1)
    const destination = titan.folder({ name: 'titan-merges' })
    await titan.owner({
      args: [
        'project',
        'add',
        destination,
        '--landing',
        'pr',
        '--merge',
        'titan',
      ],
    })
    const projectReceipt = await titan.owner({
      args: [
        'task',
        'project',
        taskId,
        '--project',
        destination,
      ],
    })
    const moved = await titan.owner({
      args: [
        'task',
        'show',
        taskId,
        '--full',
      ],
    })
    expect(moved.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(0)
    expect(moved.task.asks).toContainEqual(expect.objectContaining({
      id: pendingBeforeMove[0].id,
      closed: expect.any(Object),
    }))
    expect(projectReceipt.event.type).toBe('task.project')
    expect(projectReceipt.card.revision).toBe(moved.task.revision)
    await titan.owner({
      args: [
        'task',
        'project',
        taskId,
        '--project',
        'shop',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'landing',
        taskId,
        '--landing',
        'pr',
        '--merge',
        'owner',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'landing',
        taskId,
        '--clear',
      ],
    })
    const beforePush = await titan.owner({
      args: [
        'task',
        'show',
        taskId,
        '--full',
      ],
    })
    const pendingBeforePush = beforePush.task.asks.filter((ask: { closed?: unknown }) =>
      !ask.closed)
    expect(pendingBeforePush).toHaveLength(1)
    const renamed = await titan.owner({
      args: [
        'push',
        '--key',
        'review-update',
        '--file',
        '-',
      ],
      input: JSON.stringify({ title: 'Review the CSV export' }),
    })
    const afterRename = await titan.owner({
      args: [
        'task',
        'show',
        taskId,
        '--full',
      ],
    })
    expect(renamed.card.id).toBe(taskId)
    expect(afterRename.task.title).toBe('Review the CSV export')
    const pendingAfterRename = afterRename.task.asks.filter((ask: { closed?: unknown }) =>
      !ask.closed)
    expect(pendingAfterRename).toEqual(pendingBeforePush)
    const pushed = await titan.owner({
      args: [
        'push',
        '--key',
        'review-update',
        '--file',
        '-',
      ],
      input: JSON.stringify({ project: destination }),
    })
    const afterPush = await titan.owner({
      args: [
        'task',
        'show',
        taskId,
        '--full',
      ],
    })
    expect(afterPush.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(0)
    expect(afterPush.task.asks).toContainEqual(expect.objectContaining({
      id: pendingBeforePush[0].id,
      closed: expect.any(Object),
    }))
    expect(pushed.card.revision).toBe(afterPush.task.revision)
  },
)

test(
  'a task discovers pull requests from its branch and keeps worker links deduplicated',
  async () => {
    const titan = await othrys.titan()
    const project = await createProject({
      titan,
      landing: 'pr',
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'discovered',
        '--title',
        'Discover a branch PR',
        '--project',
        'shop',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'start',
        'discovered',
      ],
    })
    const full = await titan.owner({
      args: [
        'task',
        'show',
        'discovered',
        '--full',
      ],
    })
    const branch = full.task.copy.branch
    const originalOrigin = git({
      cwd: project,
      args: [
        'remote',
        'get-url',
        'origin',
      ],
    }).trim()
    git({
      cwd: project,
      args: [
        'remote',
        'set-url',
        'origin',
        'https://github.com/o/shop.git',
      ],
    })
    writeFileSync(
      join(
        github,
        'o',
        'shop',
        '901.json',
      ),
      JSON.stringify({
        branch,
        state: 'open',
        draft: true,
      }),
    )
    writeFileSync(
      join(
        github,
        'o',
        'shop',
        '902.json',
      ),
      JSON.stringify({
        branch: 'someone-else',
        state: 'open',
      }),
    )
    await titan.owner({
      args: [
        'task',
        'refresh-links',
        'discovered',
      ],
    })
    await until({
      what: 'the branch pull request to be discovered',
      check: async () => {
        const shown = await titan.owner({
          args: [
            'task',
            'show',
            'discovered',
            '--full',
          ],
        })

        return shown.task.links.some((link: {
          url: string
          state: string
        }) => link.url === 'https://github.com/o/shop/pull/901' && link.state === 'open')
      },
    })
    await workerLine({
      titan,
      key: 'discovered',
      line: 'link: https://github.com/o/shop/pull/901 Branch review',
    })
    const linked = await titan.owner({
      args: [
        'task',
        'show',
        'discovered',
        '--full',
      ],
    })
    expect(linked.task.links).toHaveLength(1)
    expect(linked.task.links[0].src).toBe('branch')
    await othrys.restart({
      whileStopped: async () => {
        let active = true
        const callLog = join(
          github,
          'calls.jsonl',
        )
        const callsBefore = readFileSync(
          callLog,
          'utf8',
        )
        const nativeRun = processes.runProcess
        const spy = vi.spyOn(
          processes,
          'runProcess',
        ).mockImplementation(async ({
          command,
          args,
          ...options
        }) => {
          const result = await nativeRun({
            command,
            args,
            ...options,
          })

          if (command === 'git' && args.includes(full.task.copy.path)
            && args.includes('symbolic-ref')) {
            active = false
          }

          return result
        })

        try {
          await discoverPullRequests({
            titanId: titan.id,
            interval: 0,
            checked: new Map(),
            active: () => active,
          })
          expect(active).toBe(false)
          expect(readFileSync(
            callLog,
            'utf8',
          )).toBe(callsBefore)
        } finally {
          spy.mockRestore()
        }
      },
    })
    const gate = join(
      github,
      'discovery-gate.json',
    )
    writeFileSync(
      gate,
      JSON.stringify({ branch }),
    )

    try {
      await titan.owner({
        args: [
          'task',
          'refresh-links',
          'discovered',
        ],
      })
      await until({
        what: 'branch discovery to be pending',
        check: () => existsSync(`${gate}.ready`),
      })
      writeFileSync(
        join(
          github,
          'o',
          'shop',
          '901.json',
        ),
        JSON.stringify({
          branch,
          state: 'open',
          draft: true,
          title: 'Updated while discovery is pending',
        }),
      )
      await titan.owner({
        args: [
          'task',
          'refresh-links',
          'discovered',
        ],
      })
      await until({
        what: 'the known pull request to refresh while discovery waits',
        check: async () => (await titan.owner({
          args: [
            'task',
            'show',
            'discovered',
            '--full',
          ],
        })).task.links[0]?.title === 'Updated while discovery is pending',
      })
      expect(existsSync(`${gate}.ready`)).toBe(true)
    } finally {
      unlinkSync(gate)
    }

    expect(linked.task.branches).toEqual([
      {
        repository: 'o/shop',
        branch,
      },
    ])
    await titan.owner({
      args: [
        'link',
        'discovered',
        '--url',
        'https://github.com/o/shop/pull/900',
        '--state',
        'merged',
      ],
    })
    expect((await titan.task({ key: 'discovered' })).status).toBe('idle')
    const followup = `${branch}-followup`
    const malformed = join(
      github,
      'malformed-discovery',
    )
    writeFileSync(
      malformed,
      JSON.stringify({ branch }),
    )

    try {
      git({
        cwd: full.task.copy.path,
        args: [
          'checkout',
          '-q',
          '-b',
          followup,
        ],
      })
      writeFileSync(
        join(
          github,
          'o',
          'shop',
          '903.json',
        ),
        JSON.stringify({
          branch: followup,
          sourceOwner: 'contributor',
          state: 'open',
          draft: true,
        }),
      )

      await workerLine({
        titan,
        key: 'discovered',
        line: 'note: Follow-up branch ready',
      })
      await until({
        what: 'the new branch pull request despite an unreadable response for the earlier branch',
        check: async () => existsSync(`${malformed}.read`) && (await titan.owner({
          args: [
            'task',
            'show',
            'discovered',
            '--full',
          ],
        })).task.links.some((link: { url: string }) => link.url.endsWith('/903')),
      })
    } finally {
      unlinkSync(malformed)

      if (existsSync(`${malformed}.read`)) {
        unlinkSync(`${malformed}.read`)
      }
    }

    await othrys.restart()
    const restored = await titan.owner({
      args: [
        'task',
        'show',
        'discovered',
        '--full',
      ],
    })
    expect(restored.task.links.filter((link: { url: string }) => link.url.endsWith('/901'))).toHaveLength(1)
    expect(restored.task.branches).toEqual([
      {
        repository: 'o/shop',
        branch,
      },
      {
        repository: 'o/shop',
        branch: followup,
      },
    ])
    git({
      cwd: project,
      args: [
        'remote',
        'set-url',
        'origin',
        originalOrigin,
      ],
    })
    await titan.owner({
      args: [
        'task',
        'copy',
        'discovered',
        'remove',
        '--safe',
      ],
    })
    expect((await titan.owner({
      args: [
        'task',
        'show',
        'discovered',
        '--full',
      ],
    })).task.copy.state)
      .toBe('removed')
    git({
      cwd: project,
      args: [
        'remote',
        'set-url',
        'origin',
        'https://github.com/o/shop.git',
      ],
    })
    const outside = join(
      process.env.TMPDIR!,
      `outside-copy-${titan.id}`,
    )
    git({
      cwd: project,
      args: [
        'clone',
        '-q',
        '--local',
        project,
        outside,
      ],
    })
    const outsideBranch = 'outside-worker-branch'
    git({
      cwd: outside,
      args: [
        'checkout',
        '-q',
        '-b',
        outsideBranch,
      ],
    })
    git({
      cwd: outside,
      args: [
        'remote',
        'set-url',
        'origin',
        'https://github.com/o/shop.git',
      ],
    })
    writeFileSync(
      join(
        github,
        'o',
        'shop',
        '904.json',
      ),
      JSON.stringify({
        branch: outsideBranch,
        state: 'open',
        draft: true,
      }),
    )
    await titan.owner({
      args: [
        'push',
        '--key',
        'outside-discovery',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'outside-discovery',
          cwd: outside,
        },
        terminal: { tty: '/dev/ttys99999' },
        activity: 'finished',
      }),
    })
    await titan.owner({
      args: [
        'task',
        'detach',
        'discovered',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'attach',
        'discovered',
        '--session',
        'claude:outside-discovery',
      ],
    })
    await until({
      what: 'a PR from the new worker clone despite the removed copy record',
      check: async () => (await titan.owner({
        args: [
          'task',
          'show',
          'discovered',
          '--full',
        ],
      }))
        .task.links.some((link: { url: string }) => link.url.endsWith('/904')),
    })
  },
)

test(
  'copy reuse skips an ordinary retained directory inside the source repository',
  async () => {
    const titan = await othrys.titan()
    const project = await createProject({
      titan,
      landing: 'branch',
      name: 'retained-directory',
    })
    const task = (await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Retained directory',
        '--project',
        project,
      ],
    })).card.id as string
    const first = (await titan.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })).agent.folder as string
    await titan.owner({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--safe',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'detach',
        task,
      ],
    })
    const ordinary = join(
      project,
      'ignored-retained',
    )
    mkdirSync(ordinary)
    appendFileSync(
      join(
        project,
        '.git',
        'info',
        'exclude',
      ),
      '\nignored-retained/\n',
    )
    await withWriter({
      titanId: titan.id,
      fn: ({ writer }) => {
        const card = writer.state.cards[task]!
        writer.append({
          event: {
            ...base({
              state: writer.state,
              cardId: task,
              meta: {
                actor: 'fixture',
                at: new Date().toISOString(),
              },
            }),
            type: 'task.copy',
            data: {
              before: card.copy!,
              after: {
                ...card.copy!,
                path: ordinary,
              },
            },
          },
        })
      },
    })
    expect((await titan.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })).agent.folder).toBe(first)
    expect(git({
      cwd: project,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('main')
  },
)

test(
  'copy reuse protects a worker running in a released slot subdirectory',
  async () => {
    const source = await othrys.titan()
    const peer = await othrys.titan()
    const project = await createProject({
      titan: source,
      landing: 'branch',
      name: 'nested-worker',
    })
    const task = (await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Released copy',
        '--project',
        project,
      ],
    })).card.id as string
    const first = (await source.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })).agent.folder as string
    await source.owner({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--safe',
      ],
    })
    await source.owner({
      args: [
        'task',
        'detach',
        task,
      ],
    })
    appendFileSync(
      join(
        project,
        '.git',
        'info',
        'exclude',
      ),
      '\npackages/\n',
    )
    const nested = join(
      first,
      'packages',
      'app',
    )
    mkdirSync(
      nested,
      { recursive: true },
    )
    const other = (await peer.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Nested worker',
        '--folder',
        nested,
      ],
    })).card.id as string
    await peer.owner({
      args: [
        'task',
        'start',
        other,
      ],
    })
    const worker = await peer.agent({ cwd: nested })
    const next = (await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Another copy',
        '--project',
        project,
      ],
    })).card.id as string
    expect((await source.owner({
      args: [
        'task',
        'start',
        next,
      ],
    })).agent.folder).not.toBe(first)
    expect(worker.closed).toBe(false)
    expect((await peer.task({ key: other })).worker).toBe(`claude-code:${worker.id}`)
  },
)

test(
  'copy reuse refuses a linked active checkout before restarting its worker',
  async () => {
    const titan = await othrys.titan()
    const project = await createProject({
      titan,
      landing: 'branch',
      name: 'active-copy-link',
    })
    const task = (await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Active copy link',
        '--project',
        project,
      ],
    })).card.id as string
    const first = (await titan.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })).agent.folder as string
    await titan.owner({
      args: [
        'task',
        'stop',
        task,
      ],
    })
    await titan.owner({
      args: [
        'task',
        'detach',
        task,
      ],
    })
    const parked = join(
      titan.folder({ name: 'parked-active-copy' }),
      'checkout',
    )
    git({
      cwd: project,
      args: [
        'worktree',
        'move',
        first,
        parked,
      ],
    })
    linkCopyFolder(
      parked,
      first,
      'dir',
    )

    try {
      expect((await titan.ownerRefused({
        args: [
          'task',
          'start',
          task,
        ],
      })).code).toBe('CONFLICT')
    } finally {
      unlinkCopyFolder(first)
      git({
        cwd: project,
        args: [
          'worktree',
          'move',
          parked,
          first,
        ],
      })
    }
  },
)

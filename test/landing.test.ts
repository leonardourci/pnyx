import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { taskPrompt } from '../src/cli/start.ts'
import { decidePush } from '../src/core/decide.ts'
import { hydraDigest } from '../src/core/digest.ts'
import { hydraConfig, hydraEvent, unwatchedPullRequests, wakesHydra } from '../src/core/hydra.ts'
import type { Card, Link, TaskCopy } from '../src/core/model.ts'
import { pullRequestStatus, type PullRequestStatus } from '../src/integrations/github/pull-request.ts'
import { followPullRequests, workerNews } from '../src/landing/follow.ts'
import { mergeCommand } from '../src/landing/merge.ts'
import { buildCommand } from '../src/investigation/cli.ts'
import { REPORT_MAX_CHARS } from '../src/investigation/report.ts'
import { project } from '../src/projects/cli.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'

process.env.PNYX_SEMANTIC = 'off'
const PR = 'https://github.com/o/r/pull/7'

const git = ({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}) => execFileSync(
  'git',
  [
    '-C',
    cwd,
    ...args,
  ],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  },
).trim()

// A project with an origin, a task in it and that task's copy on its own branch.
async function lab() {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-landing-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  const origin = join(
    root,
    'origin.git',
  )
  const repo = join(
    root,
    'app',
  )
  const copy = join(
    root,
    'copy',
  )
  git({
    cwd: root,
    args: [
      'init',
      '-q',
      '--bare',
      '-b',
      'main',
      origin,
    ],
  })
  mkdirSync(repo)
  git({
    cwd: repo,
    args: [
      'init',
      '-q',
      '-b',
      'main',
    ],
  })
  writeFileSync(
    join(
      repo,
      'README.md',
    ),
    'app\n',
  )
  git({
    cwd: repo,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd: repo,
    args: [
      'commit',
      '-q',
      '-m',
      'init',
    ],
  })
  git({
    cwd: repo,
    args: [
      'remote',
      'add',
      'origin',
      origin,
    ],
  })
  git({
    cwd: repo,
    args: [
      'push',
      '-q',
      'origin',
      'main',
    ],
  })
  git({
    cwd: root,
    args: [
      'clone',
      '-q',
      origin,
      copy,
    ],
  })
  git({
    cwd: copy,
    args: [
      'switch',
      '-q',
      '-c',
      'pnyx/task',
    ],
  })
  await project([
    'add',
    repo,
  ])
  const created = commands.task([
    'create',
    '--title',
    'Ship it',
    '--project',
    repo,
  ]) as { card: { id: string } }
  const id = created.card.id
  const record: TaskCopy = {
    path: copy,
    project: repo,
    via: 'worktree',
    branch: 'pnyx/task',
    base: 'origin/main',
    state: 'active',
  }
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        meta: {
          actor: 'pnyx',
          at: new Date().toISOString(),
        },
        cardId: id,
        change: {
          type: 'task.copy',
          data: {
            before: null,
            after: record,
          },
        },
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }
    },
  })

  const card = () => loadHydra({ hydraId: 'default' }).state.cards[id]!
  const done = () => commands.task([
    'status',
    id,
    'done',
    '--note',
    'finished',
  ])
  const change = ({ file }: { file: string }) => writeFileSync(
    join(
      copy,
      file,
    ),
    `${file}\n`,
  )

  const commitAll = () => {
    git({
      cwd: copy,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: copy,
      args: [
        'commit',
        '-q',
        '-m',
        'work',
      ],
    })
  }

  return {
    root,
    repo,
    copy,
    id,
    card,
    done,
    change,
    commitAll,
  }
}

const status = ({
  state = 'open',
  summary = '2 passed, 0 failed, 2 total',
  failed = 0,
  pending = 0,
  comments = 0,
  draft = false,
}: {
  state?: PullRequestStatus['state']
  summary?: string
  failed?: number
  pending?: number
  comments?: number
  draft?: boolean
} = {}): PullRequestStatus => ({
  state,
  draft,
  checks: {
    summary,
    failed,
    pending,
  },
  comments,
})

test(
  'project landing rules default to a pull request the owner merges, and project set changes them',
  async () => {
    const { repo } = await lab()

    const listed = async () => {
      const output = await project(['list']) as unknown as {
        projects: {
          landing: string
          merge: string
        }[]
      }

      return output.projects[0]!
    }

    assert.deepEqual(
      {
        landing: (await listed()).landing,
        merge: (await listed()).merge,
      },
      {
        landing: 'pr',
        merge: 'owner',
      },
    )
    await project([
      'set',
      repo,
      '--landing',
      'branch',
    ])
    assert.equal(
      (await listed()).landing,
      'branch',
    )
    await assert.rejects(
      async () => project([
        'set',
        repo,
        '--merge',
        'anyone',
      ]),
      /--merge must be owner or hydra/,
    )
  },
)

test(
  'one task lands by its own rule only on the owner\'s or Hydra\'s word, and clearing it restores the project\'s',
  async () => {
    const {
      id,
      card,
    } = await lab()
    const rule = () => commands.task([
      'landing',
      id,
    ]) as {
      landing: string
      merge: string
      from: string
    }

    assert.throws(
      () => commands.task([
        'landing',
        id,
        '--landing',
        'branch',
        '--actor',
        `worker:${id}`,
      ]),
      /only the owner/,
    )
    commands.task([
      'landing',
      id,
      '--landing',
      'branch',
      '--actor',
      'hydra',
    ])
    assert.deepEqual(
      rule(),
      {
        task: id,
        landing: 'branch',
        merge: 'owner',
        from: 'task',
      },
    )
    assert.match(
      taskPrompt({
        hydraId: 'default',
        card: card(),
      }),
      /Landing: commit your work on your branch in this copy, then declare done/,
    )
    commands.task([
      'landing',
      id,
      '--clear',
    ])
    assert.equal(
      rule().from,
      'project',
    )
    assert.equal(
      card().landing,
      undefined,
    )
  },
)

test(
  'the worker header names where the job stops: the landing rule, or an investigation\'s report',
  async () => {
    const {
      repo,
      card,
    } = await lab()
    const prompt = () => taskPrompt({
      hydraId: 'default',
      card: card(),
    })

    assert.match(
      prompt(),
      /open a ready pull request .* use needs_you with its URL only if readiness has not been recorded yet: the owner merges it; never merge it yourself/,
    )
    await project([
      'set',
      repo,
      '--merge',
      'hydra',
    ])
    assert.match(
      prompt(),
      /Hydra merges it once every check is green/,
    )
    await project([
      'set',
      repo,
      '--landing',
      'branch',
    ])
    assert.match(
      prompt(),
      /Do not push or open a pull request/,
    )
  },
)

test(
  'done is refused until the copy\'s work lands by the project\'s rule',
  async () => {
    const {
      repo,
      id,
      done,
      change,
      commitAll,
      card,
    } = await lab()
    change({ file: 'a.txt' })
    assert.throws(
      () => done(),
      /not done yet: 1 file uncommitted$/,
    )
    commitAll()
    assert.throws(
      () => done(),
      /commit [0-9a-f]{7} is not pushed; no linked pull request/,
    )
    commands.link([
      id,
      '--url',
      PR,
      '--state',
      'open',
    ])
    assert.throws(
      () => done(),
      /its pull request has not merged/,
    )
    assert.notEqual(
      card().status?.state,
      'done',
    )

    await project([
      'set',
      repo,
      '--landing',
      'branch',
    ])
    done()
    assert.equal(
      card().status?.state,
      'done',
    )
  },
)

test(
  'an investigation is done only with its stored report, and the owner turns it into the build',
  async () => {
    const { root } = await lab()
    const created = commands.task([
      'create',
      '--title',
      'Why does sign-in fail',
      '--kind',
      'investigation',
    ]) as { card: { id: string } }
    const id = created.card.id
    const file = join(
      root,
      'report.md',
    )
    writeFileSync(
      file,
      '# Finding\n\nThe token expires early.\n',
    )

    assert.throws(
      () => commands.task([
        'status',
        id,
        'done',
      ]),
      /no stored report/,
    )
    commands.task([
      'report',
      id,
      '--file',
      file,
    ])
    commands.task([
      'status',
      id,
      'done',
    ])
    assert.equal(
      (commands.task([
        'report',
        id,
      ]) as { report: string }).report,
      '# Finding\n\nThe token expires early.',
    )
    await assert.rejects(
      async () => commands.task([
        'build',
        id,
        '--actor',
        `worker:${id}`,
      ]),
      /only the owner/,
    )
    await commands.task([
      'build',
      id,
    ])
    const card = loadHydra({ hydraId: 'default' }).state.cards[id]!
    assert.equal(
      card.kind,
      'build',
    )
    assert.equal(
      card.column,
      'queued',
      'a build with no worker waits in Queued for Hydra',
    )
    assert.match(
      taskPrompt({
        hydraId: 'default',
        card,
      }),
      /read its stored report/,
    )
  },
)

test(
  'Hydra merges only where the project lets it and only on green checks; a merge declares the task done',
  async () => {
    const {
      repo,
      id,
      card,
    } = await lab()
    commands.link([
      id,
      '--url',
      PR,
      '--state',
      'open',
    ])
    const merged: string[] = []
    const merge = ({
      actor,
      read,
    }: {
      actor: string
      read: PullRequestStatus
    }) => mergeCommand({
      hydraId: 'default',
      ref: id,
      meta: {
        actor,
        at: new Date().toISOString(),
      },
      readStatus: async () => read,
      merge: async ({ url }) => {
        merged.push(url)
      },
    })

    await assert.rejects(
      merge({
        actor: 'hydra',
        read: status(),
      }),
      /the owner merges this project's pull requests/,
    )
    await project([
      'set',
      repo,
      '--merge',
      'hydra',
    ])
    await assert.rejects(
      merge({
        actor: 'hydra',
        read: status({
          summary: '1 passed, 1 failed, 2 total',
          failed: 1,
        }),
      }),
      /checks are red/,
    )
    await assert.rejects(
      merge({
        actor: 'hydra',
        read: status({ pending: 1 }),
      }),
      /checks are still running/,
    )
    await merge({
      actor: 'hydra',
      read: status(),
    })
    assert.deepEqual(
      merged,
      [PR],
    )
    assert.equal(
      card().links[0]!.state,
      'merged',
    )
    assert.equal(
      card().status?.state,
      'done',
    )
  },
)

test(
  'following a pull request records its checks and comments, and tells the worker only what changed',
  async () => {
    const {
      id,
      card,
    } = await lab()
    commands.link([
      id,
      '--url',
      PR,
      '--state',
      'open',
    ])
    const follow = ({ read }: { read: PullRequestStatus }) => followPullRequests({
      hydraId: 'default',
      readStatus: async () => read,
    })

    await follow({ read: status({ comments: 1 }) })
    assert.equal(
      card().links[0]!.checks,
      '2 passed, 0 failed, 2 total',
    )
    assert.equal(
      card().links[0]!.comments,
      1,
    )
    const linked = readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.linked').length
    await follow({ read: status({ comments: 1 }) })
    assert.equal(
      readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.linked').length,
      linked,
      'an unchanged pull request records nothing',
    )

    const link: Link = card().links[0]!
    const failing = status({
      summary: '1 passed, 1 failed, 2 total',
      failed: 1,
      comments: 3,
    })
    const news = workerNews({
      card: card(),
      link,
      status: failing,
    })
    assert.match(
      news ?? '',
      /Checks failed on .*pull\/7: 1 passed, 1 failed, 2 total\. Read them with `gh-axi pr checks 7 --repo o\/r`/,
    )
    assert.match(
      news ?? '',
      /2 new review comments/,
    )
    assert.equal(
      workerNews({
        card: card(),
        link,
        status: status({ comments: 1 }),
      }),
      undefined,
    )

    await follow({ read: status({ state: 'merged' }) })
    assert.equal(
      card().links[0]!.state,
      'merged',
    )
    assert.equal(
      card().status?.state,
      'done',
    )
  },
)

test(
  'a merged pull request wakes Hydra; failed checks wake it only when the task has no worker',
  () => {
    const state = loadHydra({ hydraId: 'default' }).state
    const card = {
      id: 'task-1',
      sessionIds: [],
      tracking: 'declared',
      links: [
        {
          kind: 'github_pr',
          url: PR,
          state: 'open',
        },
      ],
    } as unknown as Card
    const hosted = {
      ...state,
      cards: {
        'task-1': card,
        $hydra: {
          id: '$hydra',
          agent: {
            host: 'pnyx',
            provider: 'claude',
            sessionId: 's',
          },
        } as unknown as Card,
      },
    }
    const linked = ({
      before,
      after,
      worker = false,
    }: {
      before: Partial<Link>
      after: Partial<Link>
      worker?: boolean
    }) => wakesHydra({
      state: {
        ...hosted,
        cards: {
          ...hosted.cards,
          'task-1': {
            ...card,
            sessionIds: worker ? ['s1'] : [],
          },
        },
      },
      event: {
        type: 'card.linked',
        actor: 'pnyx',
        cardId: 'task-1',
        data: {
          url: PR,
          before: {
            kind: 'github_pr',
            url: PR,
            ...before,
          },
          after: {
            kind: 'github_pr',
            url: PR,
            ...after,
          },
        },
      } as never,
    })

    assert.equal(
      linked({
        before: { state: 'open' },
        after: { state: 'merged' },
        worker: true,
      }),
      true,
    )
    assert.equal(
      linked({
        before: { state: 'open' },
        after: {
          state: 'open',
          checks: '0 passed, 1 failed, 1 total',
        },
        worker: true,
      }),
      false,
    )
    assert.equal(
      linked({
        before: { state: 'open' },
        after: {
          state: 'open',
          checks: '0 passed, 1 failed, 1 total',
        },
      }),
      true,
    )
    assert.equal(
      linked({
        before: {
          state: 'open',
          comments: 1,
        },
        after: {
          state: 'open',
          comments: 2,
        },
      }),
      true,
      'a new comment with no worker to wake needs Hydra',
    )
    assert.equal(
      linked({
        before: {
          state: 'open',
          comments: 1,
        },
        after: {
          state: 'open',
          comments: 2,
        },
        worker: true,
      }),
      false,
    )
  },
)

test(
  'the digest names an open pull request whose task has no worker to wake',
  async () => {
    const {
      id,
      card,
    } = await lab()
    commands.link([
      id,
      '--url',
      PR,
      '--state',
      'open',
    ])

    assert.match(
      hydraDigest({
        hydraId: 'default',
        state: loadHydra({ hydraId: 'default' }).state,
        owner: {},
      }),
      new RegExp(`unwatched pull request: ${PR} \\(no worker to wake with its news\\)`),
    )
    assert.deepEqual(
      unwatchedPullRequests({
        card: {
          ...card(),
          sessionIds: ['s1'],
        },
      }),
      [],
      'an idle worker can still be woken',
    )
    assert.equal(
      unwatchedPullRequests({
        card: {
          ...card(),
          sessionIds: ['s1'],
          stoppedAt: '2026-10-22T00:00:00.000Z',
        },
      }).length,
      1,
      'an ended worker cannot',
    )
    assert.deepEqual(
      unwatchedPullRequests({
        card: {
          ...card(),
          links: [
            {
              ...card().links[0]!,
              state: 'merged',
            },
          ],
        },
      }),
      [],
      'a merged pull request needs no watching',
    )
  },
)

test(
  'a worker that ends with an open pull request wakes Hydra to get it watched again',
  () => {
    const state = loadHydra({ hydraId: 'default' }).state
    const card = {
      id: 'task-1',
      sessionIds: ['s1'],
      tracking: 'declared',
      activity: 'ended',
      stoppedAt: '2026-10-22T00:00:00.000Z',
      attention: [],
      links: [],
    } as unknown as Card
    const ended = ({ links }: { links: Partial<Link>[] }) => wakesHydra({
      state: {
        ...state,
        cards: {
          'task-1': {
            ...card,
            links: links as Link[],
          },
          $hydra: {
            id: '$hydra',
            agent: {
              host: 'pnyx',
              provider: 'claude',
              sessionId: 's',
            },
          } as unknown as Card,
        },
      },
      event: {
        type: 'card.pushed',
        actor: 'pnyx',
        cardId: 'task-1',
        data: { activity: 'ended' },
      } as never,
    })

    assert.equal(
      ended({
        links: [
          {
            kind: 'github_pr',
            url: PR,
            state: 'open',
          },
        ],
      }),
      true,
    )
    assert.equal(
      ended({
        links: [
          {
            kind: 'github_pr',
            url: PR,
            state: 'merged',
          },
        ],
      }),
      false,
    )
  },
)

test(
  'gh-axi\'s pull request view reads as state, checks still running and comments',
  async () => {
    process.env.PNYX_GH_AXI = join(
      import.meta.dirname,
      'fixtures/github/gh-axi.sh',
    )
    const read = await pullRequestStatus({ url: 'https://github.com/o/r/pull/9' })

    assert.deepEqual(
      read,
      {
        state: 'open',
        draft: false,
        checks: {
          summary: '0 passed, 0 failed',
          failed: 0,
          pending: 0,
        },
        comments: 0,
      },
    )
    assert.deepEqual(
      await pullRequestStatus({ url: 'https://github.com/o/r/pull/8' }),
      {
        state: 'open',
        draft: true,
        checks: {
          summary: '3 passed, 1 failed, 1 skipped, 6 total',
          failed: 1,
          pending: 1,
        },
        comments: 3,
      },
    )
  },
)

test(
  'an investigation\'s header stops at its stored report, not at the project\'s landing rule',
  async () => {
    const { repo } = await lab()
    const created = commands.task([
      'create',
      '--title',
      'Investigate slow exports',
      '--kind',
      'investigation',
      '--project',
      repo,
    ]) as { card: { id: string } }
    const prompt = taskPrompt({
      hydraId: 'default',
      card: loadHydra({ hydraId: 'default' }).state.cards[created.card.id]!,
    })

    assert.match(
      prompt,
      new RegExp(`Investigation: answer the brief.*task report ${created.card.id} --file`),
    )
    assert.doesNotMatch(
      prompt,
      /Landing:/,
    )
  },
)

test(
  'done goes through once the work landed: a pushed commit whose pull request merged, or a commit on the default branch',
  async () => {
    const merged = await lab()
    merged.change({ file: 'a.txt' })
    merged.commitAll()
    git({
      cwd: merged.copy,
      args: [
        'push',
        '-q',
        'origin',
        'pnyx/task',
      ],
    })
    commands.link([
      merged.id,
      '--url',
      PR,
      '--state',
      'merged',
    ])
    merged.done()
    assert.equal(
      merged.card().status?.state,
      'done',
    )

    const onMain = await lab()
    onMain.change({ file: 'b.txt' })
    onMain.commitAll()
    git({
      cwd: onMain.copy,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD:main',
      ],
    })
    git({
      cwd: onMain.copy,
      args: [
        'fetch',
        '-q',
        'origin',
      ],
    })
    onMain.done()
    assert.equal(
      onMain.card().status?.state,
      'done',
    )
  },
)

test(
  'branch landing still needs every change committed',
  async () => {
    const {
      repo,
      change,
      done,
    } = await lab()
    await project([
      'set',
      repo,
      '--landing',
      'branch',
    ])
    change({ file: 'a.txt' })

    assert.throws(
      () => done(),
      (error: Error & { code?: string }) => error.code === 'NOT_LANDED' && /1 file uncommitted/.test(error.message),
    )
  },
)

test(
  'task merge: the owner merges under the owner rule, a worker never, and only an open, ready, single pull request',
  async () => {
    const {
      id,
      card,
    } = await lab()
    const SECOND = 'https://github.com/o/r/pull/8'
    commands.link([
      id,
      '--url',
      PR,
      '--state',
      'open',
    ])
    const merged: string[] = []
    const merge = ({
      actor,
      read = status(),
      url,
      fail = false,
    }: {
      actor: string
      read?: PullRequestStatus
      url?: string
      fail?: boolean
    }) => mergeCommand({
      hydraId: 'default',
      ref: id,
      url,
      meta: {
        actor,
        at: new Date().toISOString(),
      },
      readStatus: async () => read,
      merge: async ({ url: target }) => {
        if (fail) {
          throw new Error('Pull request is not mergeable')
        }

        merged.push(target)
      },
    })

    await assert.rejects(
      merge({ actor: `worker:${id}` }),
      /only the owner or Hydra/,
    )
    await assert.rejects(
      merge({
        actor: 'cli',
        read: status({ draft: true }),
      }),
      /still a draft/,
    )
    await assert.rejects(
      merge({
        actor: 'cli',
        read: status({ state: 'closed' }),
      }),
      /is closed/,
    )
    await assert.rejects(
      merge({
        actor: 'cli',
        fail: true,
      }),
      (error: Error & { code?: string }) => error.code === 'MERGE_FAILED',
    )
    assert.equal(
      card().links[0]!.state,
      'open',
    )
    assert.notEqual(
      card().status?.state,
      'done',
    )

    commands.link([
      id,
      '--url',
      SECOND,
      '--state',
      'open',
    ])
    await assert.rejects(
      merge({ actor: 'cli' }),
      /name one with --url/,
    )
    commands.link([
      id,
      '--url',
      SECOND,
      '--state',
      'closed',
    ])
    await merge({ actor: 'cli' })
    assert.deepEqual(
      merged,
      [PR],
    )
    assert.equal(
      card().status?.state,
      'done',
      'a closed pull request does not hold back done once the other merged',
    )
  },
)

test(
  'task merge of a pull request that already merged records it without merging again',
  async () => {
    const {
      id,
      card,
    } = await lab()
    commands.link([
      id,
      '--url',
      PR,
      '--state',
      'open',
    ])
    let calls = 0
    await mergeCommand({
      hydraId: 'default',
      ref: id,
      meta: {
        actor: 'cli',
        at: new Date().toISOString(),
      },
      readStatus: async () => status({ state: 'merged' }),
      merge: async () => {
        calls++
      },
    })

    assert.equal(
      calls,
      0,
    )
    assert.equal(
      card().status?.state,
      'done',
    )
  },
)

test(
  'a stored report must be a readable, non-empty file under the size limit',
  async () => {
    const {
      root,
      id,
    } = await lab()
    const reports = () => readEvents({ hydraId: 'default' }).filter(e => e.type === 'task.report').length
    const store = ({ file }: { file: string }) => () => commands.task([
      'report',
      id,
      '--file',
      file,
    ])
    const empty = join(
      root,
      'empty.md',
    )
    const large = join(
      root,
      'large.md',
    )
    writeFileSync(
      empty,
      '  \n',
    )
    writeFileSync(
      large,
      'x'.repeat(REPORT_MAX_CHARS + 1),
    )

    assert.throws(
      store({ file: empty }),
      /the report is empty/,
    )
    assert.throws(
      store({ file: large }),
      new RegExp(`keep it under ${REPORT_MAX_CHARS}`),
    )
    assert.throws(
      store({
        file: join(
          root,
          'missing.md',
        ),
      }),
      /not readable/,
    )
    assert.equal(
      reports(),
      0,
    )
  },
)

test(
  'task build needs a stored report and an investigation, and wakes the investigation\'s own worker',
  async () => {
    const {
      root,
      id,
      card,
    } = await lab()
    const file = join(
      root,
      'report.md',
    )
    writeFileSync(
      file,
      'Found it.\n',
    )

    await assert.rejects(
      async () => commands.task([
        'build',
        id,
      ]),
      /already a build task/,
    )

    const created = commands.task([
      'create',
      '--title',
      'Investigate the crash',
      '--kind',
      'investigation',
    ]) as { card: { id: string } }
    await assert.rejects(
      async () => commands.task([
        'build',
        created.card.id,
      ]),
      /no stored report to build from/,
    )

    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key: card().key,
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'worker',
              host: 'pnyx',
            },
            activity: 'finished',
          },
          meta: {
            actor: 'pnyx',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
          cardId: id,
          change: {
            type: 'task.kind',
            data: {
              before: 'build',
              after: 'investigation',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    commands.task([
      'report',
      id,
      '--file',
      file,
    ])
    const told: string[] = []
    await buildCommand({
      hydraId: 'default',
      ref: id,
      meta: {
        actor: 'cli',
        at: new Date().toISOString(),
      },
      reply: async ({ request }) => {
        told.push(request.text)

        return { state: 'sent' } as never
      },
    })

    assert.equal(
      card().status?.state,
      'working',
    )
    assert.match(
      told.join('\n'),
      /The owner approved building this/,
    )
  },
)

test(
  'project add takes the landing rule, and an unknown rule is refused',
  async () => {
    const { root } = await lab()
    const other = join(
      root,
      'other',
    )
    mkdirSync(other)
    git({
      cwd: other,
      args: [
        'init',
        '-q',
        '-b',
        'main',
      ],
    })
    await project([
      'add',
      other,
      '--landing',
      'branch',
      '--merge',
      'hydra',
    ])
    const listed = (await project(['list']) as unknown as {
      projects: {
        path: string
        landing: string
        merge: string
      }[]
    }).projects.find(p => p.path === other)!

    assert.deepEqual(
      {
        landing: listed.landing,
        merge: listed.merge,
      },
      {
        landing: 'branch',
        merge: 'hydra',
      },
    )
    await assert.rejects(
      async () => project([
        'set',
        other,
        '--landing',
        'bogus',
      ]),
      /--landing must be pr or branch/,
    )
  },
)

test(
  'following tells the worker only about rising failures and new comments, and finished checks only while paused',
  async () => {
    const { card } = await lab()
    const link: Link = {
      kind: 'github_pr',
      url: PR,
      state: 'open',
      checks: '1 passed, 1 failed, 3 total',
    }

    assert.equal(
      workerNews({
        card: card(),
        link,
        status: status({
          summary: '2 passed, 1 failed, 3 total',
          failed: 1,
          comments: 3,
        }),
      }),
      undefined,
      'the same failure while checks finish, and comments before any baseline, say nothing',
    )
    assert.equal(
      workerNews({
        card: {
          ...card(),
          status: {
            state: 'paused',
            at: new Date().toISOString(),
            actor: 'cli',
          },
        } as Card,
        link: {
          ...link,
          checks: '1 passed, 0 failed, 2 total',
        },
        status: status({ summary: '2 passed, 0 failed, 2 total' }),
      }),
      `Checks finished on ${PR}: 2 passed, 0 failed, 2 total.`,
    )
    assert.equal(
      workerNews({
        card: card(),
        link: {
          ...link,
          checks: '1 passed, 0 failed, 2 total',
        },
        status: status({ summary: '2 passed, 0 failed, 2 total' }),
      }),
      undefined,
    )
  },
)

test(
  'following delivers news to the task\'s worker',
  async () => {
    const { id } = await lab()
    commands.link([
      id,
      '--url',
      PR,
      '--state',
      'open',
    ])
    const told: string[] = []
    await followPullRequests({
      hydraId: 'default',
      readStatus: async () => status({
        summary: '0 passed, 1 failed, 1 total',
        failed: 1,
      }),
      tell: async ({ text }) => {
        told.push(text)
      },
    })

    assert.match(
      told.join('\n'),
      /Checks failed on/,
    )
  },
)

test(
  'following metadata moves a draft to owner review only when it becomes ready, then to Done on merge',
  async () => {
    const f = await lab()
    commands.link([
      f.id,
      '--url',
      PR,
    ])
    const column = ({ role }: { role: string }) => hydraConfig({ state: loadHydra({ hydraId: 'default' }).state }).columns.find(c => c.role === role)?.id
    const follow = ({ read }: { read: PullRequestStatus }) => followPullRequests({
      hydraId: 'default',
      readStatus: async () => read,
    })
    await follow({ read: status({ draft: true }) })
    assert.notEqual(
      f.card().column,
      column({ role: 'needs_you' }),
    )
    assert.notEqual(
      f.card().status?.state,
      'done',
    )
    await follow({ read: status({ draft: false }) })
    assert.equal(
      f.card().column,
      column({ role: 'needs_you' }),
    )
    assert.equal(
      f.card().status?.state,
      'needs_you',
    )
    const declaration = f.card().status?.id
    await follow({ read: status({ comments: 1 }) })
    assert.equal(
      f.card().status?.id,
      declaration,
    )
    await follow({ read: status({ state: 'merged' }) })
    assert.equal(
      f.card().column,
      column({ role: 'done' }),
    )
    assert.equal(
      f.card().status?.state,
      'done',
    )
  },
)

test(
  'a ready pull request under Hydra merge rules leaves its task phase alone',
  async () => {
    const f = await lab()
    await commands.task([
      'landing',
      f.id,
      '--landing',
      'pr',
      '--merge',
      'hydra',
    ])
    commands.link([
      f.id,
      '--url',
      PR,
    ])
    const before = f.card().status?.id
    await followPullRequests({
      hydraId: 'default',
      readStatus: async () => status(),
    })
    assert.equal(
      f.card().status?.id,
      before,
    )
  },
)

test(
  'answering another owner question preserves the ready pull request gate',
  async () => {
    const f = await lab()
    commands.link([
      f.id,
      '--url',
      PR,
    ])
    await followPullRequests({
      hydraId: 'default',
      readStatus: async () => status(),
    })
    assert.equal(
      f.card().status?.state,
      'needs_you',
    )
    const asked = await commands.task([
      'ask',
      f.id,
      '--question',
      'Which release target?',
      '--to',
      'owner',
      '--actor',
      'hydra',
      '--reason',
      'Release choice',
    ])
    await commands.task([
      'status',
      f.id,
      'needs_you',
      '--note',
      'Release target pending',
    ])
    await commands.task([
      'answer',
      f.id,
      String(asked.ask),
      '--text',
      'Use staging',
      '--actor',
      'cli',
    ])
    assert.equal(
      f.card().status?.state,
      'needs_you',
    )
    assert.match(
      f.card().status?.note ?? '',
      /Pull request ready for owner review/,
    )
  },
)

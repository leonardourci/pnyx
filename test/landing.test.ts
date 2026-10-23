import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { hydraDigest } from '../src/core/digest.ts'
import { hydraEvent, unwatchedPullRequests } from '../src/core/hydra.ts'
import { wakesHydra } from '../src/core/wake-reasons.ts'
import type { Card, Link, TaskCopy } from '../src/core/model.ts'
import { pullRequestStatus, type PullRequestStatus } from '../src/integrations/github/pull-request.ts'
import { followPullRequests, workerNews } from '../src/landing/follow.ts'
import { mergeCommand } from '../src/landing/merge.ts'
import { project } from '../src/projects/cli.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'

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
  'a merged pull request or settled checks wake Hydra; a failure while checks still run wakes it only when the task has no worker',
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
          checks: '0 passed, 1 failed, 2 total',
        },
        worker: true,
      }),
      false,
      'a failure while another check runs goes to the worker alone',
    )
    assert.equal(
      linked({
        before: { state: 'open' },
        after: {
          state: 'open',
          checks: '0 passed, 1 failed, 2 total',
        },
      }),
      true,
    )

    const settled = ({
      before,
      after,
      draft = false,
    }: {
      before?: string
      after: string
      draft?: boolean
    }) => linked({
      before: {
        state: 'open',
        checks: before,
      },
      after: {
        state: 'open',
        checks: after,
        draft,
      },
      worker: true,
    })

    assert.equal(
      settled({
        before: '1 passed, 2 total',
        after: '2 passed, 2 total',
      }),
      true,
      'checks going green wake Hydra even with a live worker',
    )
    assert.equal(
      settled({
        before: '1 passed, 2 total',
        after: '1 passed, 1 failed, 2 total',
      }),
      true,
      'checks going red wake Hydra too',
    )
    assert.equal(
      settled({
        before: '1 passed, 1 failed, 2 total',
        after: '2 passed, 2 total',
      }),
      true,
      'a re-run that turns green wakes Hydra',
    )
    assert.equal(
      settled({
        before: '1 passed, 3 total',
        after: '2 passed, 3 total',
      }),
      false,
      'checks still running wake nobody',
    )
    assert.equal(
      settled({
        before: '2 passed, 2 total',
        after: '2 passed, 2 total',
      }),
      false,
      'an unchanged result is not news',
    )
    assert.equal(
      settled({
        before: '1 passed, 2 total',
        after: '2 passed, 2 total',
        draft: true,
      }),
      false,
      'a draft is not ready for anyone',
    )
    assert.equal(
      settled({
        before: '2 pending, 2 total',
        after: '2 skipped, 2 total',
      }),
      false,
      'checks that all skipped ran nothing',
    )
    assert.equal(
      linked({
        before: {
          state: 'open',
          checks: '2 passed, 2 total',
          draft: true,
        },
        after: {
          state: 'open',
          checks: '2 passed, 2 total',
          draft: false,
        },
        worker: true,
      }),
      true,
      'a draft marked ready with green checks is news',
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
    assert.equal(
      (await pullRequestStatus({ url: 'https://github.com/o/r/pull/10' }))?.draft,
      true,
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

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pullRequestMergeEvidence, pullRequestMergeOutcome } from '../src/integrations/github/merge-evidence.ts'
import { pullRequestLanding, pullRequestLandingSync, pullRequestState } from '../src/integrations/github/pull-request.ts'
import { scriptPullRequest, type FakePullRequest } from './scenarios/github.ts'

async function evidence({
  input,
  confirmOnly = false,
}: {
  input: Omit<FakePullRequest, 'number'>
  confirmOnly?: boolean
}) {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-github-evidence-',
  ))
  const previous = {
    fake: process.env.PNYX_FAKE_GITHUB,
    executable: process.env.PNYX_GH_AXI,
  }
  process.env.PNYX_FAKE_GITHUB = root
  process.env.PNYX_GH_AXI = join(
    import.meta.dirname,
    'fixtures/github/gh-axi.sh',
  )
  const url = scriptPullRequest({
    repo: join(
      root,
      'o/r',
    ),
    hydraId: 'r',
    number: 1,
    ...input,
  })

  try {
    return {
      eligibility: confirmOnly ? {
        head: '',
        problems: [] as string[],
      } : await pullRequestMergeEvidence({ url }),
      outcome: await pullRequestMergeOutcome({ url }),
      landing: await pullRequestLanding({ url }).catch(() => undefined),
      state: await pullRequestState({ url }).catch(() => undefined),
      landingSync: pullRequestLandingSync({ url }),
    }
  } finally {
    if (previous.fake === undefined) {
      delete process.env.PNYX_FAKE_GITHUB
    } else {
      process.env.PNYX_FAKE_GITHUB = previous.fake
    }

    if (previous.executable === undefined) {
      delete process.env.PNYX_GH_AXI
    } else {
      process.env.PNYX_GH_AXI = previous.executable
    }

    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  }
}

test(
  'an unbound duplicate and a commit status cannot weaken a required producer identity',
  async () => {
    const { eligibility } = await evidence({
      input: {
        required: [
          {
            context: 'build',
            app: 10,
          },
        ],
        legacy: [{ context: 'build' }],
        statuses: [
          {
            context: 'build',
            state: 'success',
          },
        ],
        runs: [
          {
            name: 'build',
            app: 11,
            conclusion: 'success',
          },
        ],
      },
    })
    assert.deepEqual(
      eligibility.problems,
      ['missing required check: build (app 10)'],
    )
  },
)

test(
  'matching producers and latest successful commit statuses satisfy both requirement sources',
  async () => {
    const { eligibility } = await evidence({
      input: {
        required: [
          {
            context: 'build',
            app: 10,
          },
        ],
        legacy: [{ context: 'legacy-ci' }],
        statuses: [
          {
            context: 'legacy-ci',
            state: 'success',
          },
          {
            context: 'legacy-ci',
            state: 'failure',
          },
        ],
        runs: [
          {
            name: 'build',
            app: 10,
            conclusion: 'success',
          },
        ],
      },
    })
    assert.deepEqual(
      eligibility.problems,
      [],
    )
  },
)

test(
  'successful and failing checks on page two both affect eligibility',
  async () => {
    const required = Array.from(
      { length: 101 },
      (
        _,
        index,
      ) => ({
        context: `check-${index}`,
        app: 10,
      }),
    )
    const runs = required.map(check => ({
      name: check.context,
      app: 10,
      conclusion: 'success',
    }))
    const { eligibility } = await evidence({
      input: {
        required,
        runs,
      },
    })
    assert.deepEqual(
      eligibility.problems,
      [],
    )
    const failing = await evidence({
      input: {
        required,
        runs: runs.map((
          run,
          index,
        ) =>
          ({
            ...run,
            conclusion: index === 100 ? 'failure' : run.conclusion,
          })),
      },
    })
    assert.deepEqual(
      failing.eligibility.problems,
      ['check is not green: check-100'],
    )
  },
)

test(
  'an unreadable requirement source preserves known missing checks from the other source',
  async () => {
    const { eligibility } = await evidence({
      input: {
        unreadable: 'legacy',
        required: [{ context: 'build' }],
      },
    })
    assert.ok(eligibility.problems.some(problem => problem.startsWith('classic protection unreadable:')))
    assert.ok(eligibility.problems.includes('missing required check: build'))
  },
)

test(
  'non-green and pending runs are refused even when the aggregate claims green',
  async () => {
    const { eligibility } = await evidence({
      input: {
        runs: [
          {
            name: 'build',
            app: 10,
            conclusion: 'failure',
          },
          {
            name: 'deploy',
            app: 10,
            conclusion: null,
          },
        ],
      },
    })
    assert.deepEqual(
      eligibility.problems,
      [
        'check is not green: build',
        'check still running: deploy',
      ],
    )
  },
)

test(
  'only a merged pull request with valid head and merge commit returns landing proof',
  async () => {
    const open = await evidence({ input: {} })
    assert.equal(
      open.outcome.outcome,
      'unknown',
    )
    assert.equal(
      open.landing,
      undefined,
    )
    const merged = await evidence({ input: { state: 'merged' } })
    assert.deepEqual(
      merged.landing,
      {
        head: 'a'.repeat(40),
        merge: 'b'.repeat(40),
        branch: 'feature',
        base: 'main',
      },
    )
    assert.deepEqual(
      merged.landingSync,
      merged.landing,
    )
    assert.deepEqual(
      merged.outcome,
      {
        outcome: 'merged',
        head: 'a'.repeat(40),
        commit: 'b'.repeat(40),
      },
    )
    const malformed = await evidence({
      input: {
        state: 'merged',
        merge: 'invalid',
      },
      confirmOnly: true,
    })
    assert.equal(
      malformed.outcome.outcome,
      'unknown',
    )
    assert.equal(
      malformed.landing,
      undefined,
    )
    assert.equal(
      malformed.state,
      undefined,
    )
  },
)

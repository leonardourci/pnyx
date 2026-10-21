import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkPullRequest,
  type Commit,
  type PullRequest,
  withMarker,
} from '../scripts/marker.ts'

const marker = {
  head_sha: 'tested',
  head_tree: 'tree-tested',
  finished_at: '2026-10-21T00:00:00.000Z',
}

// Commits as GitHub would report them: docs -> tested -> base.
const commits: Record<string, Commit> = {
  'docs': {
    tree: 'tree-docs',
    parents: ['tested'],
    files: ['README.md'],
  },
  'code': {
    tree: 'tree-code',
    parents: ['tested'],
    files: [
      'README.md',
      'src/cli/pnyx-axi.ts',
    ],
  },
  'renamed': {
    tree: 'tree-renamed',
    parents: ['tested'],
    files: [
      'notes.md',
      'src/notes.ts',
    ],
  },
  'same-code': {
    tree: 'tree-tested',
    parents: ['base'],
    files: ['src/cli/pnyx-axi.ts'],
  },
  'tested': {
    tree: 'tree-tested',
    parents: ['base'],
    files: ['src/cli/pnyx-axi.ts'],
  },
}

function check({
  body,
  headSha,
  linked = {},
}: {
  body: string
  headSha: string
  linked?: Record<string, PullRequest[]>
}) {
  return checkPullRequest({
    pullRequest: {
      number: 7,
      body,
    },
    headSha,
    commit: async ({ sha }) => commits[sha],
    pullRequestsFor: async ({ sha }) => linked[sha] ?? [],
  })
}

test(
  'the marker passes for the head it names, and a rerun replaces it',
  async () => {
    const body = withMarker({
      body: withMarker({
        body: 'Fix the queue.',
        marker: {
          ...marker,
          head_sha: 'older',
        },
      }),
      marker,
    })

    assert.equal(
      body.split('pnyx-checks').length,
      2,
    )
    assert.ok(body.startsWith('Fix the queue.\n\n<!-- pnyx-checks:v1 '))
    assert.equal(
      await check({
        body,
        headSha: 'tested',
      }),
      'Checks passed for tested.',
    )
  },
)

test(
  'a missing, broken or doubled marker fails',
  async () => {
    for (const body of [
      'No marker here.',
      '<!-- pnyx-checks:v1 {"head_sha":"tested"} -->',
      '<!-- pnyx-checks:v1 not json -->',
      `${withMarker({
        body: '',
        marker,
      })}\n<!-- pnyx-checks:v1 {} -->`,
    ]) {
      await assert.rejects(
        check({
          body,
          headSha: 'tested',
        }),
        /pnpm verify/,
      )
    }
  },
)

test(
  'a later Markdown-only commit or the same code under a new commit keeps the pass',
  async () => {
    const body = withMarker({
      body: '',
      marker,
    })

    assert.match(
      await check({
        body,
        headSha: 'docs',
      }),
      /only Markdown changed after tested/,
    )
    assert.match(
      await check({
        body,
        headSha: 'same-code',
      }),
      /tested the same code\.$/,
    )
  },
)

test(
  'a code change after the run fails, a rename out of code included',
  async () => {
    const body = withMarker({
      body: '',
      marker,
    })

    for (const headSha of [
      'code',
      'renamed',
    ]) {
      await assert.rejects(
        check({
          body,
          headSha,
        }),
        /but the PR head is/,
      )
    }
  },
)

test(
  'another PR that tested the same code lends its pass',
  async () => {
    const linked = {
      tested: [
        {
          number: 7,
          body: '',
        },
        {
          number: 3,
          body: withMarker({
            body: '',
            marker,
          }),
        },
      ],
    }

    assert.match(
      await check({
        body: 'No marker yet.',
        headSha: 'docs',
        linked,
      }),
      /PR #3's run tested the same code, and only Markdown changed after tested/,
    )
  },
)

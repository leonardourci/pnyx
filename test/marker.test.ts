import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkPullRequest,
  type Commit,
  commitFacts,
  MarkerError,
  markerBlockers,
  reviewBlockers,
  type PullRequest,
  withMarker,
} from '../scripts/marker.ts'

const marker = {
  head_sha: 'tested',
  head_tree: 'tree-tested',
  finished_at: '2026-10-21T00:00:00.000Z',
}
const reviews = [
  'review-code',
  'audit-tests',
  'deslop',
].map(name => '- [x] Ran `' + name + '`').join('\n')
const passing = withMarker({
  body: reviews,
  marker,
})

function commitOn({
  tree,
  files,
}: {
  tree: string
  files: string[] | null
}): Commit {
  return {
    tree,
    parents: ['tested'],
    files,
  }
}

// Each head below is one commit on top of `tested`, the commit the run tested.
const commits: Record<string, Commit> = {
  'tested': {
    tree: 'tree-tested',
    parents: ['base'],
    files: ['src/cli/pnyx-axi.ts'],
  },
  'base': {
    tree: 'tree-base',
    parents: [],
    files: ['src/cli/pnyx-axi.ts'],
  },
  'docs': commitOn({
    tree: 'tree-docs',
    files: [
      'README.md',
      '.agents/skills/write-front-end/SKILL.md',
    ],
  }),
  'same-code': {
    tree: 'tree-tested',
    parents: ['base'],
    files: ['src/cli/pnyx-axi.ts'],
  },
  'code': commitOn({
    tree: 'tree-code',
    files: [
      'README.md',
      'src/cli/pnyx-axi.ts',
    ],
  }),
  'shipped-skill': commitOn({
    tree: 'tree-skill',
    files: ['skills/pnyx/SKILL.md'],
  }),
  'fixture': commitOn({
    tree: 'tree-fixture',
    files: ['test/fixtures/firstmate-home/data/backlog.md'],
  }),
  'renamed': commitOn({
    tree: 'tree-renamed',
    files: commitFacts({
      found: {
        commit: { tree: { sha: 'tree-renamed' } },
        parents: [{ sha: 'tested' }],
        files: [
          {
            filename: 'notes.md',
            previous_filename: 'src/notes.ts',
          },
        ],
      },
    }).files,
  }),
  'cut-short': commitOn({
    tree: 'tree-cut',
    files: null,
  }),
}

// 21 docs-only commits on top of `tested`: one more than the walk follows.
for (let i = 1; i <= 21; i++) {
  commits[`docs-${i}`] = {
    tree: `tree-docs-${i}`,
    parents: [i === 1 ? 'tested' : `docs-${i - 1}`],
    files: ['README.md'],
  }
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
    body,
    headSha,
    commit: async ({ sha }) => commits[sha]!,
    pullRequestsFor: async ({ sha }) => linked[sha] ?? [],
  })
}

test(
  'a rerun replaces the marker line and keeps the description, prose about the marker included',
  async () => {
    const prose = 'pnpm verify adds a `<!-- pnyx-checks:v1 ... -->` line.'
    const body = withMarker({
      body: withMarker({
        body: `${prose}\n\n${reviews}`,
        marker: {
          ...marker,
          head_sha: 'older',
        },
      }),
      marker,
    })

    assert.ok(body.startsWith(`${prose}\n\n`))
    assert.equal(
      body.split('\n').filter(line => line.startsWith('<!-- pnyx-checks:v1 ')).length,
      1,
    )
    await check({
      body,
      headSha: 'tested',
    })
  },
)

test(
  'a missing, broken, unclosed or doubled marker fails',
  async () => {
    for (const body of [
      'No marker here.',
      '<!-- pnyx-checks:v1 {"head_sha":"tested"} -->',
      '<!-- pnyx-checks:v1 not json -->',
      `<!-- pnyx-checks:v1 ${JSON.stringify(marker)}`,
      `${passing.replace(
        reviews,
        '',
      )}\n${passing.replace(
        reviews,
        '',
      )}`,
    ]) {
      await assert.rejects(
        check({
          body: `${reviews}\n${body}`,
          headSha: 'tested',
        }),
        MarkerError,
        body,
      )
    }
  },
)

test(
  'docs-only commits after the run and the same code under a new commit keep the pass',
  async () => {
    for (const headSha of [
      'docs',
      'same-code',
      'docs-20',
    ]) {
      await check({
        body: passing,
        headSha,
      })
    }
  },
)

test(
  'code after the run fails: source, shipped skills, fixtures, a rename into Markdown, a cut-short list, a long docs chain',
  async () => {
    for (const headSha of [
      'code',
      'shipped-skill',
      'fixture',
      'renamed',
      'cut-short',
      'docs-21',
    ]) {
      await assert.rejects(
        check({
          body: passing,
          headSha,
        }),
        MarkerError,
        headSha,
      )
    }
  },
)

test(
  'another PR lends its pass only for the tree it tested',
  async () => {
    const lending = {
      number: 3,
      body: passing,
    }

    await check({
      body: reviews,
      headSha: 'docs',
      linked: { tested: [lending] },
    })
    await assert.rejects(
      check({
        body: reviews,
        headSha: 'code',
        linked: { code: [lending] },
      }),
      MarkerError,
    )
  },
)

test(
  'a GitHub API failure fails the check',
  async () => {
    await assert.rejects(
      checkPullRequest({
        body: passing,
        headSha: 'docs',
        commit: async () => {
          throw new MarkerError('HTTP 502')
        },
        pullRequestsFor: async () => [],
      }),
      /HTTP 502/,
    )
  },
)

test(
  'GitHub commit facts count a rename by both paths and a 300-file list as cut short',
  () => {
    const found = {
      commit: { tree: { sha: 't' } },
      parents: [{ sha: 'p' }],
    }

    assert.deepEqual(
      commitFacts({
        found: {
          ...found,
          files: [
            {
              filename: 'notes.md',
              previous_filename: 'src/notes.ts',
            },
          ],
        },
      }).files,
      [
        'notes.md',
        'src/notes.ts',
      ],
    )
    assert.equal(
      commitFacts({
        found: {
          ...found,
          files: Array.from(
            { length: 300 },
            (
              _,
              i,
            ) => ({ filename: `${i}.md` }),
          ),
        },
      }).files,
      null,
    )
  },
)

test(
  'the marker is written only for a passing, clean, unmoved run on the pushed PR head',
  () => {
    const ready = {
      failedSteps: 0,
      changedPaths: 0,
      headSha: 'h',
      headAfter: 'h',
      pullRequestHead: 'h',
      pullRequestBody: reviews,
    }

    assert.deepEqual(
      markerBlockers(ready),
      [],
    )

    for (const change of [
      { failedSteps: 1 },
      {
        pullRequestBody: reviews.replace(
          '[x]',
          '[ ]',
        ),
      },
      { changedPaths: 1 },
      { headAfter: 'moved' },
      { pullRequestHead: undefined },
      { pullRequestHead: 'unpushed' },
    ]) {
      assert.equal(
        markerBlockers({
          ...ready,
          ...change,
        }).length,
        1,
        JSON.stringify(change),
      )
    }
  },
)

test(
  'review completion requires each box once, outside comments and code examples',
  () => {
    assert.deepEqual(
      reviewBlockers({ body: reviews }),
      [],
    )
    assert.deepEqual(
      reviewBlockers({
        body: reviews.replaceAll(
          '[x]',
          '[X]',
        ),
      }),
      [],
    )

    for (const body of [
      '',
      reviews.replace(
        '[x]',
        '[ ]',
      ),
      reviews.replace(
        'review-code',
        'some-other-review',
      ),
      reviews + '\n- [ ] Ran `deslop`',
      reviews + '\n- [x] Ran `deslop`',
      '<!--\n' + reviews + '\n-->',
      '```md\n' + reviews + '\n```',
      '~~~~md\n' + reviews + '\n~~~\n' + reviews + '\n~~~~',
      '    ' + reviews.replaceAll(
        '\n',
        '\n    ',
      ),
    ]) {
      assert.ok(
        reviewBlockers({ body }).length > 0,
        body,
      )
    }
  },
)

test(
  'unchecking a review invalidates an exact-head marker and a borrowed docs pass',
  async () => {
    for (const headSha of [
      'tested',
      'docs',
    ]) {
      await assert.rejects(
        checkPullRequest({
          body: passing.replace(
            '[x]',
            '[ ]',
          ),
          headSha,
          commit: async ({ sha }) => commits[sha]!,
          pullRequestsFor: async () => [
            {
              number: 3,
              body: passing,
            },
          ],
        }),
        /Review checklists incomplete/,
      )
    }
  },
)

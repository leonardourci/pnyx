import assert from 'node:assert/strict'
import test from 'node:test'
import { requiredChecks, mechanicalDeclaration, REVIEW_CHECKLISTS } from './required-checks.ts'
import { checkPullRequest, markerBlockers, withMarker } from './marker.ts'

const rows = [
  {
    paths: ['docs/media/demo.gif'],
    reviews: ['deslop'],
    tests: 'none',
  },
  {
    paths: [
      'README.md',
      '.agents/skills/review-code/SKILL.md',
    ],
    reviews: ['deslop'],
    tests: 'none',
  },
  {
    paths: ['skills/pnyx/SKILL.md'],
    reviews: ['deslop'],
    tests: 'skills',
  },
  {
    paths: ['test/example.test.ts'],
    reviews: ['audit-tests'],
    tests: 'changed',
  },
  {
    paths: ['web/src/app.tsx'],
    reviews: REVIEW_CHECKLISTS,
    tests: 'full',
  },
  {
    paths: ['src/cli/start.ts'],
    reviews: REVIEW_CHECKLISTS,
    tests: 'full',
  },
  {
    paths: ['test/fixtures/input.md'],
    reviews: REVIEW_CHECKLISTS,
    tests: 'full',
  },
  {
    paths: ['test/helper.ts'],
    reviews: REVIEW_CHECKLISTS,
    tests: 'full',
  },
  {
    paths: ['skills/run/tool.sh'],
    reviews: REVIEW_CHECKLISTS,
    tests: 'full',
  },
  {
    paths: [
      'README.md',
      'test/example.test.ts',
    ],
    reviews: [
      'audit-tests',
      'deslop',
    ],
    tests: 'changed',
  },
  {
    paths: [
      'skills/pnyx/SKILL.md',
      'test/example.test.ts',
    ],
    reviews: [
      'audit-tests',
      'deslop',
    ],
    tests: 'skills',
  },
  {
    paths: [
      'README.md',
      'src/run.ts',
    ],
    reviews: REVIEW_CHECKLISTS,
    tests: 'full',
  },
  {
    paths: [],
    reviews: REVIEW_CHECKLISTS,
    tests: 'full',
  },
  {
    paths: null,
    reviews: REVIEW_CHECKLISTS,
    tests: 'full',
  },
]

for (const row of rows) {
  test(
    `policy and marker enforce requirements for ${JSON.stringify(row.paths)}`,
    async () => {
      const policy = requiredChecks({ paths: row.paths })
      assert.deepEqual(
        policy.reviews,
        row.reviews,
      )
      assert.equal(
        policy.tests,
        row.tests,
      )
      const body = REVIEW_CHECKLISTS.map(name => `- [${row.reviews.includes(name) ? 'x' : ' '}] Ran \`${name}\``).join('\n')
      const marker = {
        head_sha: 'head',
        head_tree: 'tree',
        finished_at: new Date(0).toISOString(),
      }
      const ready = {
        failedSteps: 0,
        changedPaths: 0,
        headSha: marker.head_sha,
        headAfter: marker.head_sha,
        pullRequestHead: marker.head_sha,
        pullRequestBody: body,
        requiredReviews: policy.reviews,
      }
      assert.deepEqual(
        markerBlockers(ready),
        [],
      )
      const check = ({ body }: { body: string }) => checkPullRequest({
        body: withMarker({
          body,
          marker,
        }),
        headSha: marker.head_sha,
        files: row.paths,
        commit: async () => {
          throw new Error('An exact head marker needs no commit walk')
        },
        pullRequestsFor: async () => [],
      })
      await check({ body })

      for (const name of row.reviews) {
        const unchecked = body.replace(
          `- [x] Ran \`${name}\``,
          `- [ ] Ran \`${name}\``,
        )
        assert.equal(
          markerBlockers({
            ...ready,
            pullRequestBody: unchecked,
          }).length,
          1,
        )
        await assert.rejects(
          check({ body: unchecked }),
          new RegExp(`complete ${name}`),
        )
      }
    },
  )
}

test(
  'mechanical markers require a visible declaration even after a successful run',
  async () => {
    const marker = {
      head_sha: 'head',
      head_tree: 'tree',
      finished_at: new Date(0).toISOString(),
      mechanical: true,
    }

    for (const declaration of [
      'Change: mechanical (rename)',
      'Change: mechanical (move)',
      '',
      'Change: mechanical (other)',
      '<!-- Change: mechanical (rename) -->',
      '```md\nChange: mechanical (rename)\n```',
      'Change: mechanical (rename)\nChange: mechanical (move)',
    ]) {
      const valid = [
        'Change: mechanical (rename)',
        'Change: mechanical (move)',
      ].includes(declaration)
      const body = `${declaration}\n- [x] Ran \`deslop\``
      assert.equal(
        mechanicalDeclaration({ body }),
        valid,
      )
      const check = () => checkPullRequest({
        body: withMarker({
          body,
          marker,
        }),
        headSha: marker.head_sha,
        files: ['src/run.ts'],
        commit: async () => {
          throw new Error('unexpected walk')
        },
        pullRequestsFor: async () => [],
      })

      if (valid) {
        await check()
      } else {
        await assert.rejects(
          check(),
          /Mechanical verification requires/,
        )
      }
    }

    for (const row of rows) {
      const policy = requiredChecks({
        paths: row.paths,
        mechanical: true,
      })
      assert.deepEqual(
        policy.reviews,
        ['deslop'],
      )
      assert.equal(
        policy.tests,
        'full',
      )
    }
  },
)

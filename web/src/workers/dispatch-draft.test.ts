import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergePatch, type DispatchDocument } from '#workers/dispatch-check.ts'
import { candidateMarks, changesBetween, documentOf, draftIssues, issuesAt, patchBetween, ruleSegments, toDraft, withCandidates, withNewRule, withRule, withoutRule, type Draft } from './dispatch-draft.ts'

const SAVED: DispatchDocument = {
  rules: {
    hydra: {
      when: 'Hydra itself',
      candidates: [{ harness: 'claude' }],
    },
    build: {
      when: 'Well-defined implementation',
      candidates: [
        {
          harness: 'claude',
          model: 'claude-opus-5-5',
          effort: 'high',
        },
        {
          harness: 'codex',
          effort: 'high',
        },
      ],
    },
    docs: {
      when: 'Documentation',
      candidates: [{ harness: 'codex' }],
    },
  },
  default: [{ harness: 'claude' }],
  main: 'claude:personal',
  workers: { claude: ['claude:personal'] },
  projects: {},
  accounts: {
    'claude:personal': {
      provider: 'claude',
      folder: '~/.claude',
    },
  },
}

const draft = () => toDraft({ document: structuredClone(SAVED) })!

const build = 1

const roundTrip = ({ edited }: { edited: Draft }) => {
  const patch = patchBetween({
    before: SAVED,
    after: documentOf({ draft: edited }),
  })
  assert.deepEqual(
    mergePatch({
      target: SAVED,
      patch,
    }),
    documentOf({ draft: edited }),
  )

  return patch
}

test(
  'table edits become the merge patch that names only what changed, and applying it gives the draft',
  () => {
    assert.deepEqual(
      roundTrip({ edited: draft() }),
      {},
    )

    const effort = withCandidates({
      draft: draft(),
      rule: build,
      candidates: [
        SAVED.rules.build!.candidates[0]!,
        {
          harness: 'codex',
          effort: 'xhigh',
        },
      ],
    })
    assert.deepEqual(
      roundTrip({ edited: effort }),
      {
        rules: {
          build: {
            candidates: [
              SAVED.rules.build!.candidates[0],
              {
                harness: 'codex',
                effort: 'xhigh',
              },
            ],
          },
        },
      },
    )

    const renamed = withRule({
      draft: withRule({
        draft: draft(),
        rule: build,
        change: { name: 'implement' },
      }),
      rule: build,
      change: { when: 'Clear implementation' },
    })
    assert.deepEqual(
      roundTrip({ edited: renamed }),
      {
        rules: {
          build: null,
          implement: {
            when: 'Clear implementation',
            candidates: SAVED.rules.build!.candidates,
          },
        },
      },
    )
    assert.deepEqual(
      Object.keys(documentOf({ draft: renamed }).rules),
      [
        'hydra',
        'implement',
        'docs',
      ],
    )

    assert.deepEqual(
      roundTrip({
        edited: withCandidates({
          draft: withoutRule({
            draft: draft(),
            rule: 2,
          }),
          rule: 'default',
          candidates: [{ harness: 'codex' }],
        }),
      }),
      {
        rules: { docs: null },
        default: [{ harness: 'codex' }],
      },
    )
  },
)

test(
  'a new rule needs its when, a shared name is an error at that rule, and each cell is marked changed or red',
  () => {
    const added = withNewRule({ draft: withNewRule({ draft: draft() }) })
    assert.deepEqual(
      added.rules.slice(-2).map(rule => rule.name),
      [
        'new-rule',
        'new-rule-2',
      ],
    )
    assert.deepEqual(
      issuesAt({
        issues: draftIssues({ draft: added }),
        segments: [
          'rules',
          'new-rule',
        ],
        under: true,
      }).map(issue => issue.path),
      [
        '/rules/new-rule/when',
        '/rules/new-rule/candidates',
      ],
    )

    const shared = withRule({
      draft: draft(),
      rule: 2,
      change: { name: 'build' },
    })
    assert.deepEqual(
      issuesAt({
        issues: draftIssues({ draft: shared }),
        segments: [
          'rules',
          'build',
        ],
      }).filter(issue => issue.level === 'error')
        .map(issue => issue.problem),
      ['two rules are named build'],
    )

    const broken = withCandidates({
      draft: draft(),
      rule: build,
      candidates: [
        {
          harness: 'claude',
          model: 'claude-opus-5-5',
          effort: 'ultra',
        },
        {
          harness: 'claude',
          effort: 'high',
        },
      ],
    })
    const issues = draftIssues({ draft: broken })
    const segments = ruleSegments({ name: 'build' })
    assert.deepEqual(
      candidateMarks({
        saved: SAVED.rules.build!.candidates[0],
        candidate: broken.rules[build]!.candidates[0]!,
        issues,
        segments: [
          ...segments,
          '0',
        ],
      }),
      {
        model: {
          changed: false,
          invalid: false,
        },
        effort: {
          changed: true,
          invalid: true,
        },
        mode: {
          changed: false,
          invalid: false,
        },
        fast: {
          changed: false,
          invalid: false,
        },
      },
    )
    assert.equal(
      candidateMarks({
        saved: SAVED.rules.build!.candidates[1],
        candidate: broken.rules[build]!.candidates[1]!,
        issues,
        segments: [
          ...segments,
          '1',
        ],
      }).model.changed,
      true,
    )
  },
)

test(
  'the JSON view lists exactly what a deletion removes, and a document the table cannot show stays in JSON',
  () => {
    const edited = structuredClone(SAVED) as unknown as Record<string, Record<string, unknown>>
    delete edited.rules!.docs
    delete edited.accounts!['claude:personal']
    edited.accounts!['codex:work'] = {
      provider: 'codex',
      folder: '~/.codex-work',
    }
    const changes = changesBetween({
      before: SAVED,
      after: edited,
    })
    assert.deepEqual(
      changes.map(change => change.path),
      [
        '/rules/docs',
        '/accounts/claude:personal',
        '/accounts/codex:work',
      ],
    )
    assert.deepEqual(
      changes[0]!.before,
      SAVED.rules.docs,
    )

    assert.equal(
      toDraft({
        document: {
          ...SAVED,
          rules: { build: { when: 'x' } },
        },
      }),
      undefined,
    )
    assert.equal(
      toDraft({
        document: {
          ...SAVED,
          default: 'claude',
        },
      }),
      undefined,
    )
  },
)

test(
  'a JSON candidate with an unknown harness stays in JSON instead of opening a broken model picker',
  () => {
    assert.equal(
      toDraft({
        document: {
          ...SAVED,
          default: [{ harness: 'unknown' }],
        },
      }),
      undefined,
    )
    assert.equal(
      toDraft({
        document: {
          ...SAVED,
          rules: {
            broken: {
              when: 'Build',
              candidates: [{}],
            },
          },
        },
      }),
      undefined,
    )
  },
)

test(
  'duplicate candidate add/edit marks its model/account field and blocks the draft until repaired',
  () => {
    const initial = draft()
    const add = withCandidates({
      draft: initial,
      rule: 'default',
      candidates: [
        { harness: 'claude' },
        {
          harness: 'claude',
          model: 'sonnet',
        },
      ],
    })
    const issues = draftIssues({ draft: add })
    assert.ok(issues.some(issue => issue.path === '/default/1/account' && issue.level === 'error'))
    assert.equal(
      candidateMarks({
        candidate: add.default[1]!,
        issues,
        segments: [
          'default',
          '1',
        ],
      }).model.invalid,
      true,
    )
    const valid = withCandidates({
      draft: add,
      rule: 'default',
      candidates: [
        { harness: 'claude' },
        {
          harness: 'claude',
          account: 'claude:personal',
          model: 'sonnet',
        },
      ],
    })
    assert.equal(
      draftIssues({ draft: valid }).some(issue => issue.path === '/default/1/account'),
      false,
    )
    const repaired = withCandidates({
      draft: add,
      rule: 'default',
      candidates: [add.default[0]!],
    })
    assert.equal(
      draftIssues({ draft: repaired }).some(issue => issue.path.includes('/default/')),
      false,
    )
  },
)

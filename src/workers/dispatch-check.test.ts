import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDispatch, mergePatch, outOfDate, patchChanges } from './dispatch-check.ts'

const ACCOUNTS = {
  'claude:main': {
    provider: 'claude',
    folder: '~/.claude',
  },
  'codex:work': {
    provider: 'codex',
    folder: '/logins/codex',
  },
}

const found = ({ document }: { document: unknown }) => checkDispatch({ document })
  .map(issue => `${issue.level} ${issue.path}`)

test(
  'the checker reports every problem at once, each at its path',
  () => {
    assert.deepEqual(
      found({
        document: {
          rules: {
            build: {
              when: 'Implementation',
              candidates: [
                {
                  harness: 'claude',
                  effort: 'ultra',
                  mode: 'on-request',
                },
                {
                  harness: 'codex',
                  effort: 'max',
                  mode: 'plan',
                  speed: 'fast',
                },
              ],
            },
            default: {
              when: 'Anything',
              candidates: [{ harness: 'claude' }],
            },
            empty: {
              when: ' ',
              candidates: [],
            },
          },
          main: 'claude:gone',
          workers: {
            claude: [
              'codex:work',
              'claude:main',
              'claude:main',
            ],
          },
          projects: { 'relative/path': { codex: ['codex:work'] } },
          accounts: {
            ...ACCOUNTS,
            'gemini:x': {
              provider: 'gemini',
              folder: 'logins',
            },
          },
          extra: true,
        },
      }),
      [
        'error /extra',
        'error /accounts/gemini:x/provider',
        'error /accounts/gemini:x/folder',
        'error /rules/build/candidates/0/effort',
        'error /rules/build/candidates/0/mode',
        'error /rules/build/candidates/1/speed',
        'error /rules/build/candidates/1/effort',
        'error /rules/build/candidates/1/mode',
        'error /rules/default',
        'error /rules/empty/when',
        'error /rules/empty/candidates',
        'error /default',
        'error /main',
        'error /workers/claude/0',
        'error /workers/claude/2',
        'error /projects/relative~1path',
      ],
    )
  },
)

test(
  'warnings name a model no login offers, a rule no worker can start and a missing login folder, without blocking',
  () => {
    const issues = checkDispatch({
      document: {
        rules: {
          docs: {
            when: 'Documentation',
            candidates: [
              {
                harness: 'codex',
                model: 'gpt-0',
              },
            ],
          },
          build: {
            when: 'Implementation',
            candidates: [
              {
                harness: 'claude',
                model: 'opus[1m]',
              },
            ],
          },
        },
        default: [{ harness: 'claude' }],
        main: 'claude:main',
        workers: { claude: ['claude:main'] },
        accounts: ACCOUNTS,
      },
      catalog: {
        claude: ['opus'],
        codex: ['gpt-6.1-sol'],
      },
      exists: ({ folder }) => folder !== '/logins/codex',
    })
    assert.deepEqual(
      issues.map(issue => `${issue.level} ${issue.path}: ${issue.problem}`),
      [
        'warning /accounts/codex:work/folder: login folder /logins/codex does not exist',
        'warning /rules/docs/candidates/0/model: codex does not offer model gpt-0 now',
        'warning /rules/docs: no candidate has a worker account, so this rule cannot start',
      ],
    )
  },
)

test(
  'with no registered accounts, workers run on the harness logins and account names are not checked',
  () => {
    assert.deepEqual(
      found({
        document: {
          main: 'claude:default',
          workers: { claude: ['claude:default'] },
          rules: {
            build: {
              when: 'Implementation',
              candidates: [{ harness: 'codex' }],
            },
          },
          default: [{ harness: 'claude' }],
          accounts: {},
        },
      }),
      [],
    )
  },
)

test(
  'a merge patch merges objects, replaces lists and removes null keys, and its changes go out of date once a value moves',
  () => {
    const document = {
      rules: {
        build: {
          when: 'Implementation',
          candidates: [{ harness: 'claude' }],
        },
        docs: {
          when: 'Documentation',
          candidates: [{ harness: 'codex' }],
        },
      },
      workers: { claude: ['claude:main'] },
      projects: {},
    }
    const patch = {
      rules: {
        build: { candidates: [{ harness: 'codex' }] },
        docs: null,
      },
      workers: { claude: ['claude:main'] },
      projects: { '/work/app': { codex: ['codex:work'] } },
    }
    assert.deepEqual(
      mergePatch({
        target: document,
        patch,
      }),
      {
        rules: {
          build: {
            when: 'Implementation',
            candidates: [{ harness: 'codex' }],
          },
        },
        workers: { claude: ['claude:main'] },
        projects: { '/work/app': { codex: ['codex:work'] } },
      },
    )
    const changes = patchChanges({
      document,
      patch,
    })
    assert.deepEqual(
      changes,
      [
        {
          path: '/rules/build/candidates',
          before: [{ harness: 'claude' }],
          after: [{ harness: 'codex' }],
        },
        {
          path: '/rules/docs',
          before: {
            when: 'Documentation',
            candidates: [{ harness: 'codex' }],
          },
          after: undefined,
        },
        {
          path: '/projects/~1work~1app',
          before: undefined,
          after: { codex: ['codex:work'] },
        },
      ],
    )
    assert.equal(
      outOfDate({
        document: {
          ...document,
          workers: { claude: ['claude:other'] },
        },
        changes,
      }),
      false,
    )
    assert.equal(
      outOfDate({
        document: mergePatch({
          target: document,
          patch: {
            rules: {
              build: {
                candidates: [
                  { harness: 'claude' },
                  { harness: 'codex' },
                ],
              },
            },
          },
        }),
        changes,
      }),
      true,
    )
  },
)

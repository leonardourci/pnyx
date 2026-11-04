import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EffectiveDispatch } from './dispatch-config.ts'
import { checkDispatch } from './dispatch-check.ts'
import { chooseCandidate, chosenSettings, validateChoice } from './dispatch.ts'
import { harnessAccount } from './account-choice.ts'
import { accountRegistration } from './account-choice.ts'
import { DEFAULT_SETTINGS, patchSettings } from '#settings/settings.ts'

const config = (): EffectiveDispatch => ({
  accounts: {
    personal: {
      provider: 'claude',
      folder: '/synthetic/personal',
      label: 'Personal',
    },
    work: {
      provider: 'claude',
      folder: '/synthetic/work',
      label: 'Work',
    },
    codex: {
      provider: 'codex',
      folder: '/synthetic/codex',
    },
  },
  dispatch: {
    main: 'personal',
    default: [
      {
        harness: 'claude',
        account: 'work',
        model: 'sonnet',
      },
    ],
    rules: {},
    projects: {},
    workers: {
      claude: ['personal'],
      codex: ['codex'],
    },
  },
})

test(
  'a named worker account uses only its own home, independently of the default order',
  async () => {
    const effective = config()
    const homes: string[] = []
    const choice = await chooseCandidate({
      config: effective,
      offers: { claude: ['model-only-on-personal'] },
      quota: ({ account }) => {
        homes.push(account.folder)

        return { auth: 'usable' }
      },
    })
    assert.equal(
      choice.account,
      'work',
    )
    assert.deepEqual(
      homes,
      ['/synthetic/work'],
    )
    assert.equal(
      validateChoice({
        value: choice,
        config: effective,
      }).folder,
      '/synthetic/work',
    )
    assert.deepEqual(
      chosenSettings({ choice }),
      { model: 'sonnet' },
    )

    await assert.rejects(
      () => chooseCandidate({
        config: effective,
        quota: () => ({ auth: 'signed-out' }),
      }),
      /work is signed out/,
    )
  },
)

test(
  'an explicit account override chooses its provider and never falls back to a different account',
  async () => {
    const effective = config()
    const choice = await chooseCandidate({
      config: effective,
      override: { account: 'codex' },
      quota: () => ({ auth: 'usable' }),
    })
    assert.equal(
      choice.provider,
      'codex',
    )
    assert.equal(
      choice.account,
      'codex',
    )
    assert.equal(
      validateChoice({
        value: choice,
        config: effective,
      }).account,
      'codex',
    )
    assert.equal(
      'account' in chosenSettings({ choice }),
      false,
    )
    await assert.rejects(
      () => chooseCandidate({
        config: effective,
        override: { account: 'missing' },
      }),
      /not registered/,
    )
    await assert.rejects(
      () => chooseCandidate({
        config: effective,
        harness: 'claude',
        override: { account: 'codex' },
      }),
      /not registered/,
    )
    assert.throws(
      () => harnessAccount({
        effective,
        harness: 'claude',
        prefer: 'codex',
      }),
      /not registered/,
    )
  },
)

test(
  'dispatch validation checks account references and keeps legacy candidates valid',
  () => {
    const effective = config()
    const document = {
      ...effective.dispatch,
      accounts: effective.accounts,
    }
    assert.equal(
      checkDispatch({ document }).some(issue => issue.level === 'error'),
      false,
    )
    document.default[0]!.account = 'codex'
    assert.ok(checkDispatch({ document }).some(issue => issue.path === '/default/0/account' && issue.problem.includes('codex account')))
    delete document.default[0]!.account
    assert.equal(
      checkDispatch({ document }).some(issue => issue.level === 'error'),
      false,
    )
  },
)

test(
  'helper configuration retains its independent account and existing auto/off settings',
  () => {
    const helper = {
      harness: 'claude',
      account: 'work',
      model: 'sonnet',
      effort: 'low',
    }
    assert.deepEqual(
      patchSettings({
        current: DEFAULT_SETTINGS,
        input: { helper },
      }).helper,
      helper,
    )
    assert.equal(
      patchSettings({
        current: DEFAULT_SETTINGS,
        input: { helper: 'off' },
      }).helper,
      'off',
    )
    assert.equal(
      patchSettings({
        current: DEFAULT_SETTINGS,
        input: { helper: 'auto' },
      }).helper,
      'auto',
    )
    assert.throws(
      () => patchSettings({
        current: DEFAULT_SETTINGS,
        input: {
          helper: {
            ...helper,
            account: '../other',
          },
        },
      }),
      /helper account/,
    )
  },
)

test(
  'registering the first account preserves implicit native logins and their main/worker choices',
  () => {
    const effective = config()
    effective.fallback = true
    const account = {
      provider: 'claude' as const,
      folder: '/synthetic/second',
      label: 'Second',
    }
    const patch = accountRegistration({
      effective,
      name: 'second',
      account,
    })
    assert.deepEqual(
      patch.accounts,
      {
        ...effective.accounts,
        second: account,
      },
    )
    assert.equal(
      patch.main,
      effective.dispatch.main,
    )
    assert.deepEqual(
      patch.workers,
      effective.dispatch.workers,
    )
    assert.equal(
      'rules' in patch,
      false,
    )
    delete effective.fallback
    assert.deepEqual(
      accountRegistration({
        effective,
        name: 'second',
        account,
      }),
      { accounts: { second: account } },
    )
  },
)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type UpgradeOperation, upgradeMilestone, upgradeMilestoneIcon } from './model.ts'

const operation = ({
  state,
  ...rest
}: Pick<UpgradeOperation, 'state'> & Partial<UpgradeOperation>): UpgradeOperation => ({
  id: 'up',
  folder: '~/pnyx',
  queuedAt: '2026-01-01T00:00:00.000Z',
  steps: [
    {
      step: 'pull',
      state: 'done',
      seconds: 1,
    },
  ],
  state,
  ...rest,
})

// The line the chat shows for an upgrade in this state, and the icon drawn beside it.
const shown = ({
  state,
  ...rest
}: Parameters<typeof operation>[0]) => {
  const text = upgradeMilestone({
    operation: operation({
      state,
      ...rest,
    }),
  })

  return text === undefined ? undefined : `${upgradeMilestoneIcon({ text })}: ${text}`
}

test(
  'an upgrade\'s milestone names how far it got, with the commit once it finished, and each state draws its own icon',
  () => {
    assert.deepEqual(
      [
        shown({ state: 'queued' }),
        shown({ state: 'running' }),
        shown({ state: 'waiting' }),
        shown({ state: 'restarting' }),
        shown({
          state: 'done',
          to: '0123456789abcdef',
        }),
        shown({ state: 'done' }),
        shown({ state: 'current' }),
        shown({ state: 'failed' }),
        shown({ state: 'refused' }),
        shown({ state: 'stopped' }),
      ],
      [
        undefined,
        'upgrade: Upgrade started',
        'upgrade: Upgrade started',
        'upgrade: Upgrade started',
        'check: Upgraded to 0123456',
        'check: Upgraded',
        'check: Already up to date',
        'error: Upgrade failed',
        'error: Upgrade not started',
        'stop: Upgrade stopped',
      ],
    )
  },
)

test(
  'a /restart has no upgrade milestone, and other chat lines draw no upgrade icon',
  () => {
    assert.equal(
      shown({
        state: 'done',
        steps: [
          {
            step: 'restart',
            state: 'done',
            seconds: 0,
          },
        ],
      }),
      undefined,
    )
    assert.equal(
      upgradeMilestoneIcon({ text: 'Restarted' }),
      undefined,
    )
  },
)

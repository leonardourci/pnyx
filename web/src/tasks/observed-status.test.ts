import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import type { Card } from '#tasks/model.ts'
import type { NativeWork } from '#workers/provider.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { cardState, filterCards } from './view.ts'
import { taskReferences } from './task-references.ts'

const at = '2026-10-29T12:00:00Z'
const now = Date.parse(at)
const card: Card = {
  project: 'weather-station',
  id: 'task-synthetic',
  key: 'synthetic',
  title: 'Package release',
  column: 'in_progress',
  workspace: 'unassigned',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  createdSeq: 1,
  updatedSeq: 1,
  revision: 1,
  updatedAt: at,
  agent: {
    provider: 'codex',
    sessionId: 'synthetic',
  },
  activity: 'finished',
}
const idle: NativeWork = {
  runningTurns: [],
  runningTools: [],
  unsettledInputs: [],
  pendingControls: [],
  queue: {
    knowledge: 'known',
    count: 0,
  },
  background: {
    knowledge: 'known',
    tasks: [],
  },
}
const action: CurrentAction = {
  calls: [],
  done: true,
  work: idle,
}
const link = {
  kind: 'github_pr' as const,
  url: 'https://example.test/pull/1',
  state: 'open' as const,
  checkedAt: at,
  checks: '1 passed, 0 failed, 0 skipped, 2 total',
}

test(
  'worker declarations never choose a badge; only known settled native work shows Idle',
  () => {
    assert.equal(
      cardState({
        card,
        now,
        action,
      }).text,
      'idle',
    )
    assert.equal(
      cardState({
        card,
        now,
      }).text,
      'activity unknown',
    )
    assert.equal(
      cardState({
        card,
        now,
        action: {
          ...action,
          work: {
            ...idle,
            background: {
              knowledge: 'unknown',
              reason: 'not observable',
            },
          },
        },
      }).text,
      'activity unknown',
    )

    for (const state of [
      'paused',
      'blocked',
      'needs_you',
      'working',
      'done',
    ] as const) {
      const declared = {
        ...card,
        status: {
          id: 'note',
          state,
          note: 'Waiting for CI',
          actor: 'worker:test',
          at,
        },
      }
      assert.equal(
        cardState({
          card: declared,
          now,
          action,
        }).text,
        'idle',
      )
      assert.equal(
        declared.status.state,
        state,
      )
    }
  },
)

test(
  'owner questions and answer delivery outrank active work and CI',
  () => {
    const asked: Card = {
      ...card,
      activity: 'working',
      links: [link],
      asks: [
        {
          id: 'question',
          at,
          actor: 'worker:test',
          audience: 'owner',
          question: 'Ship?',
        },
      ],
    }
    assert.equal(
      cardState({
        card: asked,
        now,
        action,
      }).text,
      'waiting for you',
    )
    const answered: Card = {
      ...asked,
      asks: asked.asks,
      replies: [
        {
          id: 'answer',
          route: 'session',
          state: 'delivery_unknown',
          answers: 'question',
        },
      ],
    }
    assert.equal(
      cardState({
        card: answered,
        now,
        action,
      }).text,
      'answer delivery uncertain',
    )
    assert.equal(
      cardState({
        card: {
          ...asked,
          asks: [],
          permissions: [
            {
              id: 'permission',
              at,
              session: 'synthetic',
              tool: 'Shell',
              input: {},
              status: 'pending',
            },
          ],
        },
        now,
        action,
      }).text,
      'waiting for you',
    )
  },
)

test(
  'observed tools and background work outrank passive checks; completed tools disappear',
  () => {
    const running: CurrentAction = {
      calls: [
        {
          id: 'shell',
          tool: 'Shell',
        },
      ],
      done: false,
      work: {
        ...idle,
        runningTurns: ['turn'],
        runningTools: ['shell'],
      },
    }
    const linked = {
      ...card,
      links: [link],
    }
    assert.equal(
      cardState({
        card: linked,
        now,
        action: running,
      }).text,
      'running Shell',
    )
    assert.match(
      cardState({
        card: linked,
        now,
        action: running,
      }).details,
      /waiting for CI \(observed/,
    )
    assert.equal(
      cardState({
        card: linked,
        now,
        action,
      }).text,
      'waiting for CI',
    )
    assert.equal(
      cardState({
        card,
        now,
        action: {
          ...action,
          work: {
            ...idle,
            background: {
              knowledge: 'known',
              tasks: [
                {
                  id: 'job',
                  type: 'shell',
                },
              ],
            },
          },
        },
      }).text,
      'running background work',
    )
    assert.equal(
      cardState({
        card: {
          ...card,
          activity: 'ended',
        },
        now,
        action: running,
      }).kind,
      'stopped',
    )
  },
)

test(
  'check failures outrank pending checks; unknown checks stay explicit',
  () => {
    assert.equal(
      cardState({
        card: {
          ...card,
          links: [
            link,
            {
              ...link,
              url: 'https://example.test/pull/2',
              checks: '0 passed, 1 failed, 0 skipped, 1 total',
            },
          ],
        },
        now,
        action,
      }).text,
      'checks failed',
    )
    assert.equal(
      cardState({
        card: {
          ...card,
          links: [
            {
              ...link,
              checks: undefined,
              checkedAt: undefined,
            },
          ],
        },
        now,
        action,
      }).text,
      'checks unknown',
    )
    assert.equal(
      cardState({
        card: {
          ...card,
          links: [
            {
              ...link,
              state: 'merged',
            },
          ],
        },
        now,
        action,
      }).text,
      'idle',
    )
    assert.equal(
      cardState({
        card: {
          ...card,
          links: [
            {
              ...link,
              checks: undefined,
            },
            link,
          ],
        },
        now,
        action,
      }).text,
      'waiting for CI',
    )
  },
)

test(
  'Hydra questions, prerequisites and queues have deterministic reasons',
  () => {
    assert.equal(
      cardState({
        card: {
          ...card,
          asks: [
            {
              id: 'question',
              at,
              actor: 'worker:test',
              audience: 'hydra',
              question: 'Which scope?',
            },
          ],
        },
        now,
        action,
      }).text,
      'waiting for Hydra',
    )
    const state = emptyHydra()
    state.cards = {
      [card.id]: {
        ...card,
        prerequisites: ['dependency'],
      },
      dependency: {
        ...card,
        id: 'dependency',
        title: 'API contract',
        agent: undefined,
      },
    }
    state.cards[card.id]!.links = [
      {
        ...link,
        checks: undefined,
      },
    ]
    assert.equal(
      cardState({
        card: state.cards[card.id]!,
        state,
        now,
        action,
      }).text,
      'waiting for API contract',
    )
    assert.equal(
      cardState({
        card: {
          ...card,
          queue: {
            session: 'codex:other',
            rank: 1,
          },
        },
        now,
        action,
      }).text,
      'queued',
    )
  },
)

test(
  'search and task reference labels match the visible badge',
  () => {
    const state = emptyHydra()
    state.cards[card.id] = {
      ...card,
      links: [link],
    }
    assert.equal(
      taskReferences({
        state,
        now,
        actions: { [card.id]: action },
      })[card.id]?.state,
      'Waiting for CI',
    )
    assert.deepEqual(
      filterCards({
        state,
        workspace: '',
        tag: '',
        query: 'waiting CI',
      }).map(card => card.id),
      ['task-synthetic'],
    )
    assert.deepEqual(
      filterCards({
        state,
        workspace: '',
        tag: '',
        query: 'paused',
      }),
      [],
    )
  },
)

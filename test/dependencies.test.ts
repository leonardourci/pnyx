import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskReadiness } from '../src/core/dependencies.ts'
import { wakeReasons } from '../src/core/wake-reasons.ts'
import { emptyHydra } from '../src/core/reducer.ts'
import type { Card, HydraEvent, TaskStatus } from '../src/core/model.ts'

const AT = '2026-10-23T10:00:00.000Z'
const task = ({
  id,
  prerequisites = [],
  status = 'done',
}: {
  id: string
  prerequisites?: string[]
  status?: TaskStatus
}): Card => ({
  id,
  key: id,
  title: id,
  prerequisites,
  status: {
    id: `status-${id}`,
    at: AT,
    actor: 'cli',
    state: status,
    note: '',
  },
  workspace: '',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  column: 'queued',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: AT,
})

test(
  'accepted completion with an unanswered owner gate still blocks dependents',
  () => {
    const prerequisite = task({ id: 'base' })
    const dependent = task({
      id: 'client',
      prerequisites: ['base'],
      status: 'working',
    })
    const state = {
      ...emptyHydra(),
      cards: {
        base: prerequisite,
        client: dependent,
      },
    }
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      true,
    )
    prerequisite.attention = [
      {
        key: 'permission',
        kind: 'permission',
        blocking: true,
        text: 'Allow write?',
      },
    ]
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      false,
    )
    assert.match(
      taskReadiness({
        state,
        card: dependent,
      }).reasons.join(),
      /waiting for the owner/,
    )
    prerequisite.attention = []
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      true,
    )
  },
)

test(
  'transitive reopening blocks the named prerequisite and malformed replay cycles fail closed',
  () => {
    const base = task({
      id: 'base',
      status: 'blocked',
    })
    const middle = task({
      id: 'middle',
      prerequisites: ['base'],
    })
    const dependent = task({
      id: 'client',
      prerequisites: ['middle'],
      status: 'working',
    })
    const state = {
      ...emptyHydra(),
      cards: {
        base,
        middle,
        client: dependent,
      },
    }
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      false,
    )
    base.status!.state = 'done'
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      true,
    )
    base.prerequisites = ['client']
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      false,
    )
    assert.match(
      taskReadiness({
        state,
        card: dependent,
      }).reasons.join(),
      /dependency cycle/,
    )
  },
)

test(
  'a declared build with an open PR and an investigation without a report remain unmet',
  () => {
    const base = task({ id: 'base' })
    const dependent = task({
      id: 'client',
      prerequisites: ['base'],
    })
    const state = {
      ...emptyHydra(),
      cards: {
        base,
        client: dependent,
      },
    }
    base.links = [
      {
        kind: 'github_pr',
        url: 'https://github.com/example/app/pull/1',
        state: 'open',
      },
    ]
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      false,
    )
    base.landing = {
      landing: 'branch',
      merge: 'owner',
    }
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      true,
    )
    delete base.landing
    base.links[0]!.state = 'merged'
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      true,
    )
    base.status!.state = 'working'
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      false,
    )
    base.status!.state = 'done'
    base.kind = 'investigation'
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      false,
    )
    base.report = {
      id: 'report',
      at: AT,
      actor: 'cli',
      chars: 10,
    }
    assert.equal(
      taskReadiness({
        state,
        card: dependent,
      }).ready,
      true,
    )
  },
)

test(
  'progress, unchanged declarations and check refreshes keep prerequisite waits quiet',
  () => {
    const base = task({
      id: 'base',
      status: 'working',
    })
    const dependent = task({
      id: 'client',
      prerequisites: ['base'],
      status: 'working',
    })
    const hydra = task({ id: '$hydra' })
    hydra.agent = {
      provider: 'claude',
      sessionId: 'hydra',
      host: 'pnyx',
    }
    const state = {
      ...emptyHydra(),
      cards: {
        base,
        client: dependent,
        $hydra: hydra,
      },
    }
    const eventBase = {
      v: state.v,
      seq: 2,
      id: 'progress',
      at: AT,
      actor: 'worker:base',
      cardId: base.id,
    }
    base.statusLog = [
      base.status!,
      {
        ...base.status!,
        id: 'repeat',
      },
    ]
    base.status = base.statusLog[1]
    const events: HydraEvent[] = [
      {
        ...eventBase,
        id: 'repeat',
        type: 'task.declared',
        data: {
          state: 'working',
          note: 'Still implementing',
        },
      },
      {
        ...eventBase,
        type: 'hydra.message',
        data: {
          task: base.id,
          hydra: 'lab',
          action: 'worker',
          kind: 'progress',
          text: 'Still implementing',
        },
      },
      {
        ...eventBase,
        id: 'activity',
        type: 'card.pushed',
        data: {
          key: base.key,
          activity: 'working',
          before: { activity: 'working' },
        },
      },
      {
        ...eventBase,
        id: 'checks',
        type: 'card.linked',
        data: {
          url: 'https://github.com/example/app/pull/1',
          before: {
            kind: 'github_pr',
            url: 'https://github.com/example/app/pull/1',
            state: 'open',
            checks: '0 passed, 0 failed, 1 total',
          },
          after: {
            kind: 'github_pr',
            url: 'https://github.com/example/app/pull/1',
            state: 'open',
            checks: '1 passed, 0 failed, 2 total',
          },
        },
      },
    ]
    assert.equal(
      wakeReasons({
        state,
        events,
      }).filter(line => line.includes('prerequisite:')).length,
      0,
    )
  },
)

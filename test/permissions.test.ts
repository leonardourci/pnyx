import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePush } from '../src/core/decide.ts'
import { permissionEvent } from '../src/core/permissions.ts'
import { emptyHydra, reduce, replay } from '../src/core/reducer.ts'
import type { HydraEvent, PermissionRequest } from '../src/core/model.ts'

const meta = {
  at: '2026-10-15T12:00:00Z',
  actor: 'fixture',
}
const created: HydraEvent = {
  v: 1,
  seq: 1,
  id: 'create',
  ...meta,
  cardId: 'task',
  type: 'task.created',
  data: {
    key: 'task',
    title: 'Permission task',
    column: 'in_progress',
  },
}
const request: PermissionRequest = {
  id: 'request',
  session: 'claude-code:session',
  tool: 'Bash',
  input: { command: 'pwd' },
  status: 'pending',
}

test(
  'permission replay keeps the first decision, its original input and the column',
  () => {
    const initial = reduce({
      state: emptyHydra(),
      event: created,
    })
    const pending = permissionEvent({
      state: initial,
      card: initial.cards.task!,
      request,
      meta,
    })
    const waiting = reduce({
      state: initial,
      event: pending,
    })
    const allowed = permissionEvent({
      state: waiting,
      card: waiting.cards.task!,
      request: {
        ...request,
        status: 'allow',
      },
      meta,
    })
    const after = reduce({
      state: waiting,
      event: allowed,
    })
    const late = permissionEvent({
      state: after,
      card: after.cards.task!,
      request: {
        ...request,
        status: 'deny',
        input: { command: 'other' },
      },
      meta,
    })
    const state = replay({
      state: emptyHydra(),
      events: [
        created,
        pending,
        allowed,
        late,
      ],
    })
    assert.deepEqual(
      state.cards.task!.permissions,
      [
        {
          ...request,
          status: 'allow',
          at: meta.at,
        },
      ],
    )
    assert.equal(
      state.cards.task!.column,
      'in_progress',
    )
    assert.equal(
      state.cards.task!.attention.length,
      0,
    )
  },
)

test(
  'permission attention survives a source clearing its own attention and cannot close another session request',
  () => {
    let state = reduce({
      state: emptyHydra(),
      event: created,
    })
    const pending = permissionEvent({
      state,
      card: state.cards.task!,
      request,
      meta,
    })
    state = reduce({
      state,
      event: pending,
    })
    const decision = decidePush({
      state,
      newCardId: `c${state.seq + 1}`,
      key: 'task',
      input: {
        activity: 'working',
        attention: [],
      },
      meta,
    })
    assert.ok('event' in decision)
    state = reduce({
      state,
      event: decision.event,
    })
    assert.equal(
      state.cards.task!.attention[0]!.key,
      'pnyx:permission:request',
    )
    state = reduce({
      state,
      event: permissionEvent({
        state,
        card: state.cards.task!,
        request: {
          ...request,
          session: 'other',
          status: 'allow',
        },
        meta,
      }),
    })
    assert.equal(
      state.cards.task!.permissions![0]!.status,
      'pending',
    )
    assert.equal(
      state.cards.task!.attention[0]!.blocking,
      true,
    )
  },
)

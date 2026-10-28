import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Decision, HydraEvent, HydraState } from '../app/model.ts'
import { decidePush } from './push.ts'
import { joinedKey } from './push-rules.ts'
import { decideSession } from '../workers/sessions.ts'
import { emptyHydra, reduce } from '../app/reducer.ts'
import { liveTask } from './select.ts'

const at = '2026-10-14T12:00:00Z'
const meta = {
  at,
  actor: 'test',
}

function fixture() {
  let state = emptyHydra()
  const events: HydraEvent[] = []

  const apply = ({ decision }: { decision: Decision }) => {
    assert.ok('event' in decision)
    events.push(decision.event)
    state = reduce({
      state,
      event: decision.event,
    })
  }

  const push = ({
    key,
    input,
  }: {
    key: string
    input: object
  }) => apply({
    decision: decidePush({
      state,
      newCardId: `c${state.seq + 1}`,
      key,
      input,
      meta,
    }),
  })
  const session = ({
    key,
    interactive = true,
  }: {
    key: string
    interactive?: boolean
  }) => push({
    key: `claude:${key}`,
    input: {
      agent: {
        provider: 'claude-code',
        sessionId: key,
        cwd: '/lab',
      },
      autoTitle: {
        from: 'prompt',
        text: `Work ${key}`,
      },
      ...(interactive ? {
        terminal: {
          tty: '/dev/ttys123',
          pid: '123',
        },
      } : {}),
      source: {
        adapter: 'hooks',
        instanceId: 'claude',
        objectId: key,
        observedAt: at,
      },
    },
  })

  return {
    get state() {
      return state
    },
    events,
    push,
    apply,
    session,
  }
}

test(
  'moving a session preserves task titles, links and placement while future hooks follow its attachment',
  () => {
    const f = fixture()
    f.session({ key: 'one' })
    f.push({
      key: 'task:target',
      input: { title: 'Target task' },
    })
    const target = f.state.keys['task:target']!
    f.apply({
      decision: decideSession({
        state: f.state,
        ref: 'claude:one',
        task: target,
        meta,
      }),
    })
    assert.equal(
      f.state.cards.c1!.hidden,
      true,
    )
    assert.equal(
      f.state.cards.c1!.agent,
      undefined,
    )
    assert.equal(
      f.state.cards[target]!.title,
      'Target task',
    )
    assert.equal(
      joinedKey({
        state: f.state,
        key: 'claude:one',
        folder: '/elsewhere',
      }),
      'task:target',
    )
    f.push({
      key: 'task:target',
      input: {
        agent: {
          provider: 'claude-code',
          sessionId: 'one',
        },
        activity: 'working',
        attention: [
          {
            key: 'hook:q',
            kind: 'question',
            blocking: true,
          },
        ],
      },
    })
    assert.equal(
      f.state.cards[target]!.column,
      'in_progress',
    )
    assert.equal(
      f.state.cards[target]!.attention[0]?.key,
      'hook:q',
    )
    assert.equal(
      f.state.sessions?.['claude-code:one']?.activity,
      'working',
    )
    assert.equal(
      Object.values(f.state.cards).filter(card => liveTask({ card })).length,
      1,
    )
  },
)

test(
  'one-session capacity rejects occupied tasks without displacing either session',
  () => {
    const f = fixture()
    f.session({ key: 'one' })
    f.session({ key: 'two' })
    const before = structuredClone(f.state)
    assert.throws(
      () => decideSession({
        state: f.state,
        ref: 'claude:two',
        task: 'c1',
        meta,
      }),
      /already has an attached agent/,
    )
    assert.deepEqual(
      f.state,
      before,
    )
  },
)

test(
  'detach is explicit and a later hook never silently reattaches the session',
  () => {
    const f = fixture()
    f.session({ key: 'one' })
    f.apply({
      decision: decideSession({
        state: f.state,
        ref: 'claude:one',
        task: null,
        meta,
      }),
    })
    f.session({ key: 'one' })
    assert.equal(
      f.state.sessions?.['claude-code:one']?.taskId,
      null,
    )
    assert.equal(
      f.state.cards.c1!.hidden,
      true,
    )
    f.push({
      key: 'new',
      input: { title: 'Continue here' },
    })
    const id = f.state.keys.new!
    f.apply({
      decision: decideSession({
        state: f.state,
        ref: 'claude-code:one',
        task: id,
        meta,
      }),
    })
    assert.equal(
      f.state.sessions?.['claude-code:one']?.taskId,
      id,
    )
  },
)

test(
  'attachments validate revisions and preserve reducer input',
  () => {
    const f = fixture()
    f.session({ key: 'one' })
    f.push({
      key: 'target',
      input: { title: 'Target' },
    })
    assert.throws(
      () => decideSession({
        state: f.state,
        ref: 'claude:one',
        task: 'target',
        meta: {
          ...meta,
          ifRevision: 0,
        },
      }),
      /revision/,
    )
    const before: HydraState = structuredClone(f.state)
    const decision = decideSession({
      state: f.state,
      ref: 'claude:one',
      task: 'target',
      meta,
    })
    assert.ok('event' in decision)
    reduce({
      state: f.state,
      event: decision.event,
    })
    assert.deepEqual(
      f.state,
      before,
    )
  },
)

test(
  'moving a session keeps its source freshness, so late hooks cannot regress the new task',
  () => {
    const f = fixture()
    f.session({ key: 'one' })
    f.push({
      key: 'target',
      input: { title: 'Target' },
    })
    f.apply({
      decision: decideSession({
        state: f.state,
        ref: 'claude:one',
        task: 'target',
        meta,
      }),
    })
    const late = decidePush({
      state: f.state,
      newCardId: `c${f.state.seq + 1}`,
      key: 'target',
      input: {
        agent: {
          provider: 'claude-code',
          sessionId: 'one',
        },
        activity: 'old activity',
        source: {
          adapter: 'hooks',
          instanceId: 'claude',
          objectId: 'one',
          observedAt: '2026-10-14T11:00:00Z',
        },
      },
      meta,
    })
    assert.deepEqual(
      late,
      { skipped: 'stale' },
    )
  },
)

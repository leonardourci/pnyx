import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePush, decideSession, decideUndo, joinedKey, type Decision } from '../src/core/decide.ts'
import { emptyHydra, reduce, replay } from '../src/core/reducer.ts'
import { liveTask } from '../src/core/tasks.ts'
import type { HydraEvent, HydraState } from '../src/core/model.ts'

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
  'legacy interactive sessions stay recorded without creating Hydra work',
  () => {
    const f = fixture()
    f.session({ key: 'one' })
    const task = f.state.cards.c1!
    assert.equal(
      task.title,
      'Work one',
    )
    assert.deepEqual(
      task.sessionIds,
      ['claude-code:one'],
    )
    assert.equal(
      f.state.sessions?.['claude-code:one']?.taskId,
      task.id,
    )
    assert.equal(
      liveTask({ card: task }),
      false,
    )
  },
)

test(
  'background runs stay addressable in history but never become live cards',
  () => {
    const f = fixture()
    f.session({
      key: 'background',
      interactive: false,
    })
    assert.equal(
      Object.values(f.state.cards).filter(card => liveTask({ card })).length,
      0,
    )
    assert.equal(
      f.state.sessions?.['claude-code:background']?.agent.sessionId,
      'background',
    )
    assert.equal(
      f.state.cards.c1!.title,
      'Work background',
    )
    assert.throws(
      () => decideSession({
        state: f.state,
        ref: 'claude:background',
        task: 'c1',
        meta,
      }),
      /background session/,
    )
    f.push({
      key: 'claude:background',
      input: { terminal: { tty: '/dev/ttys123' } },
    })
    assert.equal(
      f.state.cards.c1!.hidden,
      true,
    )
  },
)

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
  'legacy multi-session joins keep the first worker attached and retain every session',
  () => {
    const f = fixture()
    f.push({
      key: 'fm:task',
      input: {
        title: 'Managed work',
        source: {
          adapter: 'firstmate',
          objectId: 'task',
        },
      },
    })

    for (const id of [
      'one',
      'two',
    ]) {
      f.push({
        key: 'fm:task',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: id,
          },
          terminal: { tty: '/dev/ttys123' },
        },
      })
    }

    assert.equal(
      f.state.cards.c1!.agent?.sessionId,
      'one',
    )
    assert.equal(
      f.state.sessions?.['claude-code:two']?.taskId,
      null,
    )

    for (let i = 0; i <= f.events.length; i++) {
      const prefix = replay({
        state: emptyHydra(),
        events: f.events.slice(
          0,
          i,
        ),
      })
      assert.deepEqual(
        replay({
          state: prefix,
          events: f.events.slice(i),
        }),
        f.state,
      )
    }
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

test(
  'undo attachment checks the revision of the original event task',
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
    const attachment = f.events.at(-1)!
    f.push({
      key: 'target',
      input: { title: 'Renamed' },
    })
    const revision = f.state.cards[f.state.keys.target!]!.revision
    f.apply({
      decision: decideUndo({
        state: f.state,
        target: attachment,
        meta: {
          ...meta,
          ifRevision: revision,
        },
      }),
    })
    assert.equal(
      f.state.sessions?.['claude-code:one']?.taskId,
      'c1',
    )
    assert.equal(
      f.state.cards[f.state.keys.target!]!.title,
      'Renamed',
    )
  },
)

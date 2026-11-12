import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '#app/model.ts'
import type { ThreadEntry, ThreadPage } from './transcripts-read.ts'
import { createThreadReceiver } from './thread-receive.ts'
import { applyThreadDelta, receivedThread, threadDelta } from './thread-delta.ts'

test(
  'thread changes preserve old entries, native order and metadata across append, update and removal',
  () => {
    const owner: ThreadEntry = {
      id: '0:m0',
      kind: 'message',
      role: 'user',
      text: 'Hello',
    }
    const reply: ThreadEntry = {
      id: '100:m0',
      kind: 'message',
      role: 'assistant',
      text: 'Partial',
    }
    const removed: ThreadEntry = {
      id: '200:m0',
      kind: 'message',
      role: 'assistant',
      text: 'Obsolete',
    }
    const updated: ThreadEntry = {
      ...reply,
      text: 'Complete',
      final: true,
    }
    const added: ThreadEntry = {
      id: '300:m0',
      kind: 'message',
      role: 'assistant',
      text: 'Next',
    }
    const action: HydraEvent = {
      v: 1,
      id: 'event-1',
      seq: 1,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
      cardId: 'task',
      type: 'task.created',
      data: {
        key: 'task',
        title: 'Task',
      },
    }
    const nextAction: HydraEvent = {
      ...action,
      id: 'event-2',
      seq: 2,
    }
    const before: ThreadPage = {
      card: '$hydra',
      session: 'fixture',
      stream: 'connection',
      version: 1,
      entries: [
        owner,
        reply,
        removed,
      ],
      actions: [action],
      route: false,
      noRoute: 'Waiting',
      watching: 'unknown',
      older: 'cursor',
      conversation: {
        through: 1,
        entries: [
          owner,
          reply,
          removed,
        ],
        folds: {
          '100:m0': {
            tasks: [],
            notes: [removed],
          },
        },
        timings: {},
        trailing: { '0:m0': [removed] },
      },
    }
    const after: ThreadPage = {
      card: '$hydra',
      session: 'fixture',
      stream: 'connection',
      version: 2,
      entries: [
        owner,
        updated,
        added,
      ],
      actions: [nextAction],
      route: true,
      watching: 'unknown',
      conversation: {
        through: 2,
        entries: [
          owner,
          updated,
          added,
        ],
        folds: {
          ['__proto__']: {
            tasks: [],
            notes: [added],
          },
        },
        timings: {},
        trailing: { '300:m0': [added] },
      },
    }
    const saved = structuredClone(before)
    const delta = threadDelta({
      before,
      after,
    })
    assert.ok(delta)
    assert.deepEqual(
      delta.entries,
      {
        upsert: [
          updated,
          added,
        ],
        remove: ['200:m0'],
      },
    )
    assert.deepEqual(
      delta.conversation?.folds,
      {
        '100:m0': null,
        ['__proto__']: {
          tasks: [],
          notes: [added],
        },
      },
    )
    const received = applyThreadDelta({
      before,
      delta,
    })
    assert.deepEqual(
      received,
      after,
    )
    assert.equal(
      received?.entries[0],
      owner,
    )
    assert.equal(
      received?.conversation?.entries[0],
      owner,
    )
    assert.equal(
      received?.conversation?.timings,
      before.conversation?.timings,
    )
    assert.deepEqual(
      before,
      saved,
    )
    assert.ok(received?.conversation)
    assert.equal(
      Object.hasOwn(
        received.conversation.folds,
        '__proto__',
      ),
      true,
    )
    assert.equal(
      Object.getPrototypeOf(received.conversation.folds),
      Object.prototype,
    )
    const withoutFold = {
      ...received,
      version: 3,
      conversation: {
        ...received.conversation,
        folds: {},
      },
    }
    const removal = threadDelta({
      before: received,
      after: withoutFold,
    })
    assert.ok(removal)
    assert.deepEqual(
      removal.conversation?.folds,
      { ['__proto__']: null },
    )
    assert.deepEqual(
      applyThreadDelta({
        before: received,
        delta: removal,
      })?.conversation?.folds,
      {},
    )
    assert.equal(
      applyThreadDelta({
        before,
        delta: {
          ...delta,
          page: {
            ...delta.page,
            version: undefined,
          },
        },
      }),
      null,
    )
    assert.equal(
      applyThreadDelta({
        before: received,
        delta,
      }),
      received,
    )
    assert.equal(
      applyThreadDelta({
        before,
        delta: {
          ...delta,
          base: 9,
        },
      }),
      null,
    )
    assert.equal(
      applyThreadDelta({
        before: null,
        delta,
      }),
      null,
    )
    assert.equal(
      applyThreadDelta({
        before,
        delta: {
          ...delta,
          page: {
            ...delta.page,
            stream: 'another',
          },
        },
      }),
      null,
    )
    assert.equal(
      receivedThread({
        before: after,
        latest: before,
      }),
      after,
    )
    const reconnected = {
      ...before,
      stream: 'reconnected',
    }
    assert.equal(
      receivedThread({
        before: after,
        latest: reconnected,
      }),
      reconnected,
    )
    assert.equal(
      threadDelta({
        before: undefined,
        after,
      }),
      undefined,
    )
    assert.equal(
      threadDelta({
        before,
        after: reconnected,
      }),
      undefined,
    )

    const receiver = createThreadReceiver()
    receiver.receive({
      message: {
        type: 'receipt',
        id: 'read',
        thread: before,
      },
    })
    const pushed = receiver.receive({
      message: {
        type: 'thread.delta',
        delta,
      },
    })
    assert.ok(pushed?.type === 'thread')
    assert.deepEqual(
      pushed.thread,
      after,
    )
    assert.equal(
      receiver.read({ card: '$hydra' })?.entries[0],
      owner,
    )
    assert.equal(
      receiver.receive({
        message: {
          type: 'thread.delta',
          delta: {
            ...delta,
            base: 9,
            page: {
              ...delta.page,
              version: 10,
            },
          },
        },
      }),
      undefined,
    )
    assert.equal(
      receiver.read({ card: '$hydra' }),
      pushed.thread,
    )
    assert.equal(
      JSON.stringify(delta).includes('"Hello"'),
      false,
    )

    const worker: ThreadPage = {
      card: 'task',
      session: 'worker',
      stream: 'card-connection',
      version: 1,
      entries: [
        owner,
        reply,
      ],
      route: true,
      watching: 'unknown',
    }
    const workerAfter = {
      ...worker,
      version: 2,
      entries: [
        owner,
        updated,
        added,
      ],
    }
    const workerDelta = threadDelta({
      before: worker,
      after: workerAfter,
    })
    assert.ok(workerDelta)
    assert.deepEqual(
      applyThreadDelta({
        before: worker,
        delta: workerDelta,
      }),
      workerAfter,
    )
    receiver.receive({
      message: {
        type: 'receipt',
        id: 'worker-read',
        thread: worker,
      },
    })
    const workerPush = receiver.receive({
      message: {
        type: 'thread.delta',
        delta: workerDelta,
      },
    })
    assert.ok(workerPush?.type === 'thread')
    assert.deepEqual(
      workerPush.thread,
      workerAfter,
    )
    assert.equal(
      receiver.read({ card: '$hydra' }),
      pushed.thread,
    )
    assert.equal(
      receiver.read({ card: 'another-task' }),
      null,
    )

    const first = {
        ...owner,
        id: 'first',
      }, second = {
        ...reply,
        id: 'second',
      }
    const unordered = {
      ...worker,
      entries: [
        first,
        second,
      ],
    }
    assert.equal(
      threadDelta({
        before: unordered,
        after: {
          ...unordered,
          version: 2,
          entries: [
            second,
            first,
          ],
        },
      }),
      undefined,
    )
  },
)

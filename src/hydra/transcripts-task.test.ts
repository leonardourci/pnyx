import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Card } from '#tasks/model.ts'
import type { SteeringMessage } from '#workers/model.ts'
import { taskReceipt } from './transcripts-task.ts'

const claim = {
  session: 'claude-code:s1',
  generation: 1,
}
const worker = ({
  host,
  activity,
  steering,
  replies,
}: {
  host?: 'pnyx'
  activity?: string
  steering?: SteeringMessage[]
  replies: Card['replies']
}): Card => ({
  id: 'task-1',
  key: 'task:1',
  title: 'Fix add',
  workspace: 'unassigned',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  column: 'custom:working',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: '2026-11-12T12:00:00.000Z',
  agent: {
    provider: 'claude-code',
    sessionId: 's1',
    host,
  },
  sessionActivity: activity,
  steering,
  replies,
})
const message = ({ ack }: { ack?: SteeringMessage['ack'] } = {}): SteeringMessage => ({
  id: 'r1',
  order: 1,
  text: 'Also check the docs',
  source: 'web',
  reply: 'r1',
  at: '2026-11-12T12:00:00.000Z',
  actor: 'web',
  attempts: [],
  ack,
})

test(
  'a message Pnyx handed to a running agent stays queued until the agent takes it',
  () => {
    const card = worker({
      host: 'pnyx',
      activity: 'working',
      steering: [message()],
      replies: [
        {
          id: 'r1',
          state: 'delivered',
        },
      ],
    })
    assert.deepEqual(
      taskReceipt({
        card,
        reply: 'r1',
      }),
      {
        receipt: 'queued',
        waiting: 'The agent is in the middle of a step',
      },
    )
    card.steering = [
      message({
        ack: {
          at: '2026-11-12T12:03:00.000Z',
          actor: 'worker:task-1',
          claim,
          outcome: 'read',
        },
      }),
    ]
    assert.deepEqual(
      taskReceipt({
        card,
        reply: 'r1',
      }),
      {
        receipt: 'delivered',
        received: '2026-11-12T12:03:00.000Z',
      },
    )
  },
)

test(
  'a worker Pnyx does not run has its message received once it reads its inbox',
  () => {
    const card = worker({
      steering: [message()],
      replies: [
        {
          id: 'r1',
          state: 'delivered',
        },
      ],
    })
    assert.deepEqual(
      taskReceipt({
        card,
        reply: 'r1',
      }),
      {
        receipt: 'queued',
        waiting: 'Waiting for the worker to read its inbox',
      },
    )
    card.steering = [
      message({
        ack: {
          at: '2026-11-12T12:05:00.000Z',
          actor: 'worker:task-1',
          claim,
          outcome: 'read',
        },
      }),
    ]
    assert.deepEqual(
      taskReceipt({
        card,
        reply: 'r1',
      }),
      {
        receipt: 'delivered',
        received: '2026-11-12T12:05:00.000Z',
      },
    )
  },
)

test(
  'a direct message is received when its harness took it, and a Firstmate reply stays delivered',
  () => {
    assert.deepEqual(
      taskReceipt({
        card: worker({
          host: 'pnyx',
          replies: [
            {
              id: 'answer',
              state: 'delivered',
              received: '2026-11-12T12:01:00.000Z',
            },
          ],
        }),
        reply: 'answer',
      }),
      {
        receipt: 'delivered',
        received: '2026-11-12T12:01:00.000Z',
      },
    )
    assert.deepEqual(
      taskReceipt({
        card: worker({
          replies: [
            {
              id: 'firstmate',
              state: 'delivered',
            },
          ],
        }),
        reply: 'firstmate',
      }),
      { receipt: 'delivered' },
    )
  },
)

test(
  'a message to a task with no worker yet waits without naming a worker',
  () => {
    const card = worker({
      replies: [
        {
          id: 'r1',
          state: 'queued',
        },
      ],
    })
    delete card.agent
    assert.deepEqual(
      taskReceipt({
        card,
        reply: 'r1',
      }),
      { receipt: 'queued' },
    )
    // Sent to Hydra with no record that its queue took it: nothing confirmed a failure, so it is unsure.
    card.replies = [
      {
        id: 'r1',
        state: 'queued',
        route: 'hydra',
      },
    ]
    assert.deepEqual(
      taskReceipt({
        card,
        reply: 'r1',
      }),
      {
        receipt: 'queued',
        delivery: {
          hydra: {
            state: 'delivery_unknown',
            detail: 'Hydra queue was not confirmed',
          },
        },
      },
    )
  },
)

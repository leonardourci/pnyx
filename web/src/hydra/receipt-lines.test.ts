import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import { receiptLines } from './receipt-lines.ts'

const sent: ThreadEntry = {
  id: 'reply',
  kind: 'message',
  role: 'You',
  text: 'Rename the helper',
  at: '2026-11-12T12:00:00.000Z',
}

test(
  'a queued message explains its wait on hover, a received one how long it took, and a failure keeps its reason in view',
  () => {
    assert.deepEqual(
      receiptLines({
        entry: {
          ...sent,
          receipt: 'queued',
          waiting: 'The agent is in the middle of a step',
        },
      }).map(line => [
        line.text,
        line.icon,
        line.hint,
      ]),
      [
        [
          'Queued',
          'waiting',
          'The agent is in the middle of a step',
        ],
      ],
    )
    const received = receiptLines({
      entry: {
        ...sent,
        receipt: 'delivered',
        received: '2026-11-12T12:05:00.000Z',
      },
    })[0]
    assert.equal(
      received?.icon,
      'check',
    )
    assert.match(
      received?.text ?? '',
      /^Received /,
    )
    assert.match(
      received?.hint ?? '',
      /received 5m 0s later$/,
    )
    assert.deepEqual(
      receiptLines({
        entry: {
          ...sent,
          receipt: 'failed',
        },
      }).map(line => [
        line.text,
        line.hint,
      ]),
      [
        [
          'Not delivered',
          undefined,
        ],
      ],
    )
  },
)

test(
  'a task message sent to Hydra and its agent shows the agent’s wait, and Hydra’s part only its own delivery',
  () => {
    assert.deepEqual(
      receiptLines({
        entry: {
          ...sent,
          receipt: 'queued',
          waiting: 'Waiting for the worker to read its inbox',
          // Built Hydra first, as the server does; the agent's part still leads.
          delivery: {
            hydra: {
              state: 'delivery_unknown',
              detail: 'Hydra queue was not confirmed',
            },
            agent: { state: 'queued' },
          },
        },
      }).map(line => [
        line.text,
        line.hint,
      ]),
      [
        [
          'Agent: Queued',
          'Waiting for the worker to read its inbox',
        ],
        [
          'Hydra: Delivery unknown · Hydra queue was not confirmed',
          undefined,
        ],
      ],
    )
  },
)

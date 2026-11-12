import { workerError } from '#app/worker-error.ts'
import { HydraError } from '#store/errors.ts'
import { findCard } from '#tasks/push-rules.ts'
import { replyRoute } from '#workers/reply-route.ts'
import type { HydraState } from '#app/model.ts'
import type { createServerWorkers } from '#app/server-workers.ts'
import type { CommandRequest } from './dispatch.ts'

// `reply`, `task-message`, `answer` and `agent`: sent to the card's agent through the reply command, which answers with the receipt.
export function replyCommand({
  ws,
  id,
  name,
  args,
  fail,
  send,
  hydraId,
  state,
  homes,
  closed,
  kick,
  startWorker,
}: CommandRequest & {
  name: unknown
  hydraId: string
  state(): HydraState
  homes(): string[]
  closed(): boolean
  kick(): void
  startWorker: ReturnType<typeof createServerWorkers>['startWorker']
}) {
  const agent = name === 'agent'
  const answering = name === 'answer'

  const valid = agent
    ? args.length === 4 && !!args[3]
    : answering
      ? args.length === 5 && args.every(Boolean) && args[2].length <= 32000
      : args.length === 3 && !!args[2] && args[1].length <= 32000

  if (!valid) {
    throw new HydraError({
      message: agent
        ? 'agent expects card, setting, value and idempotency key'
        : answering ? 'answer expects card, request key, answer, idempotency key and request id' : 'reply expects card, text and idempotency key',
      code: 'VALIDATION_ERROR',
    })
  }

  const card = findCard({
    state: state(),
    ref: args[0],
  })

  const found = replyRoute({
    card,
    homes: homes(),
  })

  if ('reason' in found && name !== 'task-message') {
    throw new HydraError({
      message: `${found.reason}${agent ? '' : ' Your draft stays here.'}`,
      code: 'NO_ROUTE',
    })
  }

  // A setting change is sent like a reply: `pnyx-axi agent` picks the harness's command and reads
  // it back. Its setting and value come last, after --, so neither can read as a flag.
  // An answer's values are passed as --name=value, so none can read as a flag.
  const [
    command,
    rest,
  ] = agent
    ? [
      [
        'agent',
        card.id,
        '--idempotency-key',
        args[3]!,
      ],
      [
        '--',
        args[1]!,
        args[2]!,
      ],
    ]
    : answering
      ? [
        [
          'reply',
          card.id,
          `--answer=${args[1]}`,
          `--json=${args[2]}`,
          `--idempotency-key=${args[3]}`,
          `--seen=${args[4]}`,
        ],
        [],
      ]
      : [
        [
          'reply',
          card.id,
          '--text',
          args[1],
          '--idempotency-key',
          args[2],
          ...(name === 'task-message' ? ['--task-message'] : []),
        ],
        [],
      ]

  if (closed()) {
    return fail({
      error: 'Pnyx is shutting down',
      code: 'UNAVAILABLE',
    })
  }

  startWorker({
    args: [
      ...command,
      '--hydra',
      hydraId,
      '--actor',
      'web',
      ...homes().flatMap(h => [
        '--home',
        h,
      ]),
      ...rest,
    ],
    done: ({
      error,
      stdout,
    }) => {
      kick()

      if (error) {
        const known = workerError({ stdout })

        if (known) {
          fail({
            error: known.message,
            code: known.code,
            help: known.help,
          })
        } else {
          fail({
            error: 'Reply could not be confirmed; check receipts before sending again',
            code: 'DELIVERY_UNKNOWN',
          })
        }
      } else {
        try {
          send({
            ws,
            message: {
              type: 'receipt',
              id,
              ...JSON.parse(stdout),
            },
          })
        } catch {
          fail({
            error: 'Reply receipt unavailable; check history',
            code: 'DELIVERY_UNKNOWN',
          })
        }
      }
    },
  })
}

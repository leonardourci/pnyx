import type { HydraEvent, HydraState } from './model.ts'
import { query } from '#store/postgres.ts'
import { HydraError } from '#store/errors.ts'
import { emptyHydra, replayOwned } from './reducer.ts'
import { emptySaved, eventStatements, rowChanges } from './rows.ts'
import { transactionStatement, type Transaction } from './transactions.ts'
import { reloadHydra } from './store.ts'
import { rememberFirstEvent } from './hydra-summary.ts'

// Copies of agent transcripts stay out of Postgres; Pnyx reads transcripts where their harness wrote them.
const TRANSCRIPT_COPY = 'chat.message'

// The events the reducer applied: older logs could repeat an event or a seq, which the reducer skipped.
function applied({ events }: { events: readonly HydraEvent[] }): HydraEvent[] {
  const ids = new Set<string>()
  let seq = 0

  return events.filter(event => {
    const next = event.seq > seq && !ids.has(event.id)

    if (next) {
      seq = event.seq
      ids.add(event.id)
    }

    return next
  })
}

// Writes a Hydra kept in an events.jsonl log into Postgres in one transaction: its events, the rows of the state they
// replay to, and the receipts of its applied plans. A Hydra already there is refused, so nothing is half imported. A
// trial runs the whole import and rolls it back, so an upgrade can learn that the import would fail before it restarts.
export function importHydra({
  hydraId,
  events,
  trial = false,
  transactions = [],
  state = replayOwned({
    state: emptyHydra(),
    events,
  }),
}: {
  hydraId: string
  events: readonly HydraEvent[]
  trial?: boolean
  transactions?: readonly Transaction[]
  state?: HydraState
}): HydraState {
  if (state.seq === 0) {
    throw new HydraError({
      message: `Hydra ${hydraId} has no events to import`,
      code: 'VALIDATION_ERROR',
    })
  }

  rememberFirstEvent({
    hydraId,
    event: events[0]!,
  })
  query({
    transaction: true,
    rollback: trial,
    statements: [
      ...eventStatements({
        hydraId,
        from: 0,
        to: state.seq,
        events: applied({ events }).filter(event => event.type !== TRANSCRIPT_COPY),
      }),
      ...rowChanges({
        hydraId,
        state,
        saved: emptySaved(),
      }).statements,
      ...transactions.map(transaction => transactionStatement({
        hydraId,
        id: transaction.id,
        digest: transaction.digest,
        receipt: transaction.receipt,
      })),
    ],
  })

  if (!trial) {
    reloadHydra({ hydraId })
  }

  return state
}

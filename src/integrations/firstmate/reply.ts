// Delivers a reply or decision answer from a Firstmate card through the home's own
// send command, `bin/fm-send.sh <task> [--resolve-key <key>] <text>`, run with an
// explicit FM_HOME. Each step is a receipt on the card: queued before the send,
// then delivered, delivery_unknown or failed.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { decideReply, findCard, type Meta } from '../../core/decide.ts'
import { BoardError, type ReplyState } from '../../core/model.ts'
import { drainSpool } from '../../cli/commands.ts'
import { withWriter } from '../../store/board-store.ts'
import { ADAPTER, STATUS_KEY, TASK_ID, resolveHome } from './home.ts'
import { firstmateRef } from './sync.ts'

const SEND_TIMEOUT_MS = 120_000
const DETAIL_MAX = 300

export interface ReplyRequest {
  card: string
  text: string
  // Idempotency key: a retry with the same id never sends twice unless the
  // earlier send failed outright.
  id?: string
  resolveKey?: string
  // Configured homes; the card's home must be one of them.
  homes: string[]
  actor?: string
}

export interface ReplyReceipt {
  card: string
  reply: string
  state: ReplyState
  sent: boolean
  detail?: string
  // Set when the send ran but its outcome could not be written; the board still
  // shows the reply as queued.
  recordError?: string
}

interface Route {
  home: string
  task: string
}

// fm-send's exit contract as read here: 0 delivered; 1 and 3 may have landed (a
// remote send that lost its transport exits 1); any other status nothing delivered.
function send(
  route: Route,
  text: string,
  resolveKey: string | undefined,
): { state: ReplyState; detail?: string } {
  const args = [route.task, ...(resolveKey ? ['--resolve-key', resolveKey] : []), text]
  const result = spawnSync(join(route.home, 'bin', 'fm-send.sh'), args, {
    env: { ...process.env, FM_HOME: route.home },
    encoding: 'utf8',
    timeout: SEND_TIMEOUT_MS,
  })
  const lastLine = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n')
    .at(-1)
    ?.slice(0, DETAIL_MAX)
  const detail = lastLine ? { detail: lastLine } : {}

  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
    return { state: 'failed', detail: `cannot run fm-send.sh: ${result.error.message}` }
  }

  if (result.status === 0) {
    return { state: 'delivered' }
  }

  // Killed by the timeout or a signal, or sent without confirmation: the message
  // may have landed, so it must not be resent blindly.
  if (result.status === null || result.status === 1 || result.status === 3) {
    return { state: 'delivery_unknown', ...detail }
  }

  return { state: 'failed', ...detail }
}

function invalid(message: string, help: string[] = []): BoardError {
  return new BoardError(message, 'VALIDATION_ERROR', help)
}

export function sendReply(board: string, request: ReplyRequest): ReplyReceipt {
  const { text, resolveKey } = request

  if (text.trim() === '') {
    throw invalid('reply text is empty')
  }

  // fm-send has no `--` separator, so a leading flag would be read as an option.
  if (text.startsWith('--')) {
    throw invalid('reply text cannot start with --')
  }

  const meta = (): Meta => ({ at: new Date().toISOString(), actor: request.actor ?? 'cli' })

  const queued = withWriter(board, writer => {
    drainSpool(writer)
    const card = findCard(writer.state, request.card)
    const ref = firstmateRef(card)

    if (!ref?.instanceId || !TASK_ID.test(ref.objectId)) {
      throw new BoardError(`card ${card.id} has no reply route`, 'NO_ROUTE', ['Reply to a Firstmate task card'])
    }

    const homes = request.homes.map(resolveHome)

    if (!homes.includes(ref.instanceId)) {
      throw invalid(`card ${card.id} belongs to Firstmate home ${ref.instanceId}, which is not configured`, [
        `Pass --home ${ref.instanceId} to allow replies to it`,
      ])
    }

    const reply = request.id ?? `r${writer.state.seq + 1}`
    const known = card.replies?.find(r => r.id === reply)
    const route = { home: ref.instanceId, task: ref.objectId }

    if (known && known.state !== 'failed') {
      return { card: card.id, reply, state: known.state, route, resend: false }
    }

    if (
      resolveKey !== undefined
      && (resolveKey === STATUS_KEY || !card.attention.some(a => a.key === resolveKey))
    ) {
      throw invalid(`card ${card.id} has no open decision with key ${resolveKey}`, [`Run \`pnyx-axi card ${card.id}\` to see its attention keys`])
    }

    // A retry after a failed send queues again, so every attempt has its own receipts.
    const data = { reply, state: 'queued' as const, route: ADAPTER, text, ...(resolveKey ? { resolveKey } : {}) }
    const decision = decideReply(writer.state, card.id, data, meta())

    if ('event' in decision) {
      writer.append(decision.event)
    }

    return { card: card.id, reply, state: 'queued' as ReplyState, route, resend: true }
  })

  if (!queued.resend) {
    return { card: queued.card, reply: queued.reply, state: queued.state, sent: false }
  }

  // Sent outside the writer lock: fm-send can take a while and must not block other writers.
  const outcome = send(queued.route, text, resolveKey)
  const receipt = { card: queued.card, reply: queued.reply, sent: true, ...outcome }

  try {
    withWriter(board, writer => {
      drainSpool(writer)
      const data = { reply: queued.reply, route: ADAPTER, ...outcome }
      const decision = decideReply(writer.state, queued.card, data, meta())

      if ('event' in decision) {
        writer.append(decision.event)
      }
    })
  } catch (error) {
    return { ...receipt, recordError: (error as Error).message }
  }

  return receipt
}

// `pnyx-axi reply`: sends text to a card's agent through the route its sources
// recorded (core/route.ts): a Firstmate task through the home's fm-send, any other
// session by typing into its terminal. Each step is a receipt on the card: queued
// before the send, then delivered, delivery_unknown or failed.
import { readFileSync } from 'node:fs'
import { AxiError } from 'axi-sdk-js'
import { decideReply, findCard, type Meta } from '../core/decide.ts'
import { BoardError, type ReplyState } from '../core/model.ts'
import { replyRoute, type ReplyRoute } from '../core/route.ts'
import { STATUS_KEY, TASK_ID, resolveHome } from '../integrations/firstmate/home.ts'
import { fmSend } from '../integrations/firstmate/reply.ts'
import { HOOK } from '../integrations/hooks/observe.ts'
import { typeInto } from '../integrations/hooks/terminal.ts'
import { paseoReply } from '../integrations/paseo/reply.ts'
import { withWriter } from '../store/board-store.ts'
import { COMMON, drainSpool, guard, meta, parse, required, type Options, type Output } from './commands.ts'

export interface ReplyRequest {
  card: string
  text: string
  // Idempotency key: a retry with the same id never sends twice unless the
  // earlier send failed outright.
  id?: string
  resolveKey?: string
  // Configured Firstmate homes; a Firstmate card's home must be one of them.
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

function invalid(message: string, help: string[] = []): BoardError {
  return new BoardError(message, 'VALIDATION_ERROR', help)
}

// The route name kept on each receipt.
function routeName(route: ReplyRoute): string {
  return route.kind === 'firstmate' || route.kind === 'paseo-agent' ? route.kind : `terminal:${route.kind}`
}

function deliver({ route, text, resolveKey, id }: {
  route: ReplyRoute
  text: string
  resolveKey?: string
  id: string
}) {
  return route.kind === 'firstmate' ? fmSend(route, text, resolveKey)
    : route.kind === 'paseo-agent' ? paseoReply({ route, text, id }) : typeInto(route, text)
}

export async function sendReply(board: string, request: ReplyRequest): Promise<ReplyReceipt> {
  const { text, resolveKey } = request

  if (text.trim() === '') {
    throw invalid('reply text is empty')
  }

  const meta = (): Meta => ({ at: new Date().toISOString(), actor: request.actor ?? 'cli' })
  const homes = request.homes.map(resolveHome)

  const queued = withWriter(board, writer => {
    drainSpool(writer)
    const card = findCard(writer.state, request.card)
    const found = replyRoute(card, homes)

    if ('reason' in found) {
      const home = card.sourceRefs.find(r => r.adapter === 'firstmate')?.instanceId

      if (home && found.reason.includes('not configured')) {
        throw invalid(`card ${card.id} belongs to Firstmate home ${home}, which is not configured`, [
          `Pass --home ${home} to allow replies to it`,
        ])
      }

      throw new BoardError(`card ${card.id} has no reply route: ${found.reason}`, 'NO_ROUTE')
    }

    const route = found.route

    if (route.kind === 'firstmate') {
      if (!TASK_ID.test(route.task)) {
        throw new BoardError(`card ${card.id} has no reply route`, 'NO_ROUTE', ['Reply to a Firstmate task card'])
      }

      // fm-send has no `--` separator, so a leading flag would be read as an option.
      if (text.startsWith('--')) {
        throw invalid('reply text cannot start with --')
      }
    } else if (resolveKey !== undefined) {
      throw invalid('--resolve-key answers Firstmate decisions; this card replies through its agent session')
    }

    const reply = request.id ?? `r${writer.state.seq + 1}`
    const known = card.replies?.find(r => r.id === reply)

    if (known && known.state !== 'failed') {
      return { card: card.id, reply, state: known.state, route, resend: false }
    }

    if (
      resolveKey !== undefined
      && (
        resolveKey === STATUS_KEY
        || resolveKey.startsWith(HOOK)
        || !card.attention.some(a => a.key === resolveKey)
      )
    ) {
      throw invalid(`card ${card.id} has no open decision with key ${resolveKey}`, [`Run \`pnyx-axi card ${card.id}\` to see its attention keys`])
    }

    // A retry after a failed send queues again, so every attempt has its own receipts.
    const data = { reply, state: 'queued' as const, route: routeName(route), text, ...(resolveKey ? { resolveKey } : {}) }
    const decision = decideReply(writer.state, card.id, data, meta())

    if ('event' in decision) {
      writer.append(decision.event)
    }

    return { card: card.id, reply, state: 'queued' as ReplyState, route, resend: true }
  })

  if (!queued.resend) {
    return { card: queued.card, reply: queued.reply, state: queued.state, sent: false }
  }

  // Sent outside the writer lock: a send can take a while and must not block other writers.
  const outcome = await deliver({ route: queued.route, text, resolveKey, id: queued.reply })
  const receipt = { card: queued.card, reply: queued.reply, sent: true, ...outcome }

  try {
    withWriter(board, writer => {
      drainSpool(writer)
      const data = { reply: queued.reply, route: routeName(queued.route), ...outcome }
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

export const reply = guard(async args => {
  const options: Options = {
    ...COMMON,
    home: { type: 'string', multiple: true },
    actor: { type: 'string' },
    text: { type: 'string' },
    file: { type: 'string' },
    'idempotency-key': { type: 'string' },
    'resolve-key': { type: 'string' },
  }
  const { values, positionals, board } = parse(args, options, 1)
  const ref = required(positionals[0], 'card id')
  const file = values.file as string | undefined

  if ((values.text === undefined) === (file === undefined)) {
    throw new AxiError('give either --text or --file', 'VALIDATION_ERROR', ['Run `pnyx-axi reply --help`'])
  }

  let text = values.text as string | undefined

  if (file !== undefined) {
    try {
      text = readFileSync(file === '-' ? 0 : file, 'utf8')
    } catch (error) {
      throw new AxiError(`cannot read reply text from ${file}: ${(error as Error).message}`, 'VALIDATION_ERROR')
    }
  }

  const receipt = await sendReply(board, {
    card: ref,
    text: text!,
    homes: (values.home as string[] | undefined) ?? [],
    actor: meta(values).actor,
    ...(values['idempotency-key'] ? { id: values['idempotency-key'] as string } : {}),
    ...(values['resolve-key'] ? { resolveKey: values['resolve-key'] as string } : {}),
  })
  const out: Output = { reply: receipt }

  if (receipt.recordError && receipt.state === 'failed') {
    out.help = ['The send failed and nothing was delivered; once the cause is fixed, send again without --idempotency-key']
  } else if (receipt.recordError) {
    out.help = [
      `The send ended ${receipt.state} but was not recorded, so the board still shows it queued; check the task's inbox or the session before sending again`,
    ]
  } else if (receipt.state === 'failed') {
    out.help = [`Fix the cause, then retry with --idempotency-key ${receipt.reply}`]
  } else if (receipt.state === 'delivery_unknown') {
    out.help = ["The message may have landed; confirm in the task's inbox or the session before sending again, a retry with the same key does not resend"]
  } else if (receipt.state === 'queued') {
    out.help = ["Check the task's inbox or the session before sending again; a retry with the same key does not resend"]
  } else {
    out.help = [`Run \`pnyx-axi history --card ${receipt.card} --kind replied\` for its receipts`]
  }

  return out
})

export const REPLY_HELP = `usage: pnyx-axi reply <id> --text <text> | --file <file|-> [--home <path>]... [--resolve-key <key>] [--idempotency-key <key>]
A Firstmate task card replies through its home's bin/fm-send.sh, with FM_HOME set; its home must
be passed with --home, and --resolve-key answers that open decision. Any other agent session is
typed into the terminal its hooks recorded: a tmux pane, a Herdr pane, a Paseo terminal, or an
iTerm2 or Terminal session found by its TTY (macOS asks once to allow controlling those apps).
The session's process must still own that TTY; the text is typed once, then submitted with Enter.
Terminal is the exception: its do script types the text and Return together, with no settle.
Receipts: queued, then delivered, delivery_unknown or failed. Retrying the same --idempotency-key
resends only after a failed send.
`

import { readFileSync } from 'node:fs'
import { AxiError } from 'axi-sdk-js'
import { answerPrompt, answerText, checkAnswer, requestId } from '../core/answer.ts'
import { decideReply, findCard, type Meta } from '../core/decide.ts'
import { BoardError, type Card, type ReplyState } from '../core/model.ts'
import { KEY_LABEL, confirms, findOption, harnessControls, inputReason, settingRequest, type Key } from '../core/control.ts'
import { replyRoute, type ReplyRoute } from '../core/route.ts'
import { STATUS_KEY, TASK_ID, resolveHome } from '../integrations/firstmate/home.ts'
import { fmNote, fmSend } from '../integrations/firstmate/reply.ts'
import { harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { answerKeys, type KeyStep } from '../integrations/hooks/answer.ts'
import { HOOK } from '../integrations/hooks/observe.ts'
import { pressKey, pressKeys, typeInto, type Delivery } from '../integrations/hooks/terminal.ts'
import { paseoReply } from '../integrations/paseo/reply.ts'
import { loadBoard, withWriter } from '../store/board-store.ts'
import { COMMON, drainSpool, guard, meta, parse, required, type Options, type Output } from './commands.ts'

export interface ReplyRequest {
  card: string
  expectedSession?: string
  text: string
  key?: Key
  // One more Enter after the text, for a command the harness may ask to confirm.
  confirm?: boolean
  // A setting change: a request note to a Firstmate task's orchestrator, and
  // elsewhere refused while the session waits on an open request.
  control?: boolean
  // Idempotency key: a retry with the same id never sends twice unless the
  // earlier send failed outright.
  id?: string
  resolveKey?: string
  homes: string[]
  actor?: string
  // An inline answer to the open request with this key, pressed as keys into the
  // session's own prompt instead of typed text. seen is the requestId the answer was
  // written for; a different request under the same key refuses it.
  answer?: { request: string; value: unknown; seen?: string }
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

function invalid({ message, help = [] }: { message: string; help?: string[] }): BoardError {
  return new BoardError({ message, code: 'VALIDATION_ERROR', help })
}

function routeName({ route, control }: { route: ReplyRoute; control?: boolean }): string {
  return route.kind === 'firstmate' ? (control ? 'firstmate:inbox' : 'firstmate')
    : route.kind === 'paseo-agent' ? route.kind : `terminal:${route.kind}`
}

// The request id of a setting change's note: per board, card and change, so a retry
// of the same change replays its note.
const noteId = ({ board, card, reply }: { board: string; card: string; reply: string }) => `pnyx:${board}:${card}:${reply}`

// Time for Claude Code to show its confirmation after a model or effort command.
const CONFIRM_SETTLE_MS = 1500

// A permission prompt, question or other request the session's hooks show as open:
// keys sent then would answer it instead of reaching the prompt.
function waiting({ card }: { card: Card | undefined }): boolean {
  return card?.attention.some(a => a.blocking && a.key.startsWith(HOOK)) ?? false
}

function deliver({ board, card, reply, route, request, keys }: {
  board: string
  card: string
  reply: string
  route: ReplyRoute
  request: ReplyRequest
  keys?: KeyStep[]
}): Delivery | Promise<Delivery> {
  const { text, key, confirm, resolveKey } = request

  if (keys && route.kind === 'tmux') {
    return pressKeys({ route, steps: keys })
  }

  if (route.kind === 'firstmate') {
    return request.control
      ? fmNote({ home: route.home, requestId: noteId({ board, card, reply }), text })
      : fmSend({ route, text, resolveKey })
  }

  if (route.kind === 'paseo-agent') {
    return paseoReply({ route, text, id: reply })
  }

  const sent = key ? pressKey({ route, key }) : typeInto({ route, text })

  if (!confirm || sent.state !== 'delivered') {
    return sent
  }

  // Claude Code asks to confirm a model or effort change while its prompt cache is
  // warm, with Yes selected, and an Enter at an empty prompt does nothing. A request
  // the session opened meanwhile would take that Enter instead, so then none is pressed.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CONFIRM_SETTLE_MS)

  if (withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })

      return waiting({ card: writer.state.cards[card] })
    },
  })) {
    return { state: 'delivery_unknown', detail: 'the command was sent, then the session opened a request, so Pnyx pressed nothing more; answer it and any confirmation in the session' }
  }

  const answered = pressKey({ route, key: 'enter' })

  return answered.state === 'delivered'
    ? sent
    : { state: 'delivery_unknown', detail: `the command was sent, but the Enter that answers its confirmation was not${answered.detail ? ` (${answered.detail})` : ''}; check the session` }
}

export async function sendReply({ board, request }: {
  board: string
  request: ReplyRequest
}): Promise<ReplyReceipt> {
  const { resolveKey, answer } = request

  if (!answer && request.text.trim() === '') {
    throw invalid({ message: 'reply text is empty' })
  }

  if (answer && (resolveKey !== undefined || request.key || request.control)) {
    throw invalid({ message: '--answer cannot be combined with a key, setting or --resolve-key' })
  }

  const meta = (): Meta => ({ at: new Date().toISOString(), actor: request.actor ?? 'cli' })
  const homes = request.homes.map(path => resolveHome({ path }))

  const queued = withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = findCard({ state: writer.state, ref: request.card })

      if (request.expectedSession && card.sessionIds?.[0] !== request.expectedSession) {
        throw new BoardError({ message: 'the attached agent changed before the brief could be sent', code: 'SESSION_CONFLICT' })
      }

      const found = replyRoute({ card, homes })

      if ('reason' in found) {
        const home = card.sourceRefs.find(r => r.adapter === 'firstmate')?.instanceId

        if (home && found.reason.includes('not configured')) {
          throw invalid({
            message: `card ${card.id} belongs to Firstmate home ${home}, which is not configured`,
            help: [
              `Pass --home ${home} to allow replies to it`,
            ],
          })
        }

        throw new BoardError({ message: `card ${card.id} has no reply route: ${found.reason}`, code: 'NO_ROUTE' })
      }

      const route = found.route

      const key = request.key
      const unpressable = key && inputReason({ kind: route.kind, input: { key } })

      if (unpressable) {
        throw new BoardError({ message: `card ${card.id} cannot take ${KEY_LABEL[key!]}: ${unpressable}`, code: 'NO_ROUTE' })
      }

      if (request.control && route.kind !== 'firstmate' && waiting({ card })) {
        throw new BoardError({ message: `card ${card.id} is waiting on a request; answer it in the session before changing settings`, code: 'SESSION_WAITING' })
      }

      if (route.kind === 'firstmate') {
        if (!TASK_ID.test(route.task)) {
          throw new BoardError({ message: `card ${card.id} has no reply route`, code: 'NO_ROUTE', help: ['Reply to a Firstmate task card'] })
        }

        // fm-send has no `--` separator, so a leading flag would be read as an option.
        if (request.text.startsWith('--')) {
          throw invalid({ message: 'reply text cannot start with --' })
        }
      } else if (resolveKey !== undefined) {
        throw invalid({ message: '--resolve-key answers Firstmate decisions; this card replies through its agent session' })
      }

      const reply = request.id ?? `r${writer.state.seq + 1}`
      const known = card.replies?.find(r => r.id === reply)

      if (known && known.state !== 'failed') {
        return { card: card.id, reply, state: known.state, route, resend: false }
      }

      let text = request.text
      let keys: KeyStep[] | undefined
      let answers: string | undefined

      if (answer) {
        const open = card.attention.find(a => a.key === answer.request)
        const prompt = open && answerPrompt({ card, request: open })

        if (!open || !prompt) {
          throw invalid({
            message: `card ${card.id} has no open request with key ${answer.request} that can be answered here`,
            help: [`Run \`pnyx-axi card ${card.id}\` to see its requests, or answer in the session itself`],
          })
        }

        answers = requestId({ request: open })

        if (answer.seen !== undefined && answer.seen !== answers) {
          throw new BoardError({
            message: `the request ${answer.request} changed since it was shown; nothing was typed`,
            code: 'REVISION_CONFLICT',
            help: [`Run \`pnyx-axi card ${card.id}\` and answer the current request`],
          })
        }

        // Keys typed after the prompt closed would land on the next one, so an answer
        // still being typed, or one that may have landed, holds the request.
        if (card.replies?.some(r => r.answers === answers && (r.state === 'queued' || r.state === 'delivery_unknown'))) {
          throw new BoardError({
            message: `an answer to ${answer.request} is already being typed or may have landed; nothing was typed`,
            code: 'SESSION_WAITING',
            help: ['Check the session, and answer there if its prompt is still open'],
          })
        }

        const checked = checkAnswer({ prompt, request: open, value: answer.value })

        if ('error' in checked) {
          throw invalid({ message: checked.error })
        }

        text = answerText({ prompt, request: open, answer: checked.answer })
        keys = answerKeys({ provider: card.agent?.provider ?? '', request: open, answer: checked.answer })
      }

      if (
        resolveKey !== undefined
      && (
        resolveKey === STATUS_KEY
        || resolveKey.startsWith(HOOK)
        || !card.attention.some(a => a.key === resolveKey)
      )
      ) {
        throw invalid({ message: `card ${card.id} has no open decision with key ${resolveKey}`, help: [`Run \`pnyx-axi card ${card.id}\` to see its attention keys`] })
      }

      // A retry after a failed send queues again, so every attempt has its own receipts.
      const data = {
        reply,
        state: 'queued' as const,
        route: routeName({ route, control: request.control }),
        text,
        ...(request.control || request.key ? { control: true } : {}),
        ...(resolveKey ? { resolveKey } : {}),
        ...(answers ? { answers } : {}),
      }
      const decision = decideReply({ state: writer.state, ref: card.id, data, meta: meta() })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }

      return { card: card.id, reply, state: 'queued' as ReplyState, route, resend: true, keys, answers }
    },
  })

  if (!queued.resend) {
    return { card: queued.card, reply: queued.reply, state: queued.state, sent: false }
  }

  // Sent outside the writer lock: a send can take a while and must not block other writers.
  const { card, reply, route, keys, answers } = queued
  const outcome = await deliver({ board, card, reply, route, request, keys })
  const receipt = { card, reply, sent: true, ...outcome }

  try {
    withWriter({
      board,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const data = {
          reply,
          route: routeName({ route, control: request.control }),
          ...outcome,
          ...(answers ? { answers } : {}),
        }
        const decision = decideReply({ state: writer.state, ref: card, data, meta: meta() })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })
  } catch (error) {
    return { ...receipt, recordError: (error as Error).message }
  }

  return receipt
}

export const reply = guard({
  handler: async ({ args }) => {
    const options: Options = {
      ...COMMON,
      home: { type: 'string', multiple: true },
      actor: { type: 'string' },
      text: { type: 'string' },
      file: { type: 'string' },
      'idempotency-key': { type: 'string' },
      'resolve-key': { type: 'string' },
      answer: { type: 'string' },
      json: { type: 'string' },
      seen: { type: 'string' },
    }
    const { values, positionals, board } = parse({ args, options, positionals: 1 })
    const ref = required({ value: positionals[0], what: 'card id' })
    const file = values.file as string | undefined
    const request = values.answer as string | undefined
    let answer: ReplyRequest['answer']

    if (request !== undefined) {
      if (values.text !== undefined || file !== undefined || values.json === undefined) {
        throw new AxiError('--answer takes --json with the answer, not --text or --file', 'VALIDATION_ERROR', ['Run `pnyx-axi reply --help`'])
      }

      try {
        const seen = values.seen as string | undefined
        const value: unknown = JSON.parse(values.json as string)
        answer = { request, value, ...(seen !== undefined ? { seen } : {}) }
      } catch {
        throw new AxiError('--json is not valid JSON', 'VALIDATION_ERROR', ['Example: --json \'{"choice":"allow"}\''])
      }
    } else if (values.json !== undefined || values.seen !== undefined) {
      throw new AxiError('--json and --seen go with --answer', 'VALIDATION_ERROR', ['Run `pnyx-axi reply --help`'])
    } else if ((values.text === undefined) === (file === undefined)) {
      throw new AxiError('give either --text or --file', 'VALIDATION_ERROR', ['Run `pnyx-axi reply --help`'])
    }

    let text = (values.text as string | undefined) ?? (answer ? '' : undefined)

    if (file !== undefined) {
      try {
        text = readFileSync(file === '-' ? 0 : file, 'utf8')
      } catch (error) {
        throw new AxiError(`cannot read reply text from ${file}: ${(error as Error).message}`, 'VALIDATION_ERROR')
      }
    }

    const receipt = await sendReply({
      board,
      request: {
        card: ref,
        text: text!,
        homes: (values.home as string[] | undefined) ?? [],
        actor: meta({ values }).actor,
        ...(values['idempotency-key'] ? { id: values['idempotency-key'] as string } : {}),
        ...(values['resolve-key'] ? { resolveKey: values['resolve-key'] as string } : {}),
        ...(answer ? { answer } : {}),
      },
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
  },
})

// Time for a harness to record a change it writes at once, as Codex does, before
// the transcript is read back.
const READBACK_MS = 1000

function agentSummary({ board, ref, homes }: {
  board: string
  ref: string
  homes: string[]
}): Output {
  const card = findCard({ state: loadBoard({ board }).state, ref })
  const provider = card.agent?.provider
  const found = replyRoute({ card, homes: homes.map(path => resolveHome({ path })) })
  const firstmate = 'route' in found && found.route.kind === 'firstmate' ? found.route : undefined
  const harness = harnessControls({ provider, firstmate: !!firstmate })
  const controls = (harness?.controls ?? []).map(c => {
    const unavailable = 'reason' in found
      ? found.reason
      : c.options.map(o => inputReason({ kind: found.route.kind, input: o.input })).find(Boolean)

    return {
      setting: c.setting,
      now: card.settings?.[c.setting] ?? 'unknown',
      options: c.options.map(o => o.value).join(' '),
      ready: unavailable ?? 'yes',
    }
  })
  const agent = {
    card: card.id,
    harness: provider ?? 'none',
    route: 'route' in found ? routeName({ route: found.route, control: true }) : `none: ${found.reason}`,
    ...(harness?.note ? { note: harness.note } : {}),
  }

  if (!harness) {
    return {
      agent,
      controls: [],
      help: [provider ? `Pnyx changes settings only for Claude Code and Codex sessions, not ${provider}` : 'This card has no agent session joined yet, so there is nothing to change'],
    }
  }

  const ready = controls.find(c => c.ready === 'yes')

  return {
    agent,
    controls,
    help: ready ? [`Run \`pnyx-axi agent ${card.id} ${ready.setting} ${ready.options.split(' ')[0]}\` to change it`] : ['No setting can be changed on this route'],
  }
}

export const agent = guard({
  handler: async ({ args }) => {
    const options: Options = {
      ...COMMON,
      home: { type: 'string', multiple: true },
      actor: { type: 'string' },
      'idempotency-key': { type: 'string' },
    }
    const { values, positionals, board } = parse({ args, options, positionals: 3 })
    const ref = required({ value: positionals[0], what: 'card id' })
    const homes = (values.home as string[] | undefined) ?? []

    if (positionals.length < 3) {
      if (positionals.length === 2) {
        throw new AxiError('give a setting and a value', 'VALIDATION_ERROR', [`Run \`pnyx-axi agent ${ref}\` to list them`])
      }

      return agentSummary({ board, ref, homes })
    }

    const [, setting, value] = positionals as [string, string, string]
    const card = findCard({ state: loadBoard({ board }).state, ref })
    const provider = card.agent?.provider
    const found = replyRoute({ card, homes: homes.map(path => resolveHome({ path })) })
    const firstmate = 'route' in found && found.route.kind === 'firstmate' ? found.route : undefined
    const picked = findOption({ provider, setting, value, firstmate: !!firstmate })

    if (!picked) {
      throw new AxiError(`card ${card.id} offers no ${setting} ${value}`, 'VALIDATION_ERROR', [`Run \`pnyx-axi agent ${card.id}\` to list its settings and values`])
    }

    const { control, option } = picked

    // What the session reported before, with everything it has recorded folded in,
    // so the readback compares like with like.
    const settled = () => withWriter({
      board,
      fn: ({ writer }) => {
        drainSpool({ writer })
        harvestTranscripts({ writer, cardIds: [card.id], at: new Date().toISOString() })

        return writer.state.cards[card.id]?.settings?.[setting]
      },
    })
    const before = settled()
    const input = option.input
    const harness = harnessControls({ provider })!.name
    // A Firstmate task's worker is never typed into: its orchestrator gets a request note.
    const typed = firstmate
      ? { text: settingRequest({ option, task: firstmate.task, harness }) }
      : 'request' in input
        ? undefined
        : 'key' in input
          ? { text: `[${KEY_LABEL[input.key]}]`, key: input.key }
          : { text: input.text, confirm: input.confirm }

    if (!typed) {
      throw new AxiError('this setting requires a Firstmate request route', 'NO_ROUTE')
    }

    const receipt = await sendReply({
      board,
      request: {
        card: card.id,
        ...typed,
        control: true,
        homes,
        actor: meta({ values }).actor,
        ...(values['idempotency-key'] ? { id: values['idempotency-key'] as string } : {}),
      },
    })
    let now = before

    if (receipt.state === 'delivered' && !firstmate) {
      // A harness that records the change at once, as Codex does, confirms it here;
      // otherwise the session's next hook or turn does.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READBACK_MS)
      now = settled()
    }

    const confirmed = confirms({ control, option, before, after: now })
    const out: Output = {
      agent: { card: card.id, setting, value, sent: receipt.state, before: before ?? 'unknown', now: now ?? 'unknown', confirmed },
    }

    if (receipt.recordError) {
      out.help = [`The change ended ${receipt.state} but was not recorded: ${receipt.recordError}; check the session before sending again`]
    } else if (receipt.state === 'failed') {
      out.help = [`Nothing was changed${receipt.detail ? `: ${receipt.detail}` : ''}`]
    } else if (receipt.state !== 'delivered') {
      out.help = [`The change may have landed${receipt.detail ? ` (${receipt.detail})` : ''}; check the session before sending again`]
    } else if (!confirmed && firstmate) {
      out.help = [`${receipt.detail ?? 'The request note'} asks Firstmate's orchestrator for it; the worker's next hook or turn confirms its new ${setting}`]
    } else if (!confirmed) {
      out.help = [`The session has not reported its new ${setting} yet; it does on its next hook or turn. Run \`pnyx-axi card ${card.id}\` to check`]
    }

    return out
  },
})

export const AGENT_HELP = `usage: pnyx-axi agent <id> [<setting> <value>] [--home <path>]... [--idempotency-key <key>]
Without a setting, lists the card's harness, settings and the ones Pnyx can change, with values.
With one, types what the harness's own interface takes into the session, on the card's reply
route (receipts as for reply), then reads the setting back from the transcript:
  Claude Code: model opus|sonnet|haiku|fable (/model), effort low|medium|high|xhigh|max (/effort),
    fast on|off (/fast), mode next (Shift+Tab). Claude Code saves a typed model, effort or fast
    mode as the default for new sessions; one more Enter answers its confirmation, if shown.
  Direct Codex sessions: effort lower|raise (Shift+Down, Shift+Up), fast toggle (/fast), collaboration toggle
    (Shift+Tab, Plan or Default). Codex picks model and approval mode only in its own pickers.
Terminal and Herdr press only Enter and refuse the keys. Nothing is typed while the session
waits on a permission prompt or question.
A Firstmate task's worker is never typed into: every change goes to its orchestrator as a request
note. Codex task cards also offer model gpt-6.1-sol|gpt-6-astra|gpt-6-sol|gpt-6-luna and
approval untrusted|on-request|never as request-only settings, without any typed input. Notes go
through the home's bin/fm-inbox.sh note --request-id <id> (a retry with the same
--idempotency-key replays that note).
A setting the session has not reported yet is confirmed by its next hook or turn.
`

export const REPLY_HELP = `usage: pnyx-axi reply <id> --text <text> | --file <file|-> [--home <path>]... [--resolve-key <key>] [--idempotency-key <key>]
       pnyx-axi reply <id> --answer <request key> --json <answer> [--seen <request id>] [--idempotency-key <key>]
A Firstmate task card replies through its home's bin/fm-send.sh, with FM_HOME set; its home must
be passed with --home, and --resolve-key answers that open decision. Any other agent session is
typed into the terminal its hooks recorded: a tmux pane, a Herdr pane, a Paseo terminal, or an
iTerm2 or Terminal session found by its TTY (macOS asks once to allow controlling those apps).
The session's process must still own that TTY; the text is typed once, then submitted with Enter.
Terminal is the exception: its do script types the text and Return together, with no settle.
Receipts: queued, then delivered, delivery_unknown or failed. Retrying the same --idempotency-key
resends only after a failed send.
--answer answers an agent's open question, permission, plan or MCP form prompt (its request key, from
\`pnyx-axi card <id>\`) by pressing the keys that prompt expects in the session's tmux pane (other
terminals are answered in the session itself):
  question:   --json '{"answers":[{"pick":[2]},{"pick":[1,3]},{"text":"free text"}]}'  one per question,
              options numbered from 1; text only for a single-choice question
  permission: --json '{"choice":"allow"}' or '{"choice":"deny","text":"do this instead"}'
  plan:       --json '{"choice":"approve"}' or '{"choice":"revise","text":"what to change"}'
  MCP form:   --json '{"choice":"accept","values":{"name":"Ada","count":2,"agree":true}}' or '{"choice":"decline"}'
--seen refuses the answer when the request changed since that id was shown. A delivered answer marks
the request answered; the session's own hooks close it once it moves on.
`

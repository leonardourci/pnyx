import { readFileSync } from 'node:fs'
import { HydraError, HYDRA_ACTOR, type Ask, type AskAudience, type Card } from '../core/model.ts'
import { findCard, type Meta } from '../core/decide.ts'
import { askAnswer, askReport, askWording, decideAsk, decideEscalation } from '../core/asks.ts'
import { hydraConfig, hydraDelivery, hydraEvent, reportActor } from '../core/hydra.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { loadHydra, withWriter } from '../store/hydra-store.ts'
import { askHost, readServer } from '../server/state.ts'
import { browserCommand } from '../server/browser.ts'
import { commit, explained, required, type Output } from './commands.ts'
import { sendReply } from './reply.ts'

type Values = Record<string, string | boolean | string[] | undefined>

const strings = ({ value }: { value: Values[string] }): string[] =>
  Array.isArray(value) ? value : typeof value === 'string' ? [value] : []

const one = ({
  value,
  flag,
}: {
  value: Values[string]
  flag: string
}): string | undefined => {
  const all = strings({ value })

  if (all.length > 1) {
    throw new HydraError({
      message: `pass ${flag} once`,
      code: 'VALIDATION_ERROR',
    })
  }

  return all[0]
}

const text = ({ value }: { value: Values[string] }) => typeof value === 'string' ? value : undefined

// "<label>: <description>" splits at the first ": "; a label alone has no description.
const choice = ({ raw }: { raw: string }) => {
  const at = raw.indexOf(': ')

  if (at <= 0) {
    return { label: raw }
  }

  return {
    label: raw.slice(
      0,
      at,
    ),
    description: raw.slice(at + 2),
  }
}

const askState = ({
  card,
  ask,
}: {
  card: Card
  ask: Ask
}) => {
  if (ask.answered) {
    return `answered (${ask.answered})`
  }

  const pending = card.replies?.find(r => r.answers === ask.id && (r.state === 'queued' || r.state === 'delivery_unknown'))

  if (pending) {
    return `answer ${pending.state} (${pending.id})`
  }

  return ask.escalated ? 'escalated to the owner' : 'open'
}

export const askRows = ({ card }: { card: Card }) => (card.asks ?? []).map((ask: Ask) => ({
  id: ask.id,
  from: ask.actor,
  to: ask.audience,
  question: askWording({ ask }).question,
  ...(ask.options?.length ? {
    choices: ask.options.map((
      o,
      i,
    ) => `${i + 1}. ${o.label}${ask.recommended === i + 1 ? ' (recommended)' : ''}`).join(' | '),
  } : {}),
  state: askState({
    card,
    ask,
  }),
}))

// A recorded message reaches a running hosted Hydra exactly as Pnyx delivers every message to it.
async function handToHydra({
  hydraId,
  id,
  actor,
}: {
  hydraId: string
  id: string
  actor: string
}): Promise<Output> {
  const state = loadHydra({ hydraId }).state
  const message = state.hydraMessages?.find(m => m.id === id)
  const firstmate = hydraConfig({
    state,
    id: hydraId,
  }).hydra.kind === 'firstmate'

  if (!message || firstmate || !await readServer({ hydraId })) {
    return {}
  }

  return askHost({
    hydraId,
    body: {
      action: 'hydra',
      id,
      text: hydraDelivery({ message }),
      actor,
    },
  })
}

// The owner's answer to Hydra's own question is the owner's message to Hydra: their words, with
// the question it answers as context. Recorded first, so it resolves the question even while Hydra
// is not running, then handed to a running Hydra.
async function answerHydra({
  hydraId,
  ref,
  id,
  choice: picked,
  text: typed,
  meta,
}: {
  hydraId: string
  ref: string
  id: string
  choice?: string
  text?: string
  meta: Meta
}): Promise<Output> {
  const result = commit({
    hydraId,
    meta,
    intent: {
      type: 'hydra.message',
      card: ref,
    },
    decide: ({ state }) => {
      const card = findCard({
        state,
        ref,
      })
      const {
        answer,
        choice,
        question,
      } = askAnswer({
        card,
        id,
        actor: meta.actor,
        choice: picked,
        text: typed,
      }).decision
      const picks = choice && choice !== answer ? [`Choice: ${choice}`] : []

      return hydraEvent({
        state,
        meta,
        cardId: card.id,
        change: {
          type: 'hydra.message',
          data: {
            task: card.id,
            action: 'send',
            // The owner's words, or their pick when they typed none; Pnyx adds what it answers.
            text: answer,
            context: [
              `Answers question ${id}: ${question}`,
              ...picks,
            ].join('\n'),
            answers: id,
            ...(choice ? { choice } : {}),
            hydra: hydraConfig({
              state,
              id: hydraId,
            }).hydra.id,
          },
        },
      })
    },
  })
  const event = result.event as { id?: string } | undefined

  if (!event?.id) {
    return result
  }

  const hosted = await handToHydra({
    hydraId,
    id: event.id,
    actor: meta.actor,
  })

  return {
    ...result,
    answered: id,
    hydra: hosted.state ?? 'not running',
  }
}

// A Hydra or worker session's own actor wins over --actor, so no agent answers as the owner
// or asks the owner in Hydra's name. The server's own page keeps the actor the server gave it.
const sessionActor = ({ meta }: { meta: Meta }): Meta => {
  const session = process.env.PNYX_ACTOR
  const agentSession = !!session && (session === HYDRA_ACTOR || reportActor({ actor: session }))
  const agent = agentSession && !browserCommand.getStore()

  return agent ? {
    ...meta,
    actor: session,
  } : meta
}

const DELIVERY_HELP: Record<string, string> = {
  delivered: 'The worker has the answer; the question is resolved',
  failed: 'Nothing reached the worker; repeat the command to send it again',
}

async function answerCommand({
  ref,
  positionals,
  values,
  hydraId,
  meta: m,
}: {
  ref: string
  positionals: string[]
  values: Values
  hydraId: string
  meta: Meta
}): Promise<Output> {
  const reason = explained({ meta: m })
  const id = required({
    value: positionals[2],
    what: 'question id',
  })
  const picked = one({
    value: values.choice,
    flag: '--choice',
  })
  const typed = text({ value: values.text })
  const undelivered = values.undelivered === true
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref,
  })
  const repeat = m.id !== undefined
    && (m.id in state.eventIds || !!card.replies?.some(r => r.id === m.id))

  // Checked here first so a missing route never hides a closed question or a refused answerer;
  // the write checks again under the lock, and a repeated key returns what it did before.
  if (!repeat) {
    askAnswer({
      card,
      id,
      actor: m.actor,
      choice: picked,
      text: typed,
      undelivered,
    })
  }

  if (card.asks?.find(a => a.id === id)?.actor === HYDRA_ACTOR) {
    return answerHydra({
      hydraId,
      ref,
      id,
      choice: picked,
      text: typed,
      meta: m,
    })
  }

  const receipt = await sendReply({
    hydraId,
    request: {
      card: ref,
      text: '',
      homes: [],
      actor: m.actor,
      ...(m.id ? { id: m.id } : {}),
      ...(reason ? { reason } : {}),
      ask: {
        id,
        choice: picked,
        text: typed,
        undelivered,
      },
    },
  })

  return {
    ...receipt,
    help: [DELIVERY_HELP[receipt.state] ?? 'Delivery is uncertain: check the worker’s session; if the answer never arrived, repeat with --undelivered'],
  }
}

async function askOne({
  ref,
  values,
  hydraId,
  meta: m,
}: {
  ref: string
  values: Values
  hydraId: string
  meta: Meta
}): Promise<Output> {
  const inline = text({ value: values.details })
  const file = text({ value: values['details-file'] })

  if (inline !== undefined && file !== undefined) {
    throw new HydraError({
      message: 'pass --details or --details-file, not both',
      code: 'VALIDATION_ERROR',
    })
  }

  let details = inline

  if (file !== undefined) {
    try {
      details = readFileSync(
        file,
        'utf8',
      )
    } catch (error) {
      throw new HydraError({
        message: `--details-file cannot be read: ${(error as Error).message}`,
        code: 'VALIDATION_ERROR',
      })
    }
  }

  const recommend = one({
    value: values.recommend,
    flag: '--recommend',
  })
  const to = values.to ?? (m.actor === HYDRA_ACTOR ? 'owner' : 'hydra')

  if (to !== 'hydra' && to !== 'owner') {
    throw new HydraError({
      message: '--to takes hydra or owner',
      code: 'VALIDATION_ERROR',
    })
  }

  // The question and, for Hydra, the message that delivers it are written together.
  const written = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const known = m.id === undefined ? undefined : writer.state.eventIds[m.id]

      if (known !== undefined) {
        return {
          seq: known,
          repeat: true,
        }
      }

      const id = `ask-${writer.state.seq + 1}`
      const decision = decideAsk({
        state: writer.state,
        ref,
        id,
        audience: to as AskAudience,
        question: required({
          value: text({ value: values.question }),
          what: '--question',
        }),
        context: text({ value: values.context }),
        details,
        options: strings({ value: values.choice }).map(raw => choice({ raw })),
        recommended: recommend === undefined ? undefined : Number(recommend),
        meta: m,
      })

      // hydraEvent skips only an event id it knows, which returned above.
      if (!('event' in decision)) {
        throw new HydraError({
          message: `question already recorded: ${decision.skipped}`,
          code: 'CONFLICT',
        })
      }

      writer.append({ event: decision.event })
      const card = writer.state.cards[decision.event.cardId]!
      const ask = card.asks!.find(a => a.id === id)!

      if (ask.audience === 'hydra') {
        const report = hydraEvent({
          state: writer.state,
          meta: {
            at: m.at,
            actor: m.actor,
            id: `${decision.event.id}:report`,
          },
          cardId: card.id,
          change: {
            type: 'hydra.message',
            data: {
              task: card.id,
              action: 'send',
              text: askReport({
                task: card.id,
                ask,
                hydraId,
              }),
              ask: id,
              hydra: hydraConfig({
                state: writer.state,
                id: hydraId,
              }).hydra.id,
            },
          },
        })

        if ('event' in report) {
          writer.append({ event: report.event })
        }
      }

      return {
        seq: decision.event.seq,
        event: decision.event.id,
        repeat: false,
      }
    },
  })
  const id = `ask-${written.seq}`
  const state = loadHydra({ hydraId }).state
  const ask = Object.values(state.cards).flatMap(c => c.asks ?? [])
    .find(a => a.id === id)
  const message = state.hydraMessages?.find(msg => msg.ask === id)
  const help = ask?.audience === 'owner'
    ? 'The owner answers it in the task; wait for that answer before work that depends on it'
    : 'Hydra answers or escalates it; keep working on what does not depend on the answer, which arrives as a message'
  const asked = {
    event: written.repeat ? 'none: duplicate' : written.event,
    ask: ask?.id ?? 'none',
    to: ask?.audience ?? 'none',
    ...(message ? { message: message.id } : {}),
    help: [help],
  }

  if (written.repeat || !message) {
    return asked
  }

  return {
    ...asked,
    ...await handToHydra({
      hydraId,
      id: message.id,
      actor: m.actor,
    }),
  }
}

export function askCommand({
  action,
  positionals,
  values,
  hydraId,
  meta: given,
}: {
  action: 'ask' | 'answer' | 'escalate'
  positionals: string[]
  values: Values
  hydraId: string
  meta: Meta
}): Output | Promise<Output> {
  const m = sessionActor({ meta: given })
  const ref = required({
    value: positionals[1],
    what: 'task id',
  })

  if (action === 'answer') {
    return answerCommand({
      ref,
      positionals,
      values,
      hydraId,
      meta: m,
    })
  }

  if (action === 'ask') {
    return askOne({
      ref,
      values,
      hydraId,
      meta: m,
    })
  }

  if (!explained({ meta: m })) {
    throw new HydraError({
      message: 'an escalation needs --reason <why the owner must decide>',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    ...commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.ask.escalated',
        card: ref,
      },
      decide: ({ state }) => decideEscalation({
        state,
        ref,
        ask: required({
          value: positionals[2],
          what: 'question id',
        }),
        question: text({ value: values.question }),
        context: text({ value: values.context }),
        undelivered: values.undelivered === true,
        meta: m,
      }),
    }),
    help: ['The question now waits for the owner; work that depends on it waits for their answer'],
  }
}

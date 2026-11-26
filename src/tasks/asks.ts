import { inform } from '#app/command-notices.ts'
import { decisionKey, ownerQuestionGroups, questionGroupCard } from './question-groups.ts'
import { readFileSync } from 'node:fs'
import { TITAN_ACTOR, ownerActor } from '#app/actors.ts'
import { clarificationText, decideQuestionAction } from './question-actions.ts'
import { TitanError } from '#store/errors.ts'
import type { Ask, AskAudience, Card } from './model.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from './push-rules.ts'
import { askAnswer, askReport, decideAsk, decideAskClosure, decideEscalation } from './ask-decide.ts'
import { askWording, pendingAnswer } from './ask-state.ts'
import { hydraConfig } from '#titan/config.ts'
import { hydraDelivery, hydraEvent, reportActor } from '#titan/titan.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { askHost, readServer } from '#app/server-state.ts'
import { browserCommand } from '#app/server-browser.ts'
import { commit, explained, required, type Output } from '#app/cli-support.ts'
import { sendReply } from '#workers/reply.ts'
import { requestEnv } from '#app/request-context.ts'

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
    throw new TitanError({
      message: `pass ${flag} once`,
      code: 'VALIDATION_ERROR',
    })
  }

  return all[0]
}

const text = ({ value }: { value: Values[string] }) => typeof value === 'string' ? value : undefined

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
  if (ask.closed) {
    return `closed (${ask.closed.reason}; ${ask.closed.evidence})`
  }

  if (ask.answered) {
    return `answered (${ask.answered})`
  }

  if (ask.deferredUntil) {
    return `later until ${ask.deferredUntil}`
  }

  const pending = pendingAnswer({
    card,
    ask,
  })

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

async function handToTitan({
  titanId,
  id,
  actor,
}: {
  titanId: string
  id: string
  actor: string
}): Promise<Output> {
  const state = loadTitan({ titanId }).state
  const message = state.hydraMessages?.find(m => m.id === id)

  if (!message || !await readServer({ titanId })) {
    return {}
  }

  return askHost({
    titanId,
    body: {
      action: 'hydra',
      id,
      text: hydraDelivery({ message }),
      actor,
    },
  })
}

// Recorded before Titan hears it, so the answer resolves the question even while Titan is down.
async function answerTitan({
  titanId,
  ref,
  id,
  choice: picked,
  text: typed,
  fromMessage,
  meta,
}: {
  titanId: string
  ref: string
  id: string
  choice?: string
  text?: string
  fromMessage?: string
  meta: Meta
}): Promise<Output> {
  const result = await commit({
    titanId,
    meta,
    intent: {
      type: 'titan.message',
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
        fromMessage: source,
        liftsHold,
      } = askAnswer({
        card,
        state,
        fromMessage,
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
          type: 'titan.message',
          data: {
            task: card.id,
            action: 'send',
            // Only the owner's words go in text, which the chat shows as theirs; Othrys's framing is context.
            text: answer,
            context: [
              `Answers question ${id}: ${question}`,
              ...picks,
            ].join('\n'),
            answers: id,
            fromMessage: source,
            liftsHold,
            ...(choice ? { choice } : {}),
            hydra: hydraConfig({
              state,
              id: titanId,
            }).hydra.id,
          },
        },
      })
    },
  })
  const event = result.event as { id?: string } | undefined

  if (fromMessage && event?.id) {
    return {
      ...result,
      answered: id,
    }
  }

  if (!event?.id) {
    return result
  }

  const hosted = await handToTitan({
    titanId,
    id: event.id,
    actor: meta.actor,
  })

  return {
    ...result,
    answered: id,
    hydra: hosted.state ?? 'not running',
  }
}

// An agent session's own actor beats --actor; commands the server runs for its page keep the server's.
const sessionActor = ({ meta }: { meta: Meta }): Meta => {
  const session = requestEnv().OTHRYS_ACTOR
  const agentSession = !!session && (session === TITAN_ACTOR || reportActor({ actor: session }))
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
  titanId,
  meta: m,
}: {
  ref: string
  positionals: string[]
  values: Values
  titanId: string
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
  const fromMessage = one({
    value: values['from-message'],
    flag: '--from-message',
  })
  const undelivered = values.undelivered === true
  const state = loadTitan({ titanId }).state
  const card = findCard({
    state,
    ref,
  })
  const repeat = m.id !== undefined
    && (m.id in state.eventIds || !!card.replies?.some(r => r.id === m.id))

  if (ownerActor({ actor: m.actor }) && picked === undefined && typed !== undefined
    && clarificationText({ text: typed })) {
    return questionActionCommand({
      titanId,
      ref,
      id,
      text: typed,
      meta: m,
    })
  }

  // Checked before routing so a missing route can't hide a refusal; the write checks again under the lock.
  if (!repeat) {
    askAnswer({
      card,
      id,
      actor: m.actor,
      state,
      fromMessage,
      choice: picked,
      text: typed,
      undelivered,
    })
  }

  const question = card.asks?.find(a => a.id === id)
  const acceptedReply = card.replies?.find(reply => reply.id === m.id && reply.accepted)

  if ((question?.actor === TITAN_ACTOR || question?.kind === 'merge') && !acceptedReply) {
    return answerTitan({
      titanId,
      ref,
      id,
      choice: picked,
      text: typed,
      fromMessage,
      meta: m,
    })
  }

  const receipt = await sendReply({
    titanId,
    request: {
      card: ref,
      text: '',
      actor: m.actor,
      ...(m.id ? { id: m.id } : {}),
      ...(reason ? { reason } : {}),
      ask: {
        id,
        choice: picked,
        fromMessage,
        text: typed,
        undelivered,
      },
    },
  })

  let help = [DELIVERY_HELP[receipt.state] ?? 'Delivery is uncertain: check the worker’s session; if the answer never arrived, repeat with --undelivered']

  if (fromMessage) {
    help = [`Answer recorded; delivery ${receipt.state}. Delivery does not change the saved decision.`]

    if (receipt.state === 'failed' && !receipt.recordError) {
      help.push(`Retry with reply ${card.id} --text "Resend saved answer" --idempotency-key ${receipt.reply}`)
    } else if (receipt.state !== 'delivered') {
      help.push(`Check the worker's session. Only if it never arrived, repeat task answer with --event-id ${receipt.reply} --undelivered`)
    }
  }

  return {
    ...receipt,
    help,
  }
}

async function askOne({
  ref,
  values,
  titanId,
  meta: m,
}: {
  ref: string
  values: Values
  titanId: string
  meta: Meta
}): Promise<Output> {
  const inline = text({ value: values.details })
  const file = text({ value: values['details-file'] })

  if (inline !== undefined && file !== undefined) {
    throw new TitanError({
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
      throw new TitanError({
        message: `--details-file cannot be read: ${(error as Error).message}`,
        code: 'VALIDATION_ERROR',
      })
    }
  }

  const recommend = one({
    value: values.recommend,
    flag: '--recommend',
  })
  const to = values.to ?? (m.actor === TITAN_ACTOR ? 'owner' : 'hydra')

  if (to !== 'hydra' && to !== 'owner') {
    throw new TitanError({
      message: '--to takes hydra or owner',
      code: 'VALIDATION_ERROR',
    })
  }

  // One lock, so Titan never hears a question that was not recorded.
  const written = await withWriter({
    titanId,
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
        kind: text({ value: values.kind }),
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
        throw new TitanError({
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
            type: 'titan.message',
            data: {
              task: card.id,
              action: 'send',
              text: askReport({
                task: card.id,
                ask,
                titanId,
              }),
              ask: id,
              hydra: hydraConfig({
                state: writer.state,
                id: titanId,
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
  const state = loadTitan({ titanId }).state
  const ask = Object.values(state.cards).flatMap(c => c.asks ?? [])
    .find(a => a.id === id)
  const message = state.hydraMessages?.find(msg => msg.ask === id)
  const help = ask?.audience === 'owner'
    ? 'The owner answers it in the task; wait for that answer before work that depends on it'
    : 'Titan answers or escalates it; keep working on what does not depend on the answer, which arrives as a message'
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
    ...await handToTitan({
      titanId,
      id: message.id,
      actor: m.actor,
    }),
  }
}

async function questionActionCommand({
  titanId,
  ref,
  id,
  until,
  text,
  fromMessage,
  meta,
}: {
  titanId: string
  ref: string
  id: string
  until?: string
  text?: string
  fromMessage?: string
  meta: Meta
}): Promise<Output> {
  const written = await commit({
    titanId,
    meta,
    intent: {
      type: until === undefined ? 'titan.message' : 'task.ask.deferred',
      card: ref,
    },
    decide: ({ state }) => decideQuestionAction({
      state,
      ref,
      id,
      until,
      text,
      fromMessage,
      meta,
    }),
  })
  const event = written.event as { id?: string } | undefined

  if (until === undefined && event?.id) {
    await handToTitan({
      titanId,
      id: event.id,
      actor: meta.actor,
    })
  }

  if (until === undefined) {
    return {
      ...written,
      clarification: id,
      help: ['Clarification sent to Titan; the question remains open'],
    }
  }

  return written
}

async function answerGroup({
  ref,
  values,
  titanId,
  meta,
}: {
  ref: string
  values: Values
  titanId: string
  meta: Meta
}): Promise<Output> {
  if (!ownerActor({ actor: meta.actor })) {
    inform({
      reason: 'Question group answered by an agent',
      clear: 'othrys task questions',
    })
  }

  const attempt = required({
    value: meta.id,
    what: '--event-id for this group answer',
  })
  const choice = required({
    value: one({
      value: values.choice,
      flag: '--choice',
    }),
    what: '--choice with the shared choice label',
  })
  const snapshot = required({
    value: text({ value: values.questions }),
    what: '--questions with the question keys from task questions',
  })
  let members: unknown

  try {
    members = JSON.parse(snapshot)
  } catch {
    throw new TitanError({
      code: 'VALIDATION_ERROR',
      message: '--questions must be a JSON array of question keys',
    })
  }

  if (!Array.isArray(members) || !members.length || !members.every((key): key is string => {
    if (typeof key !== 'string') {
      return false
    }

    const parts = key.split('/')

    return parts.length === 3 && !!parts[0] && !!parts[1]
  }) || new Set(members).size !== members.length) {
    throw new TitanError({
      code: 'VALIDATION_ERROR',
      message: '--questions must contain unique question keys',
    })
  }

  const state = loadTitan({ titanId }).state
  const card = findCard({
    state,
    ref,
  })
  const cardsByKey = new Map(Object.values(state.cards).map(card => [
    encodeURIComponent(card.id),
    card,
  ]))
  const selected = members.map(key => {
    const [
      task,
      id,
    ] = key.split('/')
    const target = cardsByKey.get(task)
    const ask = target?.asks?.find(ask => encodeURIComponent(ask.id) === id && ask.audience === 'owner')
    const event = `${attempt}:${key}`
    const root = target && questionGroupCard({
      state,
      card: target,
    })

    if (!target || !ask || root?.id !== card.id) {
      throw new TitanError({
        code: 'CONFLICT',
        message: 'The question group changed; read task questions again',
      })
    }

    const priorReply = target.replies?.find(reply => reply.id === event
      && reply.decision?.questionId === ask.id)
    const answeredByAttempt = ask.answered === event
    const recorded = answeredByAttempt || priorReply !== undefined
    const priorChoice = priorReply ? priorReply.decision?.choice : ask.choice

    if (recorded && priorChoice !== choice) {
      throw new TitanError({
        code: 'CONFLICT',
        message: 'This group attempt already recorded a different choice',
      })
    }

    const inFlight = priorReply?.state === 'queued' || priorReply?.state === 'delivery_unknown'
    const repeat = answeredByAttempt || inFlight || priorReply?.accepted === true

    return {
      key,
      card: target,
      ask,
      event,
      repeat,
      delivery: priorReply?.state,
    }
  })
  const pending = selected.filter(member => !member.repeat)
  const group = ownerQuestionGroups({ state }).find(group => group.card.id === card.id)
  const current = group?.decisions.map(decision => decisionKey({ decision })) ?? []

  const groupChanged = current.length !== pending.length
    || pending.some(member => !current.includes(member.key))

  if (pending.length && groupChanged) {
    throw new TitanError({
      code: 'CONFLICT',
      message: 'The question group changed; read task questions again',
    })
  }

  if (pending.length && !group?.choices.includes(choice)) {
    throw new TitanError({
      code: 'VALIDATION_ERROR',
      message: 'Use a shared choice label; answer different decisions individually',
    })
  }

  for (const member of pending) {
    const index = member.ask.options?.findIndex(option => option.label === choice)

    if (index === undefined || index < 0) {
      throw new TitanError({
        code: 'VALIDATION_ERROR',
        message: 'Use a shared choice label; answer different decisions individually',
      })
    }

    askAnswer({
      card: member.card,
      id: member.ask.id,
      actor: meta.actor,
      choice: String(index + 1),
      state,
    })
  }

  const answers: Output[] = []
  const remaining = new Set(pending.map(member => member.key))

  for (const member of selected) {
    if (member.repeat) {
      answers.push({
        task: member.card.id,
        ask: member.ask.id,
        repeat: true,
        state: member.delivery,
      })
      continue
    }

    // Sending an earlier answer can yield while the owner or a worker changes the group.
    const latest = loadTitan({ titanId }).state
    const latestGroup = ownerQuestionGroups({ state: latest })
      .find(group => group.card.id === card.id)
    const latestKeys = latestGroup?.decisions.map(decision => decisionKey({ decision }))
    const latestAsk = latest.cards[member.card.id]?.asks?.find(ask => ask.id === member.ask.id)
    const index = latestAsk?.options?.findIndex(option => option.label === choice)

    const changed = !latestKeys || latestKeys.length !== remaining.size
      || latestKeys.some(key => !remaining.has(key))

    if (changed || !latestGroup?.choices.includes(choice) || index === undefined || index < 0) {
      throw new TitanError({
        code: 'CONFLICT',
        message: 'The question group changed during delivery. Earlier answers may have been sent. Read task questions again.',
      })
    }

    answers.push(await answerCommand({
      ref: member.card.id,
      positionals: [
        'answer',
        member.card.id,
        member.ask.id,
      ],
      values: {
        choice: String(index + 1),
      },
      titanId,
      meta: {
        ...meta,
        id: member.event,
      },
    }))
    const after = ownerQuestionGroups({ state: loadTitan({ titanId }).state })
      .find(group => group.card.id === card.id)
    const stillWaiting = after?.decisions.some(decision => decisionKey({ decision }) === member.key)

    if (!stillWaiting) {
      remaining.delete(member.key)
    }
  }

  return {
    group: card.id,
    answers,
    stateSeq: loadTitan({ titanId }).state.seq,
  }
}

export async function askCommand({
  action,
  positionals,
  values,
  titanId,
  meta: given,
}: {
  action: 'ask' | 'answer' | 'answer-group' | 'escalate' | 'close-question' | 'reopen-question' | 'reask' | 'defer-question' | 'discuss-question'
  positionals: string[]
  values: Values
  titanId: string
  meta: Meta
}): Promise<Output> {
  const m = sessionActor({ meta: given })
  const ref = required({
    value: positionals[1],
    what: 'task id',
  })

  if (action === 'defer-question' || action === 'discuss-question') {
    return questionActionCommand({
      titanId,
      ref,
      id: required({
        value: positionals[2],
        what: 'question id',
      }),
      until: action === 'defer-question' ? required({
        value: text({ value: values.until }),
        what: '--until',
      }) : undefined,
      text: text({ value: values.text }),
      fromMessage: text({ value: values['from-message'] }),
      meta: m,
    })
  }

  if (action === 'close-question' || action === 'reopen-question' || action === 'reask') {
    return await commit({
      titanId,
      meta: m,
      intent: {
        type: action === 'close-question' ? 'task.ask.closed' : 'task.ask.reopened',
        card: ref,
      },
      decide: ({ state }) => decideAskClosure({
        state,
        ref,
        id: required({
          value: positionals[2],
          what: 'question id',
        }),
        evidence: text({ value: values.evidence }),
        reopen: action === 'reopen-question',
        reask: action === 'reask',
        answer: text({ value: values.answer }),
        meta: m,
      }),
    })
  }

  if (action === 'answer-group') {
    return answerGroup({
      ref,
      values,
      titanId,
      meta: m,
    })
  }

  if (action === 'answer') {
    return answerCommand({
      ref,
      positionals,
      values,
      titanId,
      meta: m,
    })
  }

  if (action === 'ask') {
    return askOne({
      ref,
      values,
      titanId,
      meta: m,
    })
  }

  if (!explained({ meta: m })) {
    inform({
      reason: 'Question escalated without a reason',
      clear: 'Record why the question needs an owner decision in the UI.',
    })
  }

  return {
    ...await commit({
      titanId,
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
        options: values.choice === undefined ? undefined : strings({ value: values.choice }).map(
          raw => choice({ raw }),
        ),
        recommended: values.recommend === undefined ? undefined : Number(one({
          value: values.recommend,
          flag: '--recommend',
        })),
        undelivered: values.undelivered === true,
        meta: m,
      }),
    }),
    help: ['The question now waits for the owner; work that depends on it waits for their answer'],
  }
}

import { copySettling } from '#projects/copy-lease.ts'
import { compactCommand } from '#workers/compaction/state.ts'
import { resolveSkillReferences } from '#hydra/skill-invocation.ts'
import { notificationReceipt } from './inbox-notice.ts'
import { steeringHeld } from './steering.ts'
import { notifySteering } from './inbox-delivery.ts'
import { enqueueSteering } from './inbox.ts'
import { mentionContext } from '#hydra/mentions.ts'
import { answerPrompt, answerText, checkAnswer, requestId } from './answers.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { decideReply } from './reply-rules.ts'
import { deliver, routeName } from './reply-delivery.ts'
import { HydraError } from '#store/errors.ts'
import type { RepliedEvent } from '#tasks/model.ts'
import type { ReplyState } from './model.ts'
import { KEY_LABEL, inputReason, type Key } from './controls.ts'
import { replyRoute } from './reply-route.ts'
import { STATUS_KEY, TASK_ID, resolveHome } from '#integrations/firstmate/home.ts'
import { answerKeys, type KeyStep } from '#integrations/hooks/answer.ts'
import { HOOK, waitsOnHook } from '#integrations/hooks/observe.ts'
import type { Delivery } from '#integrations/hooks/terminal.ts'
import type { Connect } from '#integrations/paseo/client.ts'
import { withWriter } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { askAnswer } from '#tasks/ask-decide.ts'
import { isManagedTask } from '#tasks/select.ts'

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
  answer?: {
    request: string
    value: unknown
    seen?: string
  }
  // A setting a Pnyx-hosted agent takes directly, in place of typed text.
  setting?: {
    name: string
    value: string
  }
  taskMessage?: boolean
  ask?: {
    id: string
    choice?: string
    fromMessage?: string
    text?: string
    undelivered?: boolean
  }
  reason?: string
  steering?: string
}

export interface ReplyReceipt {
  card: string
  reply: string
  state: ReplyState
  sent: boolean
  detail?: string
  // Set when the send ran but its outcome could not be written; the Hydra still
  // shows the reply as queued.
  recordError?: string
}

export function invalid({
  message,
  help = [],
}: {
  message: string
  help?: string[]
}): HydraError {
  return new HydraError({
    message,
    code: 'VALIDATION_ERROR',
    help,
  })
}

export async function sendReply({
  hydraId,
  request,
  connectPaseo,
}: {
  hydraId: string
  request: ReplyRequest
  connectPaseo?: Connect
}): Promise<ReplyReceipt> {
  const {
    resolveKey,
    answer,
  } = request

  if (!answer && !request.ask && request.text.trim() === '') {
    throw invalid({ message: 'reply text is empty' })
  }

  const keyed = resolveKey !== undefined || request.key || request.control

  if (answer && keyed) {
    throw invalid({ message: '--answer cannot be combined with a key, setting or --resolve-key' })
  }

  if (request.ask && (keyed || answer)) {
    throw invalid({ message: 'a question\'s answer cannot be combined with --answer, a key, a setting or --resolve-key' })
  }

  if (request.ask?.fromMessage && request.text.trim() && /^\//.test(request.text.trimStart())) {
    throw invalid({ message: 'a question relay takes a message, not a native command' })
  }

  const meta = (): Meta => ({
    at: new Date().toISOString(),
    actor: request.actor ?? 'cli',
    ...(request.reason ? { reason: request.reason } : {}),
  })
  const homes = request.homes.map(path => resolveHome({ path }))

  const queued = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = findCard({
        state: writer.state,
        ref: request.card,
      })

      if (request.expectedSession && card.sessionIds?.[0] !== request.expectedSession) {
        throw new HydraError({
          message: 'the attached agent changed before the brief could be sent',
          code: 'SESSION_CONFLICT',
        })
      }

      const reply = request.id ?? `r${writer.state.seq + 1}`
      const known = card.replies?.find(receipt => receipt.id === reply)

      const differentQuestion = request.ask && known?.answers !== request.ask.id
      const recordedSource = known?.decision?.fromMessage?.id
      const differentSource = request.ask && recordedSource !== request.ask.fromMessage
      const legacyOwnerAnswer = request.ask?.fromMessage !== undefined && !known?.accepted

      if (known && request.ask && (differentQuestion || differentSource || legacyOwnerAnswer)) {
        throw new HydraError({
          message: 'this reply key belongs to a different question, owner message or answer attempt',
          code: 'CONFLICT',
        })
      }

      if (known?.accepted && (keyed || answer || request.setting || request.taskMessage)) {
        throw invalid({ message: 'a saved owner answer can only retry its original message' })
      }

      const currentAnswer = card.asks?.some(ask => ask.id === known?.answers
        && ask.answered === known?.id)

      if (known?.accepted && !currentAnswer) {
        throw new HydraError({
          message: 'the recorded answer was undone or replaced; do not resend it',
          code: 'ASK_CLOSED',
        })
      }

      const checkedUndelivered = known?.accepted && request.ask?.undelivered
        && (known.state === 'queued' || known.state === 'delivery_unknown')

      if (known && known.state !== 'failed' && !checkedUndelivered) {
        return {
          card: card.id,
          reply,
          state: known.state,
          resend: false,
        }
      }

      let built: ReturnType<typeof askAnswer> | undefined

      if (request.ask && !known?.accepted) {
        built = askAnswer({
          card,
          state: writer.state,
          fromMessage: request.ask.fromMessage,
          id: request.ask.id,
          actor: request.actor ?? 'cli',
          choice: request.ask.choice,
          text: request.ask.text,
          undelivered: request.ask.undelivered,
        })
      }

      const accepted = Boolean(built?.decision.fromMessage)
      const retained = known?.accepted === true
      const found = replyRoute({
        card,
        homes,
      })

      if ('reason' in found && !accepted && !retained) {
        const home = card.sourceRefs.find(r => r.adapter === 'firstmate')?.instanceId

        if (home && found.reason.includes('not configured')) {
          throw invalid({
            message: `card ${card.id} belongs to Firstmate home ${home}, which is not configured`,
            help: [`Pass --home ${home} to allow replies to it`],
          })
        }

        throw new HydraError({
          message: `card ${card.id} has no reply route: ${found.reason}`,
          code: 'NO_ROUTE',
        })
      }

      const route = 'route' in found ? found.route : undefined
      const routeDetail = 'reason' in found ? found.reason : undefined

      const key = request.key
      const unpressable = key && route && inputReason({
        kind: route.kind,
        input: { key },
      })

      if (unpressable) {
        throw new HydraError({
          message: `card ${card.id} cannot take ${KEY_LABEL[key!]}: ${unpressable}`,
          code: 'NO_ROUTE',
        })
      }

      if (request.control && route?.kind !== 'firstmate' && waitsOnHook({ attention: card.attention })) {
        throw new HydraError({
          message: `card ${card.id} is waiting on a request; answer it in the session before changing settings`,
          code: 'SESSION_WAITING',
        })
      }

      if (route?.kind === 'firstmate') {
        if (!TASK_ID.test(route.task)) {
          throw new HydraError({
            message: `card ${card.id} has no reply route`,
            code: 'NO_ROUTE',
            help: ['Reply to a Firstmate task card'],
          })
        }

        // fm-send has no `--` separator, so a leading flag would be read as an option.
        if (request.text.startsWith('--')) {
          throw invalid({ message: 'reply text cannot start with --' })
        }
      } else if (resolveKey !== undefined) {
        throw invalid({ message: '--resolve-key answers Firstmate decisions; this card replies through its agent session' })
      }

      const entered = resolveSkillReferences({
        text: request.text,
        provider: card.agent?.provider,
      })
      const nativeCommand = route?.kind !== 'firstmate' && /^\/[a-zA-Z][\w:-]*(?:\s|$)/.test(entered.trimStart())
      const control = Boolean(request.control || request.key || request.setting || nativeCommand)
      let text = entered
      let keys: KeyStep[] | undefined
      let answers: string | undefined
      let answerDecision: RepliedEvent['data']['decision']

      if (built) {
        text = request.text.trim() ? entered : built.text
        answers = built.decision.questionId
        answerDecision = built.decision
      }

      if (retained) {
        text = known.text ?? ''
        answers = known.answers
        answerDecision = known.decision
      }

      if (answer) {
        const open = card.attention.find(a => a.key === answer.request)
        const prompt = open && answerPrompt({
          card,
          request: open,
        })

        if (!open || !prompt) {
          throw invalid({
            message: `card ${card.id} has no open request with key ${answer.request} that can be answered here`,
            help: [`Run \`pnyx-axi card ${card.id}\` to see its requests, or answer in the session itself`],
          })
        }

        answers = requestId({ request: open })

        if (answer.seen !== undefined && answer.seen !== answers) {
          throw new HydraError({
            message: `the request ${answer.request} changed since it was shown; nothing was typed`,
            code: 'REVISION_CONFLICT',
            help: [`Run \`pnyx-axi card ${card.id}\` and answer the current request`],
          })
        }

        // Keys typed after the prompt closed would land on the next one, so an answer
        // still being typed, or one that may have landed, holds the request.
        if (card.replies?.some(r => r.answers === answers && (r.state === 'queued' || r.state === 'delivery_unknown'))) {
          throw new HydraError({
            message: `an answer to ${answer.request} is already being typed or may have landed; nothing was typed`,
            code: 'SESSION_WAITING',
            help: ['Check the session, and answer there if its prompt is still open'],
          })
        }

        const checked = checkAnswer({
          prompt,
          request: open,
          value: answer.value,
        })

        if ('error' in checked) {
          throw invalid({ message: checked.error })
        }

        text = answerText({
          prompt,
          request: open,
          answer: checked.answer,
        })
        answerDecision = {
          question: open.questions?.map(question => question.question).join('\n') || open.text || open.kind,
          answer: answerText({
            prompt,
            request: open,
            answer: checked.answer,
            includeQuestion: false,
          }),
        }
        keys = answerKeys({
          provider: card.agent?.provider ?? '',
          request: open,
          answer: checked.answer,
        })
      }

      if (
        resolveKey !== undefined
      && (
        resolveKey === STATUS_KEY
        || resolveKey.startsWith(HOOK)
        || !card.attention.some(a => a.key === resolveKey)
      )
      ) {
        throw invalid({
          message: `card ${card.id} has no open decision with key ${resolveKey}`,
          help: [`Run \`pnyx-axi card ${card.id}\` to see its attention keys`],
        })
      }

      if (resolveKey) {
        const question = card.attention.find(request => request.key === resolveKey)
        answerDecision = {
          question: question?.text || question?.kind || resolveKey,
          answer: text,
        }
      }

      let context = !request.control && !request.key && !answer
        ? mentionContext({
          state: writer.state,
          text: request.text,
        }) : ''

      if (retained) {
        context = known.context ?? ''
      }

      // A retry after a failed send queues again, so every attempt has its own receipts.
      const ordinary = !control && !request.taskMessage && !answers && !resolveKey
      const resumes = ordinary && !steeringHeld({ card })
      const data = {
        reply,
        resumes,
        state: 'queued' as const,
        route: route ? routeName({
          route,
          control: request.control,
        }) : 'none',
        text,
        accepted: accepted || undefined,
        ...(context ? { context } : {}),
        ...(request.taskMessage ? { taskMessage: true } : {}),
        ...(control ? { control: true } : {}),
        ...(resolveKey ? { resolveKey } : {}),
        ...(answerDecision ? { decision: answerDecision } : {}),
        ...(answers ? { answers } : {}),
      }
      const payload = [
        request.ask || retained ? text : entered,
        context,
      ].filter(Boolean).join('\n\n')
      const nativeCompact = route?.kind === 'pnyx' && compactCommand({ text: payload })
      const steering = !nativeCompact && route?.kind !== 'firstmate' && !isManagedTask({ card })
        && !control && !answers && !resolveKey
        ? reply : undefined

      if (steering) {
        enqueueSteering({
          writer,
          ref: card.id,
          id: steering,
          text: payload,
          source: request.actor ?? 'cli',
          reply,
          meta: meta(),
        })
      }

      const decision = decideReply({
        state: writer.state,
        ref: card.id,
        data,
        meta: meta(),
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }

      return {
        card: card.id,
        reply,
        state: 'queued' as ReplyState,
        route,
        routeDetail,
        resend: true,
        control,
        steering,
        notificationAttempt: `initial:${reply}:${writer.state.seq}`,
        keys,
        answers,
        decision: answerDecision,
        accepted: accepted || retained,
        resumes,
        text: payload,
      }
    },
  })

  if (!queued.resend) {
    return {
      card: queued.card,
      reply: queued.reply,
      state: queued.state,
      sent: false,
    }
  }

  if (queued.steering && copySettling({
    hydraId,
    task: queued.card,
  })) {
    return {
      card: queued.card,
      reply: queued.reply,
      state: 'queued',
      sent: false,
    }
  }

  // Sent outside a write: a send can take a while and must not hold up other writes.
  const {
    card,
    reply,
    route,
    keys,
    answers,
  } = queued
  let outcome: Delivery

  if (!route) {
    outcome = {
      state: 'failed',
      detail: `no reply route: ${queued.routeDetail}`,
    }
  } else if (queued.steering && route.kind !== 'pnyx') {
    const notice = await notifySteering({
      hydraId,
      card,
      message: queued.steering,
      attempt: queued.notificationAttempt,
      connectPaseo,
    })
    outcome = {
      state: notificationReceipt(notice),
      detail: notice.detail,
    }
  } else {
    outcome = await deliver({
      hydraId,
      card,
      reply,
      route,
      request: {
        ...request,
        text: queued.text ?? request.text,
        steering: queued.steering,
      },
      keys,
    })
  }

  const receipt = {
    card,
    reply,
    sent: true,
    ...outcome,
  }

  try {
    withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const data = {
          reply,
          route: route ? routeName({
            route,
            control: request.control,
          }) : 'none',
          ...outcome,
          resumes: queued.resumes,
          accepted: queued.accepted || undefined,
          ...(queued.control ? { control: true } : {}),
          ...(request.taskMessage ? { taskMessage: true } : {}),
          ...(queued.decision ? { decision: queued.decision } : {}),
          ...(answers ? { answers } : {}),
        }
        const decision = decideReply({
          state: writer.state,
          ref: card,
          data,
          meta: meta(),
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })
  } catch (error) {
    return {
      ...receipt,
      recordError: (error as Error).message,
    }
  }

  return receipt
}

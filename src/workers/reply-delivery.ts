import { setTimeout as delay } from 'node:timers/promises'
import { HydraError } from '#store/errors.ts'
import type { ReplyRoute } from './reply-route.ts'
import { fmNote, fmSend, noteRequestId } from '#integrations/firstmate/reply.ts'
import type { KeyStep } from '#integrations/hooks/answer.ts'
import { waitsOnHook } from '#integrations/hooks/observe.ts'
import { pressKey, pressKeys, typeInto, type Delivery } from '#integrations/hooks/terminal.ts'
import { paseoReply } from '#integrations/paseo/reply.ts'
import { askHost } from '#app/server-state.ts'
import { withWriter } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import type { ReplyRequest } from './reply.ts'

export function routeName({
  route,
  control,
}: {
  route: ReplyRoute
  control?: boolean
}): string {
  return route.kind === 'firstmate' ? (control ? 'firstmate:inbox' : 'firstmate')
    : route.kind === 'paseo-agent' || route.kind === 'pnyx' ? route.kind : `terminal:${route.kind}`
}

// Time for Claude Code to show its confirmation after a model or effort command.
const CONFIRM_SETTLE_MS = 1500

export async function deliver({
  hydraId,
  card,
  reply,
  route,
  request,
  keys,
}: {
  hydraId: string
  card: string
  reply: string
  route: ReplyRoute
  request: ReplyRequest
  keys?: KeyStep[]
}): Promise<Delivery> {
  const {
    text,
    key,
    confirm,
    resolveKey,
  } = request

  if (keys && route.kind === 'tmux') {
    return await pressKeys({
      route,
      steps: keys,
    })
  }

  if (route.kind === 'firstmate') {
    return request.control
      ? fmNote({
        home: route.home,
        requestId: noteRequestId({
          hydraId,
          card,
          reply,
        }),
        text,
      })
      : fmSend({
        route,
        text,
        resolveKey,
      })
  }

  if (route.kind === 'paseo-agent') {
    return paseoReply({
      route,
      text,
      id: reply,
    })
  }

  if (route.kind === 'pnyx') {
    return hostReply({
      hydraId,
      card,
      text,
      inputId: reply,
      steering: request.steering,
      direct: !request.steering,
      setting: request.setting,
      actor: request.actor,
    })
  }

  const sent = key ? await pressKey({
    route,
    key,
  }) : await typeInto({
    route,
    text,
  })

  if (!confirm || sent.state !== 'delivered') {
    return sent
  }

  // Claude Code asks to confirm a model or effort change while its prompt cache is
  // warm, with Yes selected, and an Enter at an empty prompt does nothing. A request
  // the session opened meanwhile would take that Enter instead, so then none is pressed.
  await delay(CONFIRM_SETTLE_MS)

  if (withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })

      return waitsOnHook({ attention: writer.state.cards[card]?.attention })
    },
  })) {
    return {
      state: 'delivery_unknown',
      detail: 'the command was sent, then the session opened a request, so Pnyx pressed nothing more; answer it and any confirmation in the session',
    }
  }

  const answered = await pressKey({
    route,
    key: 'enter',
  })

  return answered.state === 'delivered'
    ? sent
    : {
      state: 'delivery_unknown',
      detail: `the command was sent, but the Enter that answers its confirmation was not${answered.detail ? ` (${answered.detail})` : ''}; check the session`,
    }
}

async function hostReply({
  hydraId,
  card,
  text,
  setting,
  steering,
  direct,
  actor,
  inputId,
}: {
  hydraId: string
  card: string
  text: string
  setting?: ReplyRequest['setting']
  steering?: string
  direct?: boolean
  actor?: string
  inputId?: string
}): Promise<Delivery> {
  try {
    const accepted = await askHost({
      hydraId,
      body: setting
        ? {
          action: 'set',
          card,
          setting: setting.name,
          value: setting.value,
          ...(actor ? { actor } : {}),
        }
        : {
          action: 'send',
          card,
          text,
          steering,
          direct,
          inputId,
          ...(actor ? { actor } : {}),
        },
    })

    if (accepted.queued) {
      return { state: 'queued' }
    }

    if (accepted.deferred) {
      return {
        state: 'delivery_unknown',
        detail: 'instruction persisted; notification deferred while the worker is held',
      }
    }

    // A direct input is delivered only once the provider confirms the agent got it.
    if (accepted.pending) {
      return { state: 'queued' }
    }

    return { state: 'delivered' }
  } catch (error) {
    const known = error instanceof HydraError

    return known
      ? {
        state: 'failed',
        detail: `${error.message}; nothing was sent`,
      }
      : {
        state: 'delivery_unknown',
        detail: 'the Pnyx server did not confirm the message; check the conversation before retrying',
      }
  }
}

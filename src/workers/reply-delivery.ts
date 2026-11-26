import { setTimeout as delay } from 'node:timers/promises'
import { TitanError } from '#store/errors.ts'
import type { ReplyRoute } from './reply-route.ts'
import type { KeyStep } from '#integrations/hooks/answer.ts'
import { waitsOnHook } from '#integrations/hooks/observe.ts'
import { pressKey, pressKeys, typeInto, type Delivery } from '#integrations/hooks/terminal.ts'
import { askHost } from '#app/server-state.ts'
import { withWriter } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import type { ReplyRequest } from './reply.ts'

export function routeName({ route }: { route: ReplyRoute }): string {
  return route.kind === 'othrys' ? route.kind : `terminal:${route.kind}`
}

// Time for Claude Code to show its confirmation after a model or effort command.
const CONFIRM_SETTLE_MS = 1500

export async function deliver({
  titanId,
  card,
  reply,
  route,
  request,
  keys,
}: {
  titanId: string
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
  } = request

  if (keys && route.kind === 'tmux') {
    return await pressKeys({
      route,
      steps: keys,
    })
  }

  if (route.kind === 'othrys') {
    return hostReply({
      titanId,
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

  if (await withWriter({
    titanId,
    fn: ({ writer }) => {
      drainSpool({ writer })

      return waitsOnHook({ attention: writer.state.cards[card]?.attention })
    },
  })) {
    return {
      state: 'delivery_unknown',
      detail: 'the command was sent, then the session opened a request, so Othrys pressed nothing more; answer it and any confirmation in the session',
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
  titanId,
  card,
  text,
  setting,
  steering,
  direct,
  actor,
  inputId,
}: {
  titanId: string
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
      titanId,
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
        detail: 'instruction persisted; notification deferred until the worker can resume',
      }
    }

    // A direct input is delivered only once the provider confirms the agent got it.
    if (accepted.pending) {
      return { state: 'queued' }
    }

    return { state: 'delivered' }
  } catch (error) {
    const known = error instanceof TitanError

    return known
      ? {
        state: 'failed',
        detail: `${error.message}; nothing was sent`,
      }
      : {
        state: 'delivery_unknown',
        detail: 'the Othrys server did not confirm the message; check the conversation before retrying',
      }
  }
}

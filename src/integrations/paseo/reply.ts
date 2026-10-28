import { notificationState, type NotificationResult } from '../../workers/inbox-notice.ts'
import type { ReplyRoute } from '../../workers/reply-route.ts'
import type { Delivery } from '../hooks/terminal.ts'
import { openPaseo, type Connect } from './client.ts'

export async function paseoReply({
  route,
  text,
  id,
  connect = openPaseo,
  canSend = () => true,
}: {
  route: Extract<ReplyRoute, { kind: 'paseo-agent' }>
  text: string
  id: string
  connect?: Connect
  canSend?: () => boolean
}): Promise<Delivery & { endpoint?: 'gone' }> {
  let client

  try {
    client = await connect({ url: route.url })
  } catch {
    return {
      state: 'failed',
      endpoint: 'gone',
      detail: `Paseo is not running at ${route.url}; nothing was sent`,
    }
  }

  try {
    if (!canSend()) {
      return {
        state: 'failed',
        detail: 'instruction was handled, held or reassigned before notification; nothing was sent',
      }
    }

    // The reply id is Paseo's message id too, so both records name the same message.
    await client.agents.ref(route.agent).send(
      text,
      { messageId: id },
    )

    return { state: 'delivered' }
  } catch {
    return {
      state: 'delivery_unknown',
      detail: 'Paseo did not confirm the message; check the conversation before retrying',
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

export async function paseoNotice({
  route,
  text,
  id,
  connect = openPaseo,
  canSend = () => true,
}: {
  route: Extract<ReplyRoute, { kind: 'paseo-agent' }>
  text: string
  id: string
  connect?: Connect
  canSend?: () => boolean
}): Promise<NotificationResult> {
  const delivered = await paseoReply({
    route,
    text,
    id,
    connect,
    canSend,
  })

  if (delivered.endpoint === 'gone') {
    return {
      result: 'gone',
      detail: delivered.detail,
    }
  }

  return {
    result: notificationState({ state: delivered.state }),
    detail: delivered.detail,
  }
}

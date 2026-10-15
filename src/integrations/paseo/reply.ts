import type { ReplyRoute } from '../../core/route.ts'
import type { Delivery } from '../hooks/terminal.ts'
import { openPaseo, type Connect } from './client.ts'

export async function paseoReply({ route, text, id, connect = openPaseo }: {
  route: Extract<ReplyRoute, { kind: 'paseo-agent' }>
  text: string
  id: string
  connect?: Connect
}): Promise<Delivery> {
  let client

  try {
    client = await connect({ url: route.url })
  } catch {
    return { state: 'failed', detail: `Paseo is not running at ${route.url}; nothing was sent` }
  }

  try {
    // The reply id is Paseo's message id too, so both records name the same message.
    await client.agents.ref(route.agent).send(text, { messageId: id })

    return { state: 'delivered' }
  } catch {
    return { state: 'delivery_unknown', detail: 'Paseo did not confirm the message; check the conversation before retrying' }
  } finally {
    await client.close().catch(() => undefined)
  }
}

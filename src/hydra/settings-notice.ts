import type { Meta } from '#app/command-meta.ts'
import { hydraActor } from '#app/request-context.ts'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'

const NOTICE_LENGTH = 180

export function settingsNotice({
  hydraId,
  meta,
  changeId,
  text,
}: {
  hydraId: string
  meta: Meta
  changeId: string
  text: string
}): void {
  if (!hydraActor({ actor: meta.actor })) {
    return
  }

  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        cardId: HYDRA_CARD,
        meta: {
          id: `settings:${changeId}`,
          at: meta.at,
          actor: 'pnyx',
        },
        change: {
          type: 'hydra.message',
          data: {
            action: 'send',
            kind: 'progress',
            text: text.replaceAll(
              /\s+/g,
              ' ',
            ).slice(
              0,
              NOTICE_LENGTH,
            ),
          },
        },
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }
    },
  })
}

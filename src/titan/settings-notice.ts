import type { Meta } from '#app/command-meta.ts'
import { hydraActor } from '#app/request-context.ts'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from './titan.ts'
import { TITAN_CARD } from './identity.ts'
import { hydraConfig } from './config.ts'

const NOTICE_LENGTH = 180

export async function settingsNotice({
  titanId,
  meta,
  changeId,
  text,
}: {
  titanId: string
  meta: Meta
  changeId: string
  text: string
}): Promise<void> {
  if (!hydraActor({ actor: meta.actor })) {
    return
  }

  await withWriter({
    titanId,
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        cardId: TITAN_CARD,
        meta: {
          id: `settings:${changeId}`,
          at: meta.at,
          actor: 'othrys',
        },
        change: {
          type: 'titan.message',
          data: {
            action: 'send',
            hydra: hydraConfig({
              state: writer.state,
              id: titanId,
            }).hydra.id,
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

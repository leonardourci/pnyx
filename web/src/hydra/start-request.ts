import { useRef } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function useStartRequest({
  card,
  firstmate,
  command,
  notify,
}: {
  card: Card
  firstmate: boolean
  command: Command
  notify({ text }: { text: string }): void
}) {
  const attempts = useRef({
    Start: crypto.randomUUID(),
    Resume: crypto.randomUUID(),
    Reassign: crypto.randomUUID(),
  })
  const [
    busy,
    run,
  ] = useBusy()
  const request = ({ intent }: { intent: 'Start' | 'Resume' | 'Reassign' }) => run({
    save: async () => {
      try {
        const fresh = intent === 'Resume' ? `Resume the worker on task ${card.id}: ${card.title}. Read its history and confirm the session can continue before resuming.` : intent === 'Reassign' ? `Reassign task ${card.id}: ${card.title}. Read its history and preserved context before choosing and attaching its next agent.` : card.agent ? `Start fresh from the brief for task ${card.id}: ${card.title}. Inspect its current attachment and task history before deciding how to replace it.` : undefined
        const result = await command(firstmate
          ? {
            name: 'task',
            args: [
              'start',
              card.id,
              '--via',
              'firstmate',
              '--event-id',
              attempts.current[intent],
              ...(fresh ? [
                '--prompt',
                fresh,
              ] : []),
            ],
          }
          : {
            name: 'hydra',
            args: [
              'send',
              '--task',
              card.id,
              '--action',
              intent === 'Resume' ? 'send' : 'worker',
              '--event-id',
              attempts.current[intent],
              ...(fresh ? [
                '--text',
                fresh,
              ] : []),
            ],
          })

        if (firstmate && result.sent !== 'delivered') {
          notify({ text: result.sent === 'failed' ? 'Request saved in Hydra’s chat. Firstmate could not be reached; retry the request to resend.' : 'Request saved in Hydra’s chat, but Firstmate delivery is unconfirmed. Check its inbox before retrying.' })

          return
        }

        attempts.current[intent] = crypto.randomUUID()
        notify({ text: firstmate ? `Sent to Firstmate; Hydra decides how to ${intent.toLowerCase()}.` : `${intent} requested in Hydra’s chat.` })
      } catch (error) {
        notify({ text: (error as Error).message })
      }
    },
  })

  return {
    start: () => request({ intent: 'Start' }),
    resume: () => request({ intent: 'Resume' }),
    reassign: () => request({ intent: 'Reassign' }),
    busy,
  }
}

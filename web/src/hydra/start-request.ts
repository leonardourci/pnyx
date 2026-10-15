import { useRef } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function useStartRequest({ card, firstmate, command, notify }: {
  card: Card
  firstmate: boolean
  command: Command
  notify({ text }: { text: string }): void
}) {
  const attempt = useRef(crypto.randomUUID())
  const [busy, run] = useBusy()
  const start = () => run({
    save: async () => {
      try {
        const result = await command(firstmate
          ? { name: 'task', args: ['start', card.id, '--via', 'firstmate', '--event-id', attempt.current] }
          : { name: 'hydra', args: ['send', '--task', card.id, '--action', 'worker', '--event-id', attempt.current] })

        if (result.sent === 'failed') {
          notify({ text: 'Request saved in Hydra’s chat. Firstmate could not be reached; try Start again to resend.' })

          return
        }

        attempt.current = crypto.randomUUID()
        notify({ text: firstmate ? 'Sent to Firstmate; it dispatches the worker.' : 'Start requested in Hydra’s chat.' })
      } catch (error) {
        notify({ text: (error as Error).message })
      }
    },
  })

  return { start, busy }
}

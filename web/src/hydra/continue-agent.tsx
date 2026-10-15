import { useEffect, useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'
import type { Command, Receipt } from './connection.ts'

export function ContinueAgent({ card, command, connected, fresh, notify }: {
  card: Card
  command: Command
  connected: boolean
  fresh(): void
  notify({ text }: { text: string }): void
}) {
  const [status, setStatus] = useState<Receipt | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let closed = false, retry: ReturnType<typeof setTimeout> | undefined
    setStatus(null)

    const check = async () => {
      try {
        const result = await command({ name: 'task', args: ['continue', card.id, '--check'] })

        if (!closed) {
          setStatus(result)

          if (result.state === 'present' && (card.activity === 'ended' || card.sessionActivity === 'ended')) {
            retry = setTimeout(() => void check(), 1000)
          }
        }
      } catch {
        if (!closed) {
          setStatus(null)
        }
      }
    }

    if (connected) {
      void check()
    }

    return () => {
      closed = true
      clearTimeout(retry)
    }
  }, [card.id, card.revision, card.activity, card.sessionActivity, command, connected])

  if (!status?.canContinue) {
    return null
  }

  const run = async () => {
    setBusy(true)

    try {
      if (status.folderMissing) {
        fresh()
      } else {
        await command({ name: 'task', args: ['continue', card.id, '--event-id', crypto.randomUUID()] })
        notify({ text: 'Session attached to Pnyx. Send a message to continue.' })
      }
    } catch (error) {
      notify({ text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="request">
      <p>{status.folderMissing ? 'The recorded folder is missing. Choose a folder to start fresh from the brief.' : 'The outside session has ended. Continue the same conversation in Pnyx.'}</p>
      <Button disabled={!connected || busy} onClick={() => void run()}>
        {status.folderMissing ? 'Start fresh from brief' : 'Continue in Pnyx'}
      </Button>
    </div>
  )
}

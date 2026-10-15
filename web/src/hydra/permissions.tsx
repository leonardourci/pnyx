import { useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import type { Command } from './connection.ts'

export function InlinePermissions({ card, command, notify }: {
  card: Card
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const answer = async ({ request, choice }: { request: string; choice: 'allow' | 'deny' }) => {
    setBusy(request)

    try {
      await command({ name: 'task', args: ['permission', card.id, request, choice] })
      notify({ text: choice === 'allow' ? 'Permission allowed.' : 'Permission denied.' })
    } catch (error) {
      notify({ text: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {(card.permissions ?? []).map(request => (
        <article key={request.id} className={`ask${request.status !== 'pending' ? ' answered' : ''}`} aria-label="Tool permission">
          <strong className="ask-title"><Icon name="agent" size={14} />Asking permission · {request.tool}</strong>
          {request.description && <p>{request.description}</p>}
          <pre className="permission-input">{JSON.stringify(request.input, null, 2)}</pre>
          {request.status === 'pending'
            ? (
              <div className="row wrap">
                <Button variant="primary" disabled={busy !== null} onClick={() => void answer({ request: request.id, choice: 'allow' })}>Allow</Button>
                <Button variant="surface" disabled={busy !== null} onClick={() => void answer({ request: request.id, choice: 'deny' })}>Deny</Button>
              </div>
            )
            : <span className="receipt">{request.status === 'expired' ? 'Expired · agent no longer waiting' : request.status === 'allow' ? 'Allowed' : 'Denied'}</span>}
        </article>
      ))}
    </>
  )
}

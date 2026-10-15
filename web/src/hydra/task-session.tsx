import { useState } from 'react'
import type { HydraState, Card } from '../../../src/core/model.ts'
import { interactive } from '../../../src/core/tasks.ts'
import { Button, Select, useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function TaskSession({ card, state, command, connected, notify }: {
  card: Card
  state: HydraState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const [busy, run] = useBusy()
  const [failure, setFailure] = useState('')
  const attached = card.sessionIds?.[0]
  const session = attached ? state.sessions?.[attached] : undefined
  const candidates = Object.values(state.sessions ?? {}).filter(s => interactive({ session: s }))
  const flags = ['--if-revision', String(card.revision), '--event-id', crypto.randomUUID()]

  const attach = ({ id }: { id: string }) => {
    if (!id) {
      return
    }

    run({
      save: async () => {
        try {
          const receipt = await command({ name: 'task', args: ['attach', card.id, '--session', id, ...flags] })
          const brief = receipt.brief as { state: string } | undefined
          setFailure(!brief || brief.state === 'delivered' ? '' : 'Brief could not be delivered. It is kept in this task.')

          notify({ text: 'Agent attached.' })
        } catch (error) {
          setFailure('Brief could not be delivered. It is kept in this task.')
          notify({ text: (error as Error).message })
        }
      },
    })
  }

  return (
    <section aria-label="Task agent" className="task-session">
      <h3>Attached agent</h3>
      {failure && <p className="reply-failure" role="status">{failure}</p>}
      {session ? (
        <>
          <p>
            {session.agent.provider}
            {' · '}
            <span className="mono">{session.agent.sessionId}</span>
          </p>
          <Button
            disabled={!connected || busy}
            onClick={() => run({
              save: () => command({ name: 'task', args: ['detach', card.id, ...flags] })
                .then(() => notify({ text: 'Agent detached. Its session is still available.' }))
                .catch(error => notify({ text: error.message })),
            })}
          >
            Detach agent
          </Button>
        </>
      ) : (
        <>
          <p className="muted">Attach an existing interactive session to continue its conversation here.</p>
          <Select
            label="Attach agent session"
            value=""
            disabled={!connected || busy || !candidates.length}
            onChange={({ value }) => attach({ id: value })}
            options={[
              { value: '', label: candidates.length ? 'Choose a session' : 'No interactive sessions available' },
              ...candidates.map(s => ({
                value: s.id,
                label: `${s.agent.provider} · ${s.taskId ? `Move from ${state.cards[s.taskId]?.title ?? s.taskId}` : state.cards[s.originCardId]?.title ?? s.agent.sessionId}`,
              })),
            ]}
          />
        </>
      )}
    </section>
  )
}

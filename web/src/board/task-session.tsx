import type { BoardState, Card } from '../../../src/core/model.ts'
import { Button, Select, useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function TaskSession({ card, state, command, connected, notify }: {
  card: Card
  state: BoardState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const [busy, run] = useBusy()
  const attached = card.sessionIds?.[0]
  const session = attached ? state.sessions?.[attached] : undefined
  const candidates = Object.values(state.sessions ?? {}).filter(s => s.terminal?.tty)
  const flags = ['--if-revision', String(card.revision), '--event-id', crypto.randomUUID()]

  const attach = ({ id }: { id: string }) => {
    if (!id) {
      return
    }

    run({
      save: () => command({ name: 'task', args: ['attach', card.id, '--session', id, ...flags] })
        .then(() => notify({ text: 'Agent attached.' }))
        .catch(error => notify({ text: error.message })),
    })
  }

  return (
    <section aria-label="Task agent" className="task-session">
      <h3>Attached agent</h3>
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
                label: `${s.agent.provider} · ${s.taskId ? `Move from ${state.cards[s.taskId]?.title ?? s.taskId}` : s.agent.sessionId}`,
              })),
            ]}
          />
        </>
      )}
    </section>
  )
}

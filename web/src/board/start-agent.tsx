import { sessionId } from '../../../src/core/tasks.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { Button, Input, Select, Textarea, useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

const HARNESSES = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]
const ROUTES = [
  { value: 'pnyx', label: 'Pnyx (Claude Code)' },
  { value: 'paseo', label: 'Paseo' },
  { value: 'firstmate', label: 'Firstmate (this board\'s Hydra)' },
  { value: 'command', label: 'Board command' },
]
const STARTED: Record<string, string> = {
  pnyx: 'Agent started. Pnyx runs it; continue here.',
  paseo: 'Agent started in Paseo. Continue here or in Paseo.',
  firstmate: 'Sent to Firstmate; it dispatches the worker.',
  command: 'Board command started; its agent attaches when it reports.',
}

export function StartAgent({ card, firstmate, command, connected, replace = false, notify }: {
  card: Card
  firstmate: boolean
  command: Command
  connected: boolean
  replace?: boolean
  notify({ text }: { text: string }): void
}) {
  const [via, setVia] = useState(firstmate && !replace ? 'firstmate' : 'pnyx'), [harness, setHarness] = useState('claude')
  const [folder, setFolder] = useState(card.folder ?? ''), [message, setMessage] = useState(card.brief ?? '')
  const [paseo, setPaseo] = useState<{ ok: boolean; reason?: string } | null>(null)
  const [busy, run] = useBusy()
  // One id per attempt, so a retried click never starts a second worker.
  const attempt = useRef(crypto.randomUUID())
  const check = useCallback(() => {
    setPaseo(null)
    void command({ name: 'task', args: ['paseo'] }).then(() => setPaseo({ ok: true }), (e: Error) => setPaseo({ ok: false, reason: e.message }))
  }, [command])
  useEffect(() => {
    if (connected && via === 'paseo') {
      check()
    }
  }, [connected, check, via])

  const ready = connected && (via === 'paseo' ? paseo?.ok && folder.trim().startsWith('/') && message.trim()
    : via === 'pnyx' ? folder.trim().startsWith('/') : true)

  const start = () => run({
    save: async () => {
      try {
        const args = ['start', card.id, '--via', via, '--event-id', attempt.current]

        // The brief already opens the prompt, so an unchanged brief is not sent twice.
        if (message.trim() && message !== card.brief) {
          args.push('--prompt', message)
        }

        if (via !== 'firstmate' && folder.trim()) {
          args.push('--folder', folder.trim())
        }

        if (via === 'paseo') {
          args.push('--harness', harness)
        }

        if (replace && card.agent) {
          args.push('--replace-session', sessionId({ agent: card.agent }))
        }

        await command({ name: 'task', args })
        attempt.current = crypto.randomUUID()
        setMessage('')
        notify({ text: STARTED[via]! })
      } catch (e) {
        notify({ text: (e as Error).message })
      }
    },
  })

  return (
    <form
      className="start-agent"
      aria-label="Start an agent for this task"
      onSubmit={e => {
        e.preventDefault()

        if (ready) {
          start()
        }
      }}
    >
      <h3>Start an agent</h3>
      {!replace && (
        <Select
          label="Start through"
          value={via}
          options={ROUTES}
          onChange={({ value }) => setVia(value)}
        />
      )}
      {via === 'paseo' && (paseo === null ? <p className="small muted">Checking Paseo…</p> : !paseo.ok && (
        <div role="alert" className="request">
          <p>{paseo.reason}</p>
          <p className="small">
            Start it with
            {' '}
            <span className="mono">paseo start</span>
            {' '}
            or open the Paseo app.
          </p>
          <Button onClick={check}>Check again</Button>
        </div>
      ))}
      {via === 'paseo' && (
        <Select
          label="Agent"
          value={harness}
          options={HARNESSES}
          onChange={({ value }) => setHarness(value)}
        />
      )}
      {via !== 'firstmate' && (
        <label>
          Folder
          <Input
            value={folder}
            onChange={e => setFolder(e.target.value)}
            placeholder="/path/to/repository"
            spellCheck={false}
          />
        </label>
      )}
      <label>
        {via === 'paseo' ? 'Opening message' : 'Message (optional)'}
        <Textarea
          value={message}
          maxLength={32000}
          rows={4}
          onChange={e => setMessage(e.target.value)}
          placeholder="What the worker should start with"
        />
      </label>
      <Button
        type="submit"
        variant="primary"
        disabled={!ready || busy}
        aria-busy={busy}
      >
        {busy ? 'Starting…' : 'Start agent'}
      </Button>
    </form>
  )
}

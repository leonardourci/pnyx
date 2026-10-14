import { useCallback, useEffect, useRef, useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { Button, Input, Select, Textarea, useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

const HARNESSES = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]

// Starts a Claude Code or Codex agent in Paseo for this task, or for a new task
// typed here, with its folder and opening message. Paseo must be running.
export function StartAgent({ card, command, connected, notify, started }: {
  card?: Card
  command: Command
  connected: boolean
  notify(text: string): void
  started?(task: string): void
}) {
  const [title, setTitle] = useState(''), [harness, setHarness] = useState('claude')
  const [folder, setFolder] = useState(card?.folder ?? ''), [message, setMessage] = useState('')
  const [paseo, setPaseo] = useState<{ ok: boolean; reason?: string } | null>(null)
  const [busy, run] = useBusy()
  // One id per attempt, so a retried click never starts a second agent.
  const attempt = useRef({ task: crypto.randomUUID(), start: crypto.randomUUID() })
  const check = useCallback(() => {
    setPaseo(null)
    void command('task', ['paseo']).then(() => setPaseo({ ok: true }), (e: Error) => setPaseo({ ok: false, reason: e.message }))
  }, [command])
  useEffect(() => {
    if (connected) {
      check()
    }
  }, [connected, check])

  const ready = connected && paseo?.ok && folder.trim().startsWith('/') && message.trim() && (card || title.trim())

  const start = () => run(async () => {
    try {
      let task = card?.id

      if (!task) {
        const created = await command('task', ['create', '--title', title.trim(), '--folder', folder.trim(), '--event-id', attempt.current.task])
        task = (created.card as { id: string }).id
      }

      await command('task', ['start', task, '--harness', harness, '--prompt', message, '--folder', folder.trim(), '--event-id', attempt.current.start])
      attempt.current = { task: crypto.randomUUID(), start: crypto.randomUUID() }
      setMessage(''); setTitle('')
      notify('Agent started in Paseo. Continue here or in Paseo.')
      started?.(task)
    } catch (e) {
      notify((e as Error).message)
    }
  })

  return (
    <form
      className="start-agent"
      aria-label={card ? 'Start an agent for this task' : 'New task with an agent'}
      onSubmit={e => {
        e.preventDefault()

        if (ready) {
          start()
        }
      }}
    >
      <h3>{card ? 'Start agent' : 'New task'}</h3>
      {paseo === null ? <p className="small muted">Checking Paseo…</p> : !paseo.ok && (
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
      )}
      {!card && (
        <label>
          Task title
          <Input
            value={title}
            maxLength={200}
            onChange={e => setTitle(e.target.value)}
            placeholder="What should be done"
          />
        </label>
      )}
      <Select
        label="Agent"
        value={harness}
        options={HARNESSES}
        onChange={setHarness}
      />
      <label>
        Folder
        <Input
          value={folder}
          onChange={e => setFolder(e.target.value)}
          placeholder="/path/to/repository"
          spellCheck={false}
        />
      </label>
      <label>
        Opening message
        <Textarea
          value={message}
          maxLength={32000}
          rows={4}
          onChange={e => setMessage(e.target.value)}
          placeholder="What the agent should start with"
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

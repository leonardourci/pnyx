import { Fragment, useState } from 'react'
import type { AgentConfig, BoardState } from '../../../src/core/model.ts'
import { Button, Input, Select } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

const HARNESSES = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]
const QUOTA = [
  { value: 'off', label: 'Off: use the model below' },
  { value: 'high', label: 'Most runway, high intelligence' },
  { value: 'medium', label: 'Most runway, medium intelligence' },
  { value: 'low', label: 'Most runway, low intelligence' },
]
const FIELDS = [['model', 'Model'], ['effort', 'Effort'], ['mode', 'Mode']] as const

// Flags for `kind set`: every field, so a cleared one is cleared on the board too.
function flags({ agent }: { agent: AgentConfig }): string[] {
  return [
    '--harness',
    agent.harness,
    ...FIELDS.flatMap(([key]) => [`--${key}`, agent[key] ?? '']),
    '--quota',
    agent.quota ?? 'off',
  ]
}

// The agent each task kind's workers launch on; `hydra` is what Hydra starts on.
export function AgentKinds({ state, command, notify }: {
  state: BoardState
  command: Command
  notify({ text }: { text: string }): void
}) {
  const agents = state.board?.agents ?? {}
  const [name, setName] = useState('')
  const run = ({ args, done }: { args: string[]; done: string }) =>
    command({ name: 'kind', args }).then(() => {
      notify({ text: done })

      return true
    }, e => {
      notify({ text: e.message })

      return false
    })
  const save = ({ kind, agent }: { kind: string; agent: AgentConfig }) =>
    run({ args: ['set', kind, ...flags({ agent })], done: `Saved ${kind}` })

  return (
    <section className="settings-box" aria-label="Agents">
      <h2>Agents</h2>
      <p className="muted">
        What each kind of task launches its worker on. <code>default</code> covers tasks with no
        kind and <code>hydra</code> is what Hydra starts on; both use Claude Code&apos;s own
        defaults until set here.
      </p>
      {Object.entries(agents).map(([kind, agent]) => (
        <div key={kind} role="group" aria-label={`Kind ${kind}`}>
          <div className="row between">
            <h3>{kind}</h3>
            <Button onClick={() => run({ args: ['remove', kind], done: `Removed ${kind}` })}>Remove</Button>
          </div>
          <label className="setting-label">Harness</label>
          <Select
            label={`${kind} harness`}
            value={agent.harness}
            options={HARNESSES}
            onChange={({ value }) => save({ kind, agent: { ...agent, harness: value as AgentConfig['harness'] } })}
          />
          {FIELDS.map(([key, label]) => (
            <Fragment key={`${key}:${agent[key] ?? ''}`}>
              <label className="setting-label">{label}</label>
              <Input
                aria-label={`${kind} ${key}`}
                defaultValue={agent[key] ?? ''}
                placeholder="harness default"
                onBlur={e => e.target.value !== (agent[key] ?? '') && save({ kind, agent: { ...agent, [key]: e.target.value || undefined } })}
              />
            </Fragment>
          ))}
          <label className="setting-label">Pick by quota</label>
          <Select
            label={`${kind} quota`}
            value={agent.quota ?? 'off'}
            options={QUOTA}
            onChange={({ value }) => save({ kind, agent: { ...agent, quota: value === 'off' ? undefined : value as AgentConfig['quota'] } })}
          />
        </div>
      ))}
      <form
        className="row"
        onSubmit={e => {
          e.preventDefault()
          void save({ kind: name.trim(), agent: { harness: 'claude' } }).then(saved => saved && setName(''))
        }}
      >
        <Input
          aria-label="New kind"
          placeholder="default, hydra, review…"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <Button type="submit" variant="surface" disabled={!name.trim()}>Add kind</Button>
      </form>
    </section>
  )
}

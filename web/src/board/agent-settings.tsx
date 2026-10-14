import { useEffect, useState } from 'react'
import { KEY_LABEL, confirms, harnessControls, inputReason, type Control, type ControlOption } from '../../../src/core/control.ts'
import type { Card } from '../../../src/core/model.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import type { Command } from './connection.ts'

// Harnesses with their own mark; any other provider shows its name alone.
const HARNESSES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

// Every setting a harness reports, in the order shown. Each name has an icon of the
// same name; a setting not listed here shows under its own name with a plain icon.
const SETTINGS: Record<string, string> = {
  model: 'Model',
  effort: 'Effort',
  mode: 'Permission mode',
  fast: 'Fast mode',
  context: 'Context window',
  collaboration: 'Collaboration mode',
  approval: 'Approval policy',
  sandbox: 'Sandbox',
  summary: 'Reasoning summary',
  client: 'Client',
  version: 'Version',
}
// Shown on the card itself; the open card lists every setting.
const ON_CARD = ['model', 'effort', 'mode']

const label = (name: string) => SETTINGS[name] ?? name
// "bypassPermissions" reads as "bypass permissions"; model ids and versions stay as written.
const shown = (name: string, value: string) =>
  name === 'model' || name === 'version' ? value : value.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)

function ordered(settings: Record<string, string>): [string, string][] {
  const known = Object.keys(SETTINGS)
  const rank = (name: string) => (known.includes(name) ? known.indexOf(name) : known.length)

  return Object.entries(settings).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
}

export const harnessName = (provider: string) => HARNESSES[provider] ?? provider

export function Harness({ card }: { card: Card }) {
  const provider = card.agent?.provider
  const name = provider ? harnessName(provider) : card.sourceRefs[0]?.adapter ?? 'Manual'

  return (
    <span className="source harness" title={name}>
      {provider && provider in HARNESSES && <Icon name={provider} size={13} />}
      {name}
    </span>
  )
}

// The card's compact settings: model, effort and mode, plus fast mode while it is on.
// Hovering one shows its full name and value.
export function SettingChips({ settings }: { settings?: Record<string, string> }) {
  const chips = ordered(settings ?? {}).filter(([name, value]) => ON_CARD.includes(name) || (name === 'fast' && value === 'on'))

  return chips.length > 0 && (
    <div className="setting-chips">
      {chips.map(([name, value]) => (
        <span
          key={name}
          className="setting-chip"
          title={`${label(name)}: ${value}`}
          aria-label={`${label(name)}: ${value}`}
        >
          <Icon name={name} size={12} />
          {name === 'fast' ? 'Fast' : shown(name, name === 'model' ? value.replace(/^claude-/, '') : value)}
        </span>
      ))}
    </div>
  )
}

// Every setting the card's harness reported, for the open card.
export function SettingList({ settings }: { settings?: Record<string, string> }) {
  const entries = ordered(settings ?? {})

  return entries.length > 0 && (
    <dl className="setting-list" aria-label="Agent settings">
      {entries.map(([name, value]) => (
        <div key={name} title={`${label(name)}: ${value}`}>
          <dt>
            <Icon name={name} size={12} />
            {label(name)}
          </dt>
          <dd>{shown(name, value)}</dd>
        </div>
      ))}
    </dl>
  )
}

// What typing an option does, in the harness's own words; a Firstmate task's orchestrator gets a request note.
const typedAs = ({ option, kind }: { option: ControlOption; kind?: ThreadPage['routeKind'] }) =>
  kind === 'firstmate'
    ? "Asks Firstmate's orchestrator in a request note"
    : 'key' in option.input
      ? `Presses ${KEY_LABEL[option.input.key]} in the session`
      : `Types ${option.input.text} in the session`

// Why the route cannot press this control's keys, if it cannot.
const keyReason = ({ control, kind }: { control: Control; kind?: ThreadPage['routeKind'] }) =>
  kind && control.options.map(o => inputReason({ kind, input: o.input })).find(Boolean)

// A change sent and not yet reported back by the session; sending while the command
// itself is still on its way.
interface Pending { value: string; before?: string; sending: boolean }

// A request note a Firstmate task's change left with its orchestrator, as fm-inbox reports it.
interface Request { note: string; state: string; asked: string }

function ControlRow({
  control,
  now,
  pending,
  sending,
  blocked,
  why,
  kind,
  send,
}: {
  control: Control
  now?: string
  pending?: Pending
  // A change, to this or another setting, is on its way: one at a time.
  sending: boolean
  blocked?: string
  // Why this route cannot press this control's keys, shown under it.
  why?: string
  kind?: ThreadPage['routeKind']
  send({ option }: { option: ControlOption }): void
}) {
  const sent = pending && control.options.find(o => o.value === pending.value)

  return (
    <div className="control-row" role="group" aria-label={label(control.setting)}>
      <div className="row between">
        <span className="control-name">
          <Icon name={control.setting} size={12} />
          {label(control.setting)}
        </span>
        <span className="small muted">{now === undefined ? 'not reported' : shown(control.setting, now)}</span>
      </div>
      <div className="segmented">
        {control.options.map(option => (
          <Button
            key={option.value}
            variant="surface"
            title={blocked ?? typedAs({ option, kind })}
            aria-pressed={control.confirm !== 'changes' && now !== undefined && confirms({ control, option, before: undefined, after: now })}
            disabled={!!blocked || sending}
            onClick={() => send({ option })}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {why && <p className="small muted">{why}</p>}
      {sent && (
        <p className="small gold" role="status">
          {pending.sending
            ? `Sending ${sent.label}…`
            : `${kind === 'firstmate' ? 'Asked Firstmate for' : 'Sent'} ${sent.label}. Waiting for the session to report its ${label(control.setting).toLowerCase()}; it does on its next hook or turn.`}
        </p>
      )}
    </div>
  )
}

// Changes the session's settings by typing what its harness takes, on the card's
// reply route, and shows each change as pending until the session reports it.
export function AgentControls({
  card,
  thread,
  command,
  connected,
  notify,
}: {
  card: Card
  thread: ThreadPage | null
  command: Command
  connected: boolean
  notify(text: string): void
}) {
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [requests, setRequests] = useState<Request[] | string>([])
  const provider = card.agent?.provider
  const harness = harnessControls({ provider })
  const page = thread?.card === card.id ? thread : null
  const firstmate = connected && page?.routeKind === 'firstmate'
  useEffect(() => {
    setPending({})
    setRequests([])
  }, [card.id])
  // A new note is a new reply: its receipts, not each settings report, reload the notes.
  const replies = card.replies?.map(r => `${r.id}:${r.state}`).join(' ')
  useEffect(() => {
    let latest = true

    if (firstmate) {
      void command('agent', [card.id])
        .then(r => latest && setRequests(r.requests as Request[] | string))
        .catch((e: Error) => latest && setRequests(e.message))
    }

    return () => {
      latest = false
    }
  }, [firstmate, card.id, replies, command])
  useEffect(() => {
    setPending(current => {
      const left = Object.fromEntries(Object.entries(current).filter(([setting, p]) => {
        const control = harness?.controls.find(c => c.setting === setting)
        const option = control?.options.find(o => o.value === p.value)

        const after = card.settings?.[setting]

        return control && option && !confirms({ control, option, before: p.before, after })
      }))

      return Object.keys(left).length === Object.keys(current).length ? current : left
    })
  }, [card.settings, harness])

  if (!harness) {
    return (
      <p className="empty">
        {provider ? `Pnyx changes settings only for Claude Code and Codex sessions, not ${harnessName(provider)}.` : 'No agent session has joined this card yet, so there is nothing to change.'}
      </p>
    )
  }

  const route = !connected ? 'Reconnect to change settings.' : !page ? 'Loading the route…' : page.route ? undefined : page.noRoute

  const settle = ({ setting }: { setting: string }) =>
    setPending(p => Object.fromEntries(Object.entries(p).filter(([name]) => name !== setting)))

  const send = ({ control, option }: { control: Control; option: ControlOption }) => {
    const before = card.settings?.[control.setting]
    const sent = { value: option.value, ...(before === undefined ? {} : { before }) }
    setPending(p => ({ ...p, [control.setting]: { ...sent, sending: true } }))
    void command('agent', [card.id, control.setting, option.value, crypto.randomUUID()]).then(r => {
      const result = r.agent as { sent: string; confirmed: boolean; now: string } | undefined
      const help = (r.help as string[] | undefined)?.[0]

      if (result?.sent !== 'delivered' || result.confirmed) {
        settle({ setting: control.setting })
      } else {
        const waiting = { ...sent, sending: false }
        setPending(p => (p[control.setting] ? { ...p, [control.setting]: waiting } : p))
      }

      notify(result?.confirmed ? `${label(control.setting)} is now ${shown(control.setting, result.now)}.` : help ?? `Sent ${option.label}.`)
    })
      .catch((e: Error) => {
        settle({ setting: control.setting }); notify(e.message)
      })
  }

  return (
    <section className="agent-controls" aria-label="Change settings">
      <h3>Change from here</h3>
      <p className="small muted">
        {route ?? (firstmate
          ? "Sent to Firstmate's orchestrator as a request note; Pnyx never types into the worker."
          : `Typed into the session through ${page?.via ?? 'its route'}, as its own commands and keys.`)}
      </p>
      {harness.controls.map(control => (
        <ControlRow
          key={control.setting}
          control={control}
          now={card.settings?.[control.setting]}
          pending={pending[control.setting]}
          sending={Object.values(pending).some(p => p.sending)}
          blocked={route ?? keyReason({ control, kind: page?.routeKind })}
          why={route ? undefined : keyReason({ control, kind: page?.routeKind })}
          kind={page?.routeKind}
          send={({ option }) => send({ control, option })}
        />
      ))}
      {harness.note && <p className="small muted">{harness.note}</p>}
      {firstmate && (
        <div className="agent-requests" aria-label="Requests to Firstmate">
          <h3>Requests to Firstmate</h3>
          {typeof requests === 'string'
            ? <p className="small muted">{requests}</p>
            : requests.length === 0
              ? <p className="small muted">No request notes yet.</p>
              : (
                <ul>
                  {requests.map(r => (
                    <li key={r.note} className="small">
                      {r.asked}
                      {' '}
                      <span className="muted">{r.state}</span>
                    </li>
                  ))}
                </ul>
              )}
        </div>
      )}
    </section>
  )
}

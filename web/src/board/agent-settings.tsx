import type { Card } from '../../../src/core/model.ts'
import { Icon } from '../components/ui/icon.tsx'

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

const label = ({ name }: { name: string }) => SETTINGS[name] ?? name
// "bypassPermissions" reads as "bypass permissions"; model ids and versions stay as written.
const shown = ({ name, value }: { name: string; value: string }) =>
  name === 'model' || name === 'version' ? value : value.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)

function ordered({ settings }: { settings: Record<string, string> }): [string, string][] {
  const known = Object.keys(SETTINGS)
  const rank = ({ name }: {
    name: string
  }) =>
    (known.includes(name) ? known.indexOf(name) : known.length)

  return Object.entries(settings).sort(([a], [b]) =>
    rank({
      name: a,
    }) - rank({
      name: b,
    }) || a.localeCompare(b))
}

export const harnessName = ({ provider }: { provider: string }) => HARNESSES[provider] ?? provider

export function Harness({ card }: { card: Card }) {
  const provider = card.agent?.provider
  const name = provider ? harnessName({ provider }) : card.sourceRefs[0]?.adapter ?? 'Manual'

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
  const chips = ordered({ settings: settings ?? {} }).filter(([name, value]) => ON_CARD.includes(name) || (name === 'fast' && value === 'on'))

  return chips.length > 0 && (
    <div className="setting-chips">
      {chips.map(([name, value]) => (
        <span
          key={name}
          className="setting-chip"
          title={`${label({ name })}: ${value}`}
          aria-label={`${label({ name })}: ${value}`}
        >
          <Icon name={name} size={12} />
          {name === 'fast' ? 'Fast' : shown({ name, value: name === 'model' ? value.replace(/^claude-/, '') : value })}
        </span>
      ))}
    </div>
  )
}

// Every setting the card's harness reported, for the open card.
export function SettingList({ settings }: { settings?: Record<string, string> }) {
  const entries = ordered({ settings: settings ?? {} })

  return entries.length > 0 && (
    <dl className="setting-list" aria-label="Agent settings">
      {entries.map(([name, value]) => (
        <div key={name} title={`${label({ name })}: ${value}`}>
          <dt>
            <Icon name={name} size={12} />
            {label({ name })}
          </dt>
          <dd>{shown({ name, value })}</dd>
        </div>
      ))}
    </dl>
  )
}

import { useEffect, useState } from 'react'
import { confirms, harnessControls, inputReason, type Control, type ControlOption } from '../../../src/core/control.ts'
import type { Card } from '../../../src/core/model.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Button, Select } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import type { Command } from './connection.ts'

const HARNESSES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

const SETTINGS: Record<string, string> = { model: 'Model', effort: 'Effort', mode: 'Mode', fast: 'Fast', collaboration: 'Mode' }

const label = ({ name }: { name: string }) => SETTINGS[name] ?? name
const shown = ({ name, value }: { name: string; value: string }) =>
  name === 'model' || name === 'version' ? value : value.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)

export const harnessName = ({ provider }: { provider: string }) => HARNESSES[provider] ?? provider

const keyReason = ({ control, kind }: { control: Control; kind?: ThreadPage['routeKind'] }) =>
  kind && control.options.map(o => inputReason({ kind, input: o.input })).find(Boolean)

// A change sent and not yet reported back by the session; sending while the command
// itself is still on its way.
interface Pending { value: string; before?: string; sending: boolean }

interface AgentControlsInput {
  card: Card
  thread: ThreadPage | null
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}

function useAgentControls({ card, thread, command, connected, notify }: AgentControlsInput) {
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const provider = card.agent?.provider
  const page = thread?.card === card.id ? thread : null
  const firstmate = connected && page?.routeKind === 'firstmate'
  const harness = harnessControls({ provider, firstmate })
  useEffect(() => {
    setPending({})
  }, [card.id])
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

  const route = !connected ? 'Reconnect to change settings.' : !page ? 'Loading the route…' : page.route ? undefined : page.noRoute

  const settle = ({ setting }: { setting: string }) =>
    setPending(p => Object.fromEntries(Object.entries(p).filter(([name]) => name !== setting)))

  const send = ({ control, option }: { control: Control; option: ControlOption }) => {
    const before = card.settings?.[control.setting]
    const sent = { value: option.value, ...(before === undefined ? {} : { before }) }
    setPending(p => ({ ...p, [control.setting]: { ...sent, sending: true } }))
    void command({ name: 'agent', args: [card.id, control.setting, option.value, crypto.randomUUID()] }).then(r => {
      const result = r.agent as { sent: string; confirmed: boolean; now: string } | undefined
      const help = (r.help as string[] | undefined)?.[0]

      if (result?.sent !== 'delivered' || result.confirmed) {
        settle({ setting: control.setting })
      } else {
        const waiting = { ...sent, sending: false }
        setPending(p => (p[control.setting] ? { ...p, [control.setting]: waiting } : p))
      }

      notify({ text: result?.confirmed ? `${label({ name: control.setting })} is now ${shown({ name: control.setting, value: result.now })}.` : help ?? `Sent ${option.label}.` })
    })
      .catch((e: Error) => {
        settle({ setting: control.setting }); notify({ text: e.message })
      })
  }

  const sending = Object.values(pending).some(p => p.sending)

  return { provider, page, firstmate, harness, route, pending, send, sending }
}

export function ComposerSettings({ card, thread, command, connected, notify }: AgentControlsInput) {
  const { page, harness, route, pending, send, sending } = useAgentControls({
    card, thread, command, connected, notify,
  })

  return harness && (
    <div className="composer-settings" role="group" aria-label="Agent settings">
      {!harness.controls.some(control => control.setting === 'model') && (
        <Select
          label="Model"
          value={card.settings?.model ?? ''}
          options={[{ value: card.settings?.model ?? '', label: card.settings?.model ?? 'Model' }]}
          disabled
          title="Change the model in the agent's own picker."
          onChange={() => {}}
        />
      )}
      {harness.controls.map(control => {
        const now = card.settings?.[control.setting], waiting = pending[control.setting]
        const blocked = route ?? keyReason({ control, kind: page?.routeKind })
        const current = control.confirm === 'changes' || now === undefined
          ? undefined
          : control.options.find(option => confirms({
            control, option, before: undefined, after: now,
          }))
        const reported = now === undefined ? undefined
          : shown({ name: control.setting, value: control.setting === 'model' ? now.replace(/^claude-/, '') : now })
        const chosen = waiting && control.options.find(o => o.value === waiting.value)
        const value = chosen ? chosen.label : reported

        if (control.setting === 'fast') {
          const option = control.options.find(o => o.value === (now === 'on' ? 'off' : 'on')) ?? control.options[0]

          return (
            <Button
              key="fast"
              className="fast-toggle"
              role="switch"
              aria-label="Fast"
              aria-checked={now === 'on'}
              disabled={!!blocked || sending || !option}
              title={blocked}
              onClick={() => {
                if (option) {
                  send({ control, option })
                }
              }}
            >Fast
            </Button>
          )
        }

        return (
          <Select
            key={control.setting}
            label={control.setting === 'collaboration' ? 'Mode' : label({ name: control.setting })}
            value={current?.value ?? ''}
            options={control.options}
            disabled={!!blocked || sending}
            title={blocked ?? `${label({ name: control.setting })}: ${now ?? 'not reported'}`}
            display={(
              <>
                <Icon name={control.setting} size={12} />
                {value ? `${value}${waiting ? '…' : ''}` : label({ name: control.setting })}
              </>
            )}
            onChange={({ value }) => {
              const option = control.options.find(o => o.value === value)

              if (option) {
                send({ control, option })
              }
            }}
          />
        )
      })}
    </div>
  )
}

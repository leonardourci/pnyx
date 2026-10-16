import { useEffect, useState } from 'react'
import { confirms, harnessControls, inputReason, type Control, type ControlOption } from '../../../src/core/control.ts'
import type { Card } from '../../../src/core/model.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { AgentPicker, PickerField } from './agent-picker.tsx'
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
  const harness = harnessControls({ provider, firstmate, hosted: card.agent?.host === 'pnyx' })
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

    return command({ name: 'agent', args: [card.id, control.setting, option.value, crypto.randomUUID()] }).then(r => {
      const result = r.agent as { sent: string; confirmed: boolean; now: string } | undefined
      const help = (r.help as string[] | undefined)?.[0]

      if (result?.sent !== 'delivered' || result.confirmed) {
        settle({ setting: control.setting })
      } else {
        const waiting = { ...sent, sending: false }
        setPending(p => (p[control.setting] ? { ...p, [control.setting]: waiting } : p))
      }

      notify({ text: result?.confirmed ? `${label({ name: control.setting })} is now ${shown({ name: control.setting, value: result.now })}.` : help ?? (result?.sent === 'delivered' ? `Sent ${option.label}; waiting for the session to report it.` : `Could not deliver ${option.label}.`) })

      return result?.sent === 'delivered'
    })
      .catch((e: Error) => {
        settle({ setting: control.setting }); notify({ text: e.message })

        return false
      })
  }

  const sending = Object.values(pending).some(p => p.sending)

  return { provider, page, firstmate, harness, route, pending, send, sending }
}

export function ComposerSettings({ card, thread, command, connected, notify }: AgentControlsInput) {
  const input = { card, thread, command, connected, notify }
  const controls = useAgentControls(input)
  const { provider, harness, pending } = controls
  const summary = [harness?.name ?? harnessName({ provider: provider ?? 'Agent' }), ...['model', 'mode', 'collaboration', 'effort', 'fast'].flatMap(name => {
    const value = input.card.settings?.[name]

    return value ? [name === 'fast' ? `Fast ${value}` : shown({ name, value })] : []
  }), ...(Object.keys(pending).length ? ['Pending confirmation'] : [])].join(' · ')

  return provider && (
    <AgentPicker provider={provider} summary={summary}>
      {({ close }) => <SessionSettings {...input} controls={controls} close={close} />}
    </AgentPicker>
  )
}

function SessionSettings({ card, controls, close }: AgentControlsInput & {
  controls: ReturnType<typeof useAgentControls>
  close(): void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [applying, setApplying] = useState(false)
  const { provider, page, harness, route, pending, send, sending } = controls
  const fields = harness?.controls.toSorted((a, b) => {
    const order = ['model', 'mode', 'approval', 'collaboration', 'effort', 'fast']

    return order.indexOf(a.setting) - order.indexOf(b.setting)
  }) ?? []

  return (
    <div className="agent-configuration">
      <strong>Session settings</strong>
      <PickerField
        label="Agent"
        value={provider ?? ''}
        options={[{ value: provider ?? '', label: harnessName({ provider: provider ?? 'Agent' }) }]}
        reason="Hydra assigns agents to tasks."
        onChange={() => {}}
      />
      {!fields.some(control => control.setting === 'model') && (
        <PickerField
          label="Model"
          value={card.settings?.model ?? ''}
          options={[{ value: card.settings?.model ?? '', label: card.settings?.model ?? 'Not reported' }]}
          reason="Change the model in the agent’s own picker."
          onChange={() => {}}
        />
      )}
      {fields.map(control => {
        const now = card.settings?.[control.setting], waiting = pending[control.setting]
        const blocked = route ?? keyReason({ control, kind: page?.routeKind })
        const current = control.confirm === 'changes' || now === undefined ? undefined : control.options.find(option => confirms({ control, option, before: undefined, after: now }))
        const reported = now === undefined ? 'Not reported' : shown({ name: control.setting, value: now })
        const status = waiting ? `${waiting.sending ? 'Sending' : 'Pending'}: ${control.options.find(o => o.value === waiting.value)?.label ?? waiting.value}` : reported

        return (
          <PickerField
            key={control.setting}
            label={control.setting === 'collaboration' ? 'Mode' : label({ name: control.setting })}
            value={waiting ? '' : draft[control.setting] ?? current?.value ?? ''}
            options={[{ value: '', label: status }, ...control.options]}
            disabled={sending || applying || !!waiting}
            reason={blocked}
            onChange={({ value }) => {
              setDraft(current => ({ ...current, [control.setting]: value }))
            }}
          />
        )
      })}
      {harness?.note && <p>{harness.note}</p>}
      {!harness && <p>This integration does not expose session settings.</p>}
      <Button
        variant="primary"
        disabled={!!route || applying || sending || !Object.values(draft).some(Boolean)}
        onClick={() => {
          setApplying(true)

          void (async () => {
            for (const control of fields) {
              const blocked = pending[control.setting]
                || keyReason({ control, kind: page?.routeKind })
              const option = blocked ? undefined
                : control.options.find(option => option.value === draft[control.setting])

              if (option) {
                if (!(await send({ control, option }))) {
                  setApplying(false)

                  return
                }

                setDraft(current => Object.fromEntries(
                  Object.entries(current).filter(([setting]) => setting !== control.setting),
                ))
              }
            }

            close()
          })()
        }}
      >Apply settings
      </Button>
    </div>
  )
}

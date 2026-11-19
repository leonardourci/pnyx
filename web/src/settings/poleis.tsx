import { useState } from 'react'
import type { HydraState } from '#app/model.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import { hydraPolisConfig } from '#memory/polis-policy.ts'
import type { Settings } from '#settings/model.ts'
import type { Command } from '#web-app/connection.ts'
import { Button, Input, Select, Switch } from '#web-shared/ui/controls.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { SettingStack } from '#web-shared/ui/setting-row.tsx'
import { saveSharedSettings } from './shared-settings.ts'

type Actions = {
  command: Command
  notify({ text }: { text: string }): void
}

export function HydraPoleis({
  state,
  settings,
  command,
  notify,
}: Actions & {
  state: HydraState
  settings: Settings
}) {
  const access = hydraPolisConfig({ state })
  const options = Object.keys(settings.poleis).map(value => ({
    value,
    label: value,
  }))

  const save = async ({ args }: { args: string[] }) => {
    try {
      await command({
        name: 'hydra',
        args: [
          'set',
          ...args,
          '--event-id',
          crypto.randomUUID(),
        ],
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  return (
    <SettingStack>
      <label>Lives in<Select
        label="Lives in"
        value={access.polis}
        options={options}
        onChange={({ value }) => save({
          args: [
            '--polis',
            value,
          ],
        })}
      />
      </label>
      <span>Also reads</span>
      {options.map(option => (
        <Switch
          key={option.value}
          label={`Also reads ${option.label}`}
          caption={option.label}
          checked={access.readPoleis.includes(option.value)}
          onChange={({ value }) => {
            const reads = value ? [
              ...access.readPoleis,
              option.value,
            ] : access.readPoleis.filter(polis => polis !== option.value)
            void save({
              args: [
                '--read-poleis',
                reads.join(','),
              ],
            })
          }}
        />
      ))}
    </SettingStack>
  )
}

export function Poleis({
  settings,
  hydras,
  command,
  notify,
}: Actions & {
  settings: Settings
  hydras: Pick<HydraSummary, 'id' | 'name'>[]
}) {
  const [
    name,
    setName,
  ] = useState('')
  const [
    creating,
    setCreating,
  ] = useState(false)

  const save = async ({
    polis,
    readers,
  }: {
    polis: string
    readers: string[]
  }) => {
    try {
      await saveSharedSettings({
        command,
        patch: { poleis: { [polis]: { readers } } },
      })

      return true
    } catch (error) {
      notify({ text: (error as Error).message })

      return false
    }
  }

  return (
    <SettingStack>
      {Object.entries(settings.poleis).map(([
        polis,
        { readers },
      ]) => {
        const options = [
          {
            value: '*',
            label: 'Every Hydra',
          },
          ...hydras.map(hydra => ({
            value: hydra.id,
            label: hydra.name,
          })),
        ].filter(option => !readers.includes(option.value))
        const canAddReader = !readers.includes('*') && options.length > 0

        return (
          <div key={polis} className="flex flex-wrap items-center gap-2" aria-label={`Polis ${polis}`}>
            <strong>{polis}</strong>
            <>
              {readers.map(reader => (
                <span key={reader} className="inline-flex items-center gap-1">
                  {reader === '*' ? 'Every Hydra' : hydras.find(hydra => hydra.id === reader)?.name ?? reader}
                  <IconButton
                    icon="close"
                    label={`Remove ${reader} from ${polis}`}
                    onClick={() => save({
                      polis,
                      readers: readers.filter(id => id !== reader),
                    })}
                  />
                </span>
              ))}
              {canAddReader && (
                <Select
                  label={`Add reader to ${polis}`}
                  value=""
                  display="+ add reader"
                  options={options}
                  onChange={({ value }) => save({
                    polis,
                    readers: [
                      ...readers,
                      value,
                    ],
                  })}
                />
              )}
            </>
          </div>
        )
      })}
      {creating ? (
        <form
          className="flex items-center gap-2"
          onSubmit={async event => {
            event.preventDefault()

            if (await save({
              polis: name,
              readers: [],
            })) {
              setName('')
              setCreating(false)
            }
          }}
        >
          <Input
            aria-label="New polis name"
            value={name}
            required
            pattern="[a-z0-9][a-z0-9-]{0,63}"
            onChange={event => setName(event.target.value)}
          />
          <Button
            type="submit"
            disabled={Object.hasOwn(
              settings.poleis,
              name,
            )}
          >Create polis
          </Button>
          <IconButton icon="close" label="Cancel new polis" onClick={() => setCreating(false)} />
        </form>
      ) : <Button onClick={() => setCreating(true)}>+ New polis</Button>}
    </SettingStack>
  )
}

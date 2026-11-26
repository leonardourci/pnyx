import { useState } from 'react'
import type { Settings } from '#settings/model.ts'
import { patchSettings } from '#settings/settings.ts'
import { TitanError } from '#store/errors.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import { SettingField } from '#web-shared/ui/setting-row.tsx'
import { Help, type Save } from './titan-settings.tsx'

const HOST_SEPARATOR = /[\s,]+/

const hostsOf = ({ text }: { text: string }) => [
  ...new Set(text.toLowerCase().split(HOST_SEPARATOR)
    .filter(Boolean)),
]

export function AllowedHosts({
  settings,
  save,
}: {
  settings: Settings
  save: Save
}) {
  const saved = settings.allowedHosts.join(', ')
  const [
    draft,
    setDraft,
  ] = useState<string>()
  const [
    error,
    setError,
  ] = useState<string>()
  const text = draft ?? saved

  const submit = async () => {
    const allowedHosts = hostsOf({ text })

    try {
      patchSettings({
        current: settings,
        input: { allowedHosts },
      })
    } catch (refused) {
      if (!(refused instanceof TitanError)) {
        throw refused
      }

      setError(refused.message)

      return
    }

    setError(undefined)

    if (await save({ patch: { allowedHosts } })) {
      setDraft(undefined)
    }
  }

  return (
    <SettingField>
      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <Input
          aria-label="Allowed host names"
          className="min-w-0 flex-1"
          value={text}
          onChange={event => setDraft(event.target.value)}
          spellCheck={false}
          placeholder="Only this computer"
        />
        <Button type="submit" variant="surface" disabled={text === saved}>Save</Button>
      </form>
      {error && <p role="alert" className="text-meta text-red">{error}</p>}
      <Help text="Separate names with commas. Empty allows only this computer." />
    </SettingField>
  )
}

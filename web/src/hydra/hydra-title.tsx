import { useEffect, useRef, useState } from 'react'
import { HYDRA_ICONS as NAME_ICONS, HYDRA_MARK, HYDRA_NAME_MAX } from '#hydra/hydra-names.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { IconPicker } from '#web-shared/ui/icon-picker.tsx'
import { Input } from '#web-shared/ui/controls.tsx'
import { hydraTitle } from '#web-app/view.ts'

// The counter shows once a name gets close to the cap.
const COUNTER_FROM = 30
export const HYDRA_ICONS = [
  HYDRA_MARK,
  ...NAME_ICONS,
]

export interface HydraIdentity {
  name: string
  icon: string
}

export function HydraLabel({
  name,
  icon,
  size = 20,
}: {
  name: string
  icon?: string
  size?: number
}) {
  return (
    <>
      <Icon name={icon ?? HYDRA_MARK} size={size} />
      <span className={name ? 'hydra-label' : 'hydra-label muted'}>{hydraTitle({ name })}</span>
    </>
  )
}

const duplicate = ({
  name,
  taken,
}: {
  name: string
  taken: string[]
}) => taken.some(other => other.trim().toLowerCase() === name.toLowerCase())

function editorNote({
  name,
  isDuplicate,
  saved,
}: {
  name: string
  isDuplicate: boolean
  saved: string
}): string {
  if (isDuplicate) {
    return `Another Hydra is already called ${name.toLowerCase()}`
  }

  return name ? '' : `Empty: Enter keeps “${saved}”`
}

// Edits a Hydra's name and icon in place: Enter or a click away saves, Esc puts back the saved name and icon.
export function HydraNameEditor({
  saved,
  taken,
  iconSize = 20,
  save,
  cancel,
}: {
  saved: HydraIdentity
  taken: string[]
  iconSize?: number
  save({
    name,
    icon,
  }: HydraIdentity): void
  cancel(): void
}) {
  const [
    draft,
    setDraft,
  ] = useState(saved.name)
  const [
    icon,
    setIcon,
  ] = useState(saved.icon)
  const input = useRef<HTMLInputElement>(null)
  // Escape and a save both close the editor; the blur that follows must not save again.
  const done = useRef(false)
  useEffect(
    () => {
      input.current?.focus(); input.current?.select()
    },
    [],
  )
  const name = draft.trim()
  const isDuplicate = !!name && duplicate({
    name,
    taken,
  })
  const note = editorNote({
    name,
    isDuplicate,
    saved: saved.name,
  })
  const counter = draft.length >= COUNTER_FROM ? `${draft.length}/${HYDRA_NAME_MAX}` : ''

  const commit = ({ blocking }: { blocking: boolean }) => {
    if (done.current || (isDuplicate && blocking)) {
      return
    }

    done.current = true
    save({
      name: name && !isDuplicate ? name : saved.name,
      icon,
    })
  }

  return (
    <form
      className="hydra-name-editor"
      onSubmit={e => {
        e.preventDefault(); commit({ blocking: true })
      }}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          commit({ blocking: false })
        }
      }}
    >
      <IconPicker
        label="Change icon"
        value={icon}
        choices={HYDRA_ICONS}
        size={iconSize}
        pick={({ icon }) => {
          setIcon(icon); input.current?.focus()
        }}
      />
      <span className="hydra-name-field">
        <Input
          ref={input}
          aria-label="Hydra name"
          aria-invalid={isDuplicate}
          value={draft}
          maxLength={HYDRA_NAME_MAX}
          placeholder={saved.name}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
              e.preventDefault(); e.stopPropagation()
              done.current = true
              cancel()
            }
          }}
        />
        {(note || counter) && (
          <span className={isDuplicate ? 'hydra-name-note error' : 'hydra-name-note'} role={isDuplicate ? 'alert' : undefined}>
            <span>{note}</span><span>{counter}</span>
          </span>
        )}
      </span>
    </form>
  )
}

import { useEffect, useRef, useState } from 'react'
import { TITAN_ICONS as NAME_ICONS, TITAN_MARK, TITAN_NAME_MAX } from '#titan/titan-names.ts'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { IconPicker } from '#web-shared/ui/icon-picker.tsx'
import { Input } from '#web-shared/ui/controls.tsx'
import { hydraTitle } from '#web-app/view.ts'

const COUNTER_FROM = 30
export const TITAN_ICONS = [
  TITAN_MARK,
  ...NAME_ICONS,
]

export interface TitanIdentity {
  name: string
  icon: string
}

export function TitanLabel({
  name,
  icon,
  size = ICON_SIZE.heading,
}: {
  name: string
  icon?: string
  size?: number
}) {
  return (
    <>
      <Icon name={icon ?? TITAN_MARK} size={size} />
      <span className={`hydra-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-label ${name ? '' : 'text-muted'}`}>{hydraTitle({ name })}</span>
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
    return `Another Titan is already called ${name.toLowerCase()}`
  }

  return name ? '' : `Empty: Enter keeps “${saved}”`
}

// Edits a Titan's name and icon in place: Enter or a click away saves, Esc puts back the saved name and icon.
export function TitanNameEditor({
  saved,
  taken,
  iconSize = ICON_SIZE.heading,
  save,
  cancel,
}: {
  saved: TitanIdentity
  taken: string[]
  iconSize?: number
  save({
    name,
    icon,
  }: TitanIdentity): void
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
  const input = useRef<HTMLTextAreaElement>(null)
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
  const counter = draft.length >= COUNTER_FROM ? `${draft.length}/${TITAN_NAME_MAX}` : ''

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
      className="hydra-name-editor flex items-start gap-1.5 min-w-0"
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
        choices={TITAN_ICONS}
        size={iconSize}
        pick={({ icon }) => {
          setIcon(icon); input.current?.focus()
        }}
      />
      <span className="hydra-name-field flex flex-1 flex-col gap-0.75 min-w-0 [&_.input]:w-full [&_.input]:py-1 [&_.input]:px-2 [&_.input]:font-label">
        <Input
          ref={input}
          aria-label="Titan name"
          aria-invalid={isDuplicate}
          value={draft}
          maxLength={TITAN_NAME_MAX}
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
          <span className={`hydra-name-note flex justify-between gap-1.5 text-meta ${isDuplicate ? 'error text-red' : 'text-muted'}`} role={isDuplicate ? 'alert' : undefined}>
            <span>{note}</span><span>{counter}</span>
          </span>
        )}
      </span>
    </form>
  )
}

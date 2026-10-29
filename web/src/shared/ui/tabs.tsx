import { useRef, type KeyboardEvent, type ReactNode } from 'react'

const STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowLeft: -1,
}

export interface Tab {
  id: string
  label: ReactNode
}

export const tabId = ({
  prefix,
  id,
}: {
  prefix: string
  id: string
}) => `${prefix}-tab-${id}`

export const panelId = ({
  prefix,
  id,
}: {
  prefix: string
  id: string
}) => `${prefix}-panel-${id}`

// A tab list whose panels the caller renders with role="tabpanel" and the ids above.
export function Tabs({
  tabs,
  selected,
  select,
  prefix,
  label,
}: {
  tabs: Tab[]
  selected: string
  select({ id }: { id: string }): void
  prefix: string
  label: string
}) {
  const list = useRef<HTMLDivElement>(null)

  const move = ({ event }: { event: KeyboardEvent }) => {
    const step = STEPS[event.key]

    if (!step) {
      return
    }

    event.preventDefault(); event.stopPropagation()
    const index = tabs.findIndex(tab => tab.id === selected)
    const next = tabs[(index + step + tabs.length) % tabs.length]!
    select({ id: next.id })
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId({
      prefix,
      id: next.id,
    }))}`)?.focus()
  }

  return (
    <div
      ref={list}
      className="tabs"
      role="tablist"
      aria-label={label}
    >
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={tabId({
            prefix,
            id: tab.id,
          })}
          aria-selected={tab.id === selected}
          aria-controls={panelId({
            prefix,
            id: tab.id,
          })}
          tabIndex={tab.id === selected ? 0 : -1}
          className="tab"
          onClick={event => {
            event.stopPropagation(); select({ id: tab.id })
          }}
          onKeyDown={event => move({ event })}
        >{tab.label}
        </button>
      ))}
    </div>
  )
}

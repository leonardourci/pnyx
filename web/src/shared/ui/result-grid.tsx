import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { composing } from '#web-shared/ime.ts'

export interface ResultRow {
  id: string
  label: string
  content: ReactNode
}
interface ResultGroup {
  label: string
  rows: ResultRow[]
  message?: string
}

const CONTROLS = 'button, input, textarea, select, a[href], [tabindex], [contenteditable=true]'
const ENABLED_CONTROLS = 'button:not(:disabled), input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), a[href], [contenteditable=true]'

function ResultGridRow({
  row,
  active,
  editing,
  select,
  leave,
}: {
  row: ResultRow
  active: boolean
  editing: boolean
  select({ editing }: { editing: boolean }): void
  leave(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const tabs = useRef(new WeakMap<HTMLElement, string | null>())
  useLayoutEffect(
    () => {
      const update = () => {
        for (const control of root.current?.querySelectorAll<HTMLElement>(CONTROLS) ?? []) {
          if (!tabs.current.has(control)) {
            tabs.current.set(
              control,
              control.getAttribute('tabindex'),
            )
          }

          const original = tabs.current.get(control)

          if (editing && original == null) {
            control.removeAttribute('tabindex')
          } else {
            control.setAttribute(
              'tabindex',
              editing ? original ?? '-1' : '-1',
            )
          }
        }
      }

      update()
      const observer = new MutationObserver(update)

      if (root.current) {
        observer.observe(
          root.current,
          {
            childList: true,
            subtree: true,
          },
        )
      }

      return () => observer.disconnect()
    },
    [editing],
  )

  return (
    <div
      ref={root}
      role="row"
      className="oracle-row"
      data-result-id={row.id}
      aria-label={`${row.label} result`}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onFocus={e => {
        select({ editing: e.target !== e.currentTarget })

        if (e.target === e.currentTarget) {
          e.currentTarget.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
          })
        }
      }}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          leave()
        }
      }}
    >
      <div role="gridcell">{row.content}</div>
    </div>
  )
}

export function ResultGrid({
  id,
  label,
  groups,
  search,
}: {
  id: string
  label: string
  groups: ResultGroup[]
  search(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [
    active,
    setActive,
  ] = useState<string | null>(null)
  const [
    editing,
    setEditing,
  ] = useState<string | null>(null)
  const rows = groups.flatMap(group => group.rows)
  const selected = rows.some(row => row.id === active) ? active : rows[0]?.id

  return (
    <div
      ref={root}
      id={id}
      role="grid"
      aria-label={label}
      className="oracle-results"
      onKeyDownCapture={e => {
        if (composing({ event: e.nativeEvent })) {
          return
        }

        if (e.key === 'Escape' && editing) {
          const row = (e.target as HTMLElement).closest<HTMLElement>('[data-result-id]')
          e.preventDefault()
          // Let the control dismiss its own popup or inline edit before restoring row focus.
          requestAnimationFrame(() => row?.focus())
        } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !e.target.closest('form')) {
          e.preventDefault(); e.stopPropagation()
          e.target.closest<HTMLElement>('[data-result-id]')?.focus()
        }
      }}
      onKeyDown={e => {
        if (composing({ event: e.nativeEvent }) || e.altKey || e.ctrlKey || e.metaKey) {
          return
        }

        const target = e.target as HTMLElement

        if (!target.matches('[data-result-id]')) {
          if ([
            'ArrowDown',
            'ArrowUp',
            'Home',
            'End',
            'Enter',
            ' ',
            'Escape',
          ].includes(e.key)) {
            e.stopPropagation()
          }

          return
        }

        if ([
          'ArrowDown',
          'ArrowUp',
          'Home',
          'End',
        ].includes(e.key)) {
          e.preventDefault(); e.stopPropagation()
          const elements = [...(root.current?.querySelectorAll<HTMLElement>('[data-result-id]') ?? [])]
          const index = elements.indexOf(target)
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? elements.length - 1 : Math.max(
            0,
            Math.min(
              elements.length - 1,
              index + (e.key === 'ArrowDown' ? 1 : -1),
            ),
          )
          elements[next]?.focus()
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); e.stopPropagation()
          target.querySelector<HTMLElement>(ENABLED_CONTROLS)?.focus()
        } else if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); search()
        }
      }}
    >
      {groups.map(group => (
        <div role="rowgroup" aria-label={group.label} key={group.label}>
          <div role="row" className="oracle-caption"><div role="gridcell">{group.label}</div></div>
          {group.message && <div role="row"><div role="gridcell" className="muted oracle-row">{group.message}</div></div>}
          {group.rows.map(row => (
            <ResultGridRow
              key={row.id}
              row={row}
              active={row.id === selected}
              editing={row.id === editing}
              select={({ editing }) => {
                setActive(row.id); setEditing(editing ? row.id : null)
              }}
              leave={() => setEditing(null)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

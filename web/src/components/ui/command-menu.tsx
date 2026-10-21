import { Icon } from './icon.tsx'
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input } from './controls.tsx'

export interface MenuItem {
  id: string
  label: string
  detail?: string
  keyLabel?: string
  disabled?: boolean
  run(): void
}

export function CommandMenu({
  title,
  description,
  items,
  close,
  search,
}: {
  title: string
  description: string
  items: MenuItem[]
  close(): void
  // More results for a typed query, fetched after a pause and listed after the matching items.
  search?({ query }: { query: string }): Promise<MenuItem[]>
}) {
  const [
    query,
    setQuery,
  ] = useState('')
  const [
    active,
    setActive,
  ] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const [
    found,
    setFound,
  ] = useState<{
    query: string
    items: MenuItem[]
  }>({
    query: '',
    items: [],
  })
  const q = query.trim()
  useEffect(
    () => {
      if (!search || !q) {
        return
      }

      let live = true
      const timer = setTimeout(
        () => {
          void search({ query: q }).then(
            results => {
              if (live) {
                setFound({
                  query: q,
                  items: results,
                })
              }
            },
            () => {},
          )
        },
        180,
      )

      return () => {
        live = false; clearTimeout(timer)
      }
    },
    [
      search,
      q,
    ],
  )
  const visible = [
    ...items.filter(i => `${i.label} ${i.detail ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    ...(q && found.query === q ? found.items : []),
  ]
  const index = Math.min(
    active,
    Math.max(
      0,
      visible.length - 1,
    ),
  )
  useEffect(
    () => {
      input.current?.focus()
    },
    [],
  )
  useEffect(
    () => {
      document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: 'nearest' })
    },
    [
      index,
      id,
    ],
  )

  const choose = ({ position: n }: { position: number }) => {
    const item = visible[n]

    if (item && !item.disabled) {
      item.run()
    }
  }

  return (
    <div
      className="command-backdrop"
      onPointerDown={e => {
        if (e.target === e.currentTarget) {
          close()
        }
      }}
    >
      <div
        className="command-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        data-key-scope="overlay"
        ref={root}
        onKeyDown={e => {
          if (e.key !== 'Tab') {
            return
          }

          const stops = [...(root.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)') ?? [])], first = stops[0], last = stops.at(-1)

          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last?.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first?.focus()
          }
        }}
      >
        <header className="row between">
          <h2 id={`${id}-title`}>{title}</h2>
          <Button aria-label={`Close ${title}`} onClick={close}><Icon name="close" /></Button>
        </header>
        <p id={`${id}-description`} className="muted small">{description}</p>
        <Input
          ref={input}
          role="combobox"
          aria-label={`Search ${title}`}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={visible[index] ? `${id}-${index}` : undefined}
          autoComplete="off"
          placeholder={search ? 'Type to find an action or a card…' : 'Type to find an action…'}
          value={query}
          onChange={e => {
            setQuery(e.target.value); setActive(0)
          }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.key === 'Process') {
              return
            }

            if ([
              'ArrowDown',
              'ArrowUp',
            ].includes(e.key)) {
              e.preventDefault(); setActive(Math.max(
                0,
                Math.min(
                  visible.length - 1,
                  index + (e.key === 'ArrowDown' ? 1 : -1),
                ),
              ))
            } else if (e.key === 'Enter') {
              e.preventDefault()

              if (!e.repeat) {
                choose({ position: index })
              }
            }
          }}
        />
        <div
          role="listbox"
          aria-label={title}
          id={`${id}-list`}
          className="command-results"
        >
          {visible.map((
            item,
            n,
          ) => (
            <div
              role="option"
              aria-selected={index === n}
              aria-disabled={item.disabled || undefined}
              id={`${id}-${n}`}
              key={item.id}
              className={`command-result ${index === n ? 'active' : ''}`}
              onPointerMove={() => setActive(n)}
              onClick={() => choose({ position: n })}
            >
              <span>
                <strong>{item.label}</strong>
                {item.detail && <small>{item.detail}</small>}
              </span>
              {item.keyLabel && <kbd>{item.keyLabel}</kbd>}
            </div>
          ))}
          {!visible.length && <p className="empty">No matching actions.</p>}
        </div>
        <footer className="small muted">↑ ↓ choose · Enter activate · Tab reaches the close button</footer>
      </div>
    </div>
  )
}

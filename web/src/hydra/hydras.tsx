import { useEffect, useState } from 'react'
import type { HydraTab } from '../../../src/server/hydras.ts'
import { Button } from '../components/ui/controls.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import type { Command } from './connection.ts'

const RENAME = 'rename-hydra'

export function HydraTabs({ command, connected, notify, active, showHydra }: {
  active: boolean
  showHydra(): void
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const [hydras, setHydras] = useState<HydraTab[]>([]), [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false)
  const renaming = new URLSearchParams(location.search).has(RENAME)

  useEffect(() => {
    if (connected) {
      void command({ name: 'hydras', args: [] }).then(r => {
        setHydras(r.hydras as HydraTab[]); setCurrent(r.hydraId as string)
      }, (e: Error) => notify({ text: e.message }))
    }
  }, [connected, command, notify])

  useEffect(() => {
    const target = new URLSearchParams(location.search).get('open-hydra')

    if (!connected || !target) {
      return
    }

    const clean = new URL(location.href)
    clean.searchParams.delete('open-hydra'); history.replaceState(null, '', clean)
    void command({ name: 'hydras', args: ['open', target] }).then(r => location.assign(r.url as string), (e: Error) => notify({ text: e.message }))
  }, [connected, command, notify])

  const go = ({ args, rename }: { args: string[]; rename?: boolean }) => {
    setBusy(true)
    void command({ name: 'hydras', args }).then(r => {
      const url = new URL(r.url as string)

      if (rename) {
        url.searchParams.set(RENAME, '1')
      }

      location.assign(url)
    }, (e: Error) => {
      setBusy(false); notify({ text: e.message })
    })
  }

  const currentHydra = hydras.find(b => b.id === current)

  return (
    <div
      className="hydra-switcher"
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setOpen(false)
        }
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.stopPropagation(); setOpen(false)
        }
      }}
    >
      <Button
        aria-label="Switch Hydra"
        aria-pressed={active}
        aria-expanded={open}
        onClick={() => {
          showHydra(); setOpen(value => !value)
        }}
      >{currentHydra?.name ?? 'Hydra'} <span aria-hidden="true">▾</span>
      </Button>
      {renaming && currentHydra && (
        <InlineTitle
          value={currentHydra.name}
          label={`Rename Hydra ${currentHydra.name}`}
          startEditing
          save={({ title }) => command({ name: 'hydras', args: ['rename', currentHydra.id, title] }).then(r => {
            setHydras(r.hydras as HydraTab[]); history.replaceState(null, '', location.pathname)
          })}
        />
      )}
      {open && (
        <div className="hydra-list" aria-label="Hydras">
          {hydras.map(b => (
            <Button
              key={b.id}
              aria-current={b.id === current ? 'page' : undefined}
              disabled={busy}
              onClick={() => {
                if (b.id === current) {
                  showHydra(); setOpen(false)
                } else {
                  go({ args: ['open', b.id] })
                }
              }}
            >{b.name}
            </Button>
          ))}
          <Button disabled={!connected || busy} onClick={() => go({ args: ['create', 'New Hydra'], rename: true })}>＋ New Hydra</Button>
        </div>
      )}
    </div>
  )
}

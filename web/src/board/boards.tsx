import { useEffect, useState } from 'react'
import type { BoardTab } from '../../../src/server/boards.ts'
import { Button } from '../components/ui/controls.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import type { Command } from './connection.ts'

const RENAME = 'rename-board'

export function BoardTabs({ command, connected, notify, active, showBoard }: {
  active: boolean
  showBoard(): void
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const [boards, setBoards] = useState<BoardTab[]>([]), [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false)
  const renaming = new URLSearchParams(location.search).has(RENAME)

  useEffect(() => {
    if (connected) {
      void command({ name: 'boards', args: [] }).then(r => {
        setBoards(r.boards as BoardTab[]); setCurrent(r.board as string)
      }, (e: Error) => notify({ text: e.message }))
    }
  }, [connected, command, notify])

  const go = ({ args, rename }: { args: string[]; rename?: boolean }) => {
    setBusy(true)
    void command({ name: 'boards', args }).then(r => {
      const url = new URL(r.url as string)

      if (rename) {
        url.searchParams.set(RENAME, '1')
      }

      location.assign(url)
    }, (e: Error) => {
      setBusy(false); notify({ text: e.message })
    })
  }

  const board = boards.find(b => b.id === current)

  return (
    <div
      className="board-switcher"
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
        aria-label="Switch board"
        aria-pressed={active}
        aria-expanded={open}
        onClick={() => {
          showBoard(); setOpen(value => !value)
        }}
      >{board?.name ?? 'Board'} <span aria-hidden="true">▾</span>
      </Button>
      {renaming && board && (
        <InlineTitle
          value={board.name}
          label={`Rename board ${board.name}`}
          startEditing
          save={({ title }) => command({ name: 'boards', args: ['rename', board.id, title] }).then(r => {
            setBoards(r.boards as BoardTab[]); history.replaceState(null, '', location.pathname)
          })}
        />
      )}
      {open && (
        <div className="board-list" aria-label="Boards">
          {boards.map(b => (
            <Button
              key={b.id}
              aria-current={b.id === current ? 'page' : undefined}
              disabled={busy}
              onClick={() => {
                if (b.id === current) {
                  showBoard(); setOpen(false)
                } else {
                  go({ args: ['open', b.id] })
                }
              }}
            >{b.name}
            </Button>
          ))}
          <Button disabled={!connected || busy} onClick={() => go({ args: ['create', 'New board'], rename: true })}>＋ New board</Button>
        </div>
      )}
    </div>
  )
}

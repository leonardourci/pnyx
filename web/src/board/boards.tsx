import { useEffect, useState } from 'react'
import type { BoardTab } from '../../../src/server/boards.ts'
import { Button } from '../components/ui/controls.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import type { Command } from './connection.ts'

// A page opened from + New board starts with its name ready to type.
const RENAME = 'rename-board'

// One tab per board. Each board has its own server, so switching opens that
// server's page; a new board is created at once and opens with its name selected.
export function BoardTabs({ command, connected, notify }: {
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const [boards, setBoards] = useState<BoardTab[]>([]), [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false)
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

  return (
    <nav className="board-tabs" aria-label="Boards">
      {boards.map(b => (b.id === current ? (
        <span
          key={b.id}
          className="board-tab"
          aria-current="page"
          title={`Hydra: ${b.hydra}`}
        >
          <InlineTitle
            value={b.name}
            label="Board name"
            doubleClick
            startEditing={renaming}
            save={({ title }) => command({ name: 'boards', args: ['rename', b.id, title] }).then(r => {
              setBoards(r.boards as BoardTab[])
              history.replaceState(null, '', location.pathname)
            })}
          />
        </span>
      ) : (
        <Button
          key={b.id}
          className="board-tab"
          disabled={busy}
          title={`Hydra: ${b.hydra}`}
          onClick={() => go({ args: ['open', b.id] })}
        >
          {b.name}
        </Button>
      )))}
      <Button disabled={!connected || busy} onClick={() => go({ args: ['create', 'New board'], rename: true })}>+ New board</Button>
    </nav>
  )
}

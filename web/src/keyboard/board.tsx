import { useEffect, useRef, useState } from 'react'
import type { BoardState } from '../../../src/core/model.ts'
import type { Command } from '../board/connection.ts'
import { caretInto, hostOf, latestReply } from '../board/caret.ts'
import { focusElement, type ActionContext } from './registry.tsx'
import { navigate, restoreAnchor, type BoardAnchor, type ColumnCards } from './navigation.ts'

const anchorElement = ({ anchor }: { anchor: BoardAnchor }) => anchor.card
  ? `[data-card="${CSS.escape(anchor.card)}"]`
  : `[data-column-heading="${CSS.escape(anchor.column)}"]`

const readAnchor = ({ target }: { target: HTMLElement }): BoardAnchor | undefined => {
  const column = target.closest<HTMLElement>('[data-column]')?.dataset.column

  if (!column) {
    return undefined
  }

  const card = target.closest<HTMLElement>('[data-card]')?.dataset.card

  return { column, ...(card ? { card } : {}) }
}

export function useBoardKeyboard({
  state,
  groups,
  page,
  setPage,
  selected,
  open,
  close,
  command,
  connected,
  notify,
  newColumn,
  cancelColumn,
  toggleTopbar,
  showTopbar,
}: {
  state: BoardState
  groups: ColumnCards[]
  page: string
  setPage({ page }: { page: string }): void
  selected: string | null
  open({ id }: { id: string }): void
  close(): void
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
  newColumn: boolean
  cancelColumn(): void
  toggleTopbar(): void
  showTopbar(): void
}) {
  const [remembered, setRemembered] = useState<Record<string, string>>({})
  const focus = useRef<BoardAnchor | undefined>(undefined)
  const moving = useRef(false)
  useEffect(() => {
    const track = (event: FocusEvent) => {
      const anchor = readAnchor({ target: event.target as HTMLElement })

      if (anchor) {
        focus.current = anchor

        if (anchor.card) {
          setRemembered(r => r[anchor.column] === anchor.card
            ? r : { ...r, [anchor.column]: anchor.card! })
        }
      }
    }

    document.addEventListener('focusin', track)

    return () => document.removeEventListener('focusin', track)
  }, [])
  const focusComposer = () => requestAnimationFrame(() => focusElement({ selector: '.detail .composer textarea' }))

  const leaveField = () => {
    if (page === 'board' && focus.current) {
      const anchor = restoreAnchor({ columns: groups, previous: groups, anchor: focus.current })
      focusElement({ selector: anchorElement({ anchor }) })
    }
  }

  const move = ({ direction, anchor }: { direction: string; anchor: BoardAnchor }) => {
    if (moving.current || !connected) {
      return
    }

    const index = groups.findIndex(c => c.id === anchor.column)
    const column = groups[index]

    if (!column) {
      return
    }

    let name: string, args: string[], next = anchor

    if (anchor.card) {
      const card = state.cards[anchor.card]

      if (!card) {
        return
      }

      const at = column.cards.indexOf(card.id)
      const horizontal = direction === 'left' || direction === 'right'
      const to = horizontal ? groups[index + (direction === 'left' ? -1 : 1)] : column

      if (!to || (!horizontal && (direction === 'up' ? at === 0 : at === column.cards.length - 1))) {
        return
      }

      const before = horizontal ? undefined : column.cards[at + (direction === 'up' ? -1 : 2)]
      name = 'move'; args = [card.id, to.id, ...(before ? ['--before', before] : []), '--if-revision', String(card.revision)]
      next = { column: to.id, card: card.id }
    } else {
      if (!['left', 'right'].includes(direction) || (direction === 'left' ? index === 0 : index === groups.length - 1)) {
        return
      }

      const before = groups[index + (direction === 'left' ? -1 : 2)]?.id
      name = 'column'; args = ['reorder', column.id, ...(before ? ['--before', before] : []), '--if-revision', String(state.boardRevision ?? 0)]
    }

    moving.current = true
    void command({ name, args: [...args, '--event-id', crypto.randomUUID()] })
      .then(() => requestAnimationFrame(() => {
        focusElement({ selector: anchorElement({ anchor: next }) })
      }))
      .catch(e => notify({ text: e.message }))
      .finally(() => {
        moving.current = false
      })
  }

  const onAction = ({ id, context }: { id: string; context: ActionContext }): boolean => {
    const anchor = readAnchor({ target: context.target }) ?? focus.current
      ?? (groups[0] ? { column: groups[0].id, card: groups[0].cards[0] } : undefined)

    if (id.startsWith('move.') && anchor) {
      move({ direction: id.slice(5), anchor })

      return true
    }

    if (id === 'cancel') {
      if (newColumn) {
        cancelColumn()
      } else if (context.scope === 'composer') {
        const host = hostOf({ from: context.target })

        if (host) {
          caretInto({ host, target: latestReply({ host }), edge: 'start' })
        }
      } else if (selected && page === 'board') {
        close()
      } else if (page !== 'board') {
        setPage({ page: 'board' })
      } else {
        return false
      }

      return true
    }

    if (id.startsWith('board.') && id !== 'board.open' && anchor) {
      const next = navigate({ columns: groups, current: anchor, action: id, remembered })
      focusElement({ selector: anchorElement({ anchor: next }) })

      return true
    }

    if (['thread.reply', 'reply'].includes(id) && context.scope !== 'board') {
      const input = context.target.closest('.detail, .hydra-chat')?.querySelector<HTMLTextAreaElement>('.composer textarea'); input?.focus()

      return !!input
    }

    if ((id === 'board.open' || id === 'reply') && anchor?.card) {
      open({ id: anchor.card }); focusComposer()

      return true
    }

    if (id === 'topbar') {
      toggleTopbar()

      return true
    }

    if (id === 'palette' || id === 'find') {
      showTopbar(); requestAnimationFrame(() => focusElement({ selector: '[data-search-slot] input' }))

      return true
    }

    if (['settings', 'help'].includes(id)) {
      setPage({ page: 'settings' }); requestAnimationFrame(() => focusElement({ selector: '[data-settings-heading]' }))

      return true
    }

    if (id === 'search') {
      setPage({ page: 'history' })

      return true
    }

    return false
  }

  return { remembered, onAction, leaveField, hints: [], hintKey: () => false }
}

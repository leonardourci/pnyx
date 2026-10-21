import { useEffect, useRef, useState } from 'react'
import type { HydraState } from '../../../src/core/model.ts'
import type { Command } from '../hydra/connection.ts'
import { placeMessageCaret, conversationMessages, latestAgentMessage } from '../hydra/caret.ts'
import { focusElement, type ActionContext } from './registry.tsx'
import { navigate, restoreAnchor, type HydraAnchor, type ColumnCards } from './navigation.ts'

const anchorElement = ({ anchor }: { anchor: HydraAnchor }) => anchor.card
  ? `[data-card="${CSS.escape(anchor.card)}"]`
  : `[data-column-heading="${CSS.escape(anchor.column)}"]`

const readAnchor = ({ target }: { target: HTMLElement }): HydraAnchor | undefined => {
  const column = target.closest<HTMLElement>('[data-column]')?.dataset.column

  if (!column) {
    return undefined
  }

  const card = target.closest<HTMLElement>('[data-card]')?.dataset.card

  return {
    column,
    ...(card ? { card } : {}),
  }
}

export function useHydraKeyboard({
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
  togglePanel,
  showPanel,
}: {
  state: HydraState
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
  togglePanel(): void
  showPanel(): void
}) {
  const [
    remembered,
    setRemembered,
  ] = useState<Record<string, string>>({})
  const focus = useRef<HydraAnchor | undefined>(undefined)
  useEffect(
    () => {
      const track = (event: FocusEvent) => {
        const anchor = readAnchor({ target: event.target as HTMLElement })

        if (anchor) {
          focus.current = anchor

          if (anchor.card) {
            setRemembered(r => r[anchor.column] === anchor.card
              ? r : {
                ...r,
                [anchor.column]: anchor.card!,
              })
          }
        }
      }

      document.addEventListener(
        'focusin',
        track,
      )

      return () => document.removeEventListener(
        'focusin',
        track,
      )
    },
    [],
  )
  const focusUpdates = () => requestAnimationFrame(() => focusElement({ selector: '.task-updates' }))

  const leaveField = () => {
    if (page === 'hydra' && focus.current) {
      const anchor = restoreAnchor({
        columns: groups,
        previous: groups,
        anchor: focus.current,
      })
      focusElement({ selector: anchorElement({ anchor }) })
    }
  }

  const move = ({
    direction,
    anchor,
  }: {
    direction: string
    anchor: HydraAnchor
  }) => {
    if (!connected) {
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
      name = 'move'; args = [
        card.id,
        to.id,
        ...(before ? [
          '--before',
          before,
        ] : []),
        '--if-revision',
        String(card.revision),
      ]
      next = {
        column: to.id,
        card: card.id,
      }
    } else {
      if (![
        'left',
        'right',
      ].includes(direction) || (direction === 'left' ? index === 0 : index === groups.length - 1)) {
        return
      }

      const before = groups[index + (direction === 'left' ? -1 : 2)]?.id
      name = 'column'; args = [
        'reorder',
        column.id,
        ...(before ? [
          '--before',
          before,
        ] : []),
        '--if-revision',
        String(state.configRevision ?? 0),
      ]
    }

    void command({
      name,
      args: [
        ...args,
        '--event-id',
        crypto.randomUUID(),
      ],
    })
      .catch(e => notify({ text: e.message }))
    focus.current = next
    requestAnimationFrame(() => focusElement({ selector: anchorElement({ anchor: next }) }))
  }

  const onAction = ({
    id,
    context,
  }: {
    id: string
    context: ActionContext
  }): boolean => {
    const anchor = readAnchor({ target: context.target }) ?? focus.current
      ?? (groups[0] ? {
        column: groups[0].id,
        card: groups[0].cards[0],
      } : undefined)

    if (id.startsWith('move.') && anchor) {
      move({
        direction: id.slice(5),
        anchor,
      })

      return true
    }

    if (id === 'cancel') {
      if (newColumn) {
        cancelColumn()
      } else if (context.scope === 'composer') {
        const host = conversationMessages({ from: context.target })

        if (host) {
          placeMessageCaret({
            host,
            target: latestAgentMessage({ host }),
            edge: 'start',
          })
        }
      } else if (selected && page === 'hydra') {
        close()
      } else if (page !== 'hydra') {
        setPage({ page: 'hydra' })
      } else {
        return false
      }

      return true
    }

    if (id.startsWith('board.') && id !== 'board.open' && anchor) {
      const next = navigate({
        columns: groups,
        current: anchor,
        action: id,
        remembered,
      })
      focusElement({ selector: anchorElement({ anchor: next }) })

      return true
    }

    if ([
      'thread.reply',
      'reply',
    ].includes(id) && context.scope !== 'hydra') {
      const input = context.target.closest('.hydra-chat')?.querySelector<HTMLTextAreaElement>('.composer textarea'); input?.focus()

      return !!input
    }

    if ((id === 'board.open' || id === 'reply') && anchor?.card) {
      open({ id: anchor.card }); focusUpdates()

      return true
    }

    if (id === 'topbar') {
      togglePanel()

      return true
    }

    if (id === 'palette' || id === 'find') {
      showPanel(); requestAnimationFrame(() => focusElement({ selector: '[data-oracle-slot] input' }))

      return true
    }

    if ([
      'settings',
      'help',
    ].includes(id)) {
      setPage({ page: 'settings' }); requestAnimationFrame(() => focusElement({ selector: '[data-settings-heading]' }))

      return true
    }

    if (id === 'search') {
      setPage({ page: 'history' })

      return true
    }

    return false
  }

  return {
    remembered,
    onAction,
    leaveField,
    hints: [],
    hintKey: () => false,
  }
}

import { useEffect, useRef } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Command } from '#web-app/connection.ts'
import { compareTasks, nextSibling, IDEAS_COLUMN } from '#web-tasks/project-view.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { placeMessageCaret, conversationMessages, latestAgentMessage } from '#web-hydra/caret.ts'
import { focusElement, type ActionContext } from './keyboard-registry.tsx'
import { navigate, restoreAnchor, type HydraAnchor, type ColumnCards } from './keyboard-navigation.ts'

const anchorElement = ({
  hydraId,
  anchor,
}: {
  hydraId: string
  anchor: HydraAnchor
}) => {
  const target = anchor.card
    ? `[data-card="${CSS.escape(anchor.card)}"]`
    : `[data-column-heading="${CSS.escape(anchor.column)}"]`

  return `[data-hydra-workspace="${CSS.escape(hydraId)}"] ${target}`
}

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
  hydraId,
  groups,
  actions,
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
  openSettings,
}: {
  state: HydraState
  hydraId: string
  groups: ColumnCards[]
  actions: Record<string, CurrentAction>
  page: string
  setPage({ page }: { page: string }): void
  selected: string | null
  open({ id }: { id: string }): void | Promise<boolean>
  close({ id }?: { id?: string }): void
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
  newColumn: boolean
  cancelColumn(): void
  togglePanel(): void
  openSettings(): void
}) {
  const remembered = useRef<Record<string, string>>({})
  const focus = useRef<HydraAnchor | undefined>(undefined)
  useEffect(
    () => {
      const track = (event: FocusEvent) => {
        const workspace = (event.target as HTMLElement).closest<HTMLElement>('[data-hydra-workspace]')

        if (workspace?.dataset.hydraWorkspace !== hydraId) {
          return
        }

        const anchor = readAnchor({ target: event.target as HTMLElement })

        if (anchor) {
          focus.current = anchor

          if (anchor.card) {
            remembered.current[anchor.column] = anchor.card
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
    [hydraId],
  )

  const leaveField = () => {
    if (page === 'hydra' && focus.current) {
      const anchor = restoreAnchor({
        columns: groups,
        previous: groups,
        anchor: focus.current,
      })
      focusElement({
        selector: anchorElement({
          hydraId,
          anchor,
        }),
      })
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

    let name: string, args: string[]
    const next = anchor

    if (anchor.card) {
      const card = state.cards[anchor.card]

      if (!card) {
        return
      }

      if (direction === 'left' || direction === 'right') {
        return
      }

      const siblings = card.parentId
        ? Object.values(state.cards).filter(item => item.parentId === card.parentId)
          .sort(compareTasks({
            state,
            actions,
          }))
        : column.cards.map(id => state.cards[id]).filter(item => item && !item.parentId)
      const at = siblings.findIndex(item => item.id === card.id)
      const target = at + (direction === 'up' ? -1 : 1)

      if (at < 0 || target < 0 || target >= siblings.length) {
        return
      }

      const reordered = [...siblings]
      reordered.splice(
        at,
        1,
      )
      reordered.splice(
        target,
        0,
        card,
      )
      const before = nextSibling({
        state,
        actions,
        card,
        cards: reordered,
      })
      name = 'task'; args = [
        'arrange',
        card.id,
        ...(before ? [
          '--before',
          before.id,
        ] : []),
        '--if-revision',
        String(card.revision),
      ]
    } else {
      if (![
        'left',
        'right',
      ].includes(direction) || (direction === 'left' ? index === 0 : index === groups.length - 1)) {
        return
      }

      const order = groups.map(group => group.id).filter(id => id !== IDEAS_COLUMN)
      const at = order.indexOf(column.id)
      const target = at + (direction === 'left' ? -1 : 1)

      if (at < 0 || target < 0 || target >= order.length) {
        return
      }

      order.splice(
        at,
        1,
      )
      order.splice(
        target,
        0,
        column.id,
      )
      name = 'view'; args = [
        'set',
        '--json',
        JSON.stringify({ workspace: { projectOrder: order } }),
        '--if-revision',
        String(state.viewRevision ?? 0),
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
    requestAnimationFrame(() => focusElement({
      selector: anchorElement({
        hydraId,
        anchor: next,
      }),
    }))
  }

  const onAction = ({
    id,
    context,
  }: {
    id: string
    context: ActionContext
  }): boolean => {
    if (id === 'settings') {
      openSettings()

      return true
    }

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
        close({ id: context.target.closest<HTMLElement>('.card.selected')?.dataset.task ?? selected })
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
        remembered: remembered.current,
      })
      focusElement({
        selector: anchorElement({
          hydraId,
          anchor: next,
        }),
      })

      return true
    }

    if ([
      'thread.reply',
      'reply',
    ].includes(id) && context.scope !== 'hydra') {
      const input = context.target.closest('.chat-frame')?.querySelector<HTMLTextAreaElement>('.composer textarea'); input?.focus()

      return !!input
    }

    if ((id === 'board.open' || id === 'reply') && anchor?.card) {
      void open({ id: anchor.card })

      return true
    }

    if (id === 'topbar') {
      togglePanel()

      return true
    }

    return false
  }

  return {
    onAction,
    leaveField,
    hints: [],
    hintKey: () => false,
  }
}

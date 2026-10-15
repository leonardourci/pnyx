import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BoardState } from '../../../src/core/model.ts'
import { KEY_ACTIONS } from '../../../src/core/keyboard.ts'
import { Button } from '../components/ui/controls.tsx'
import { CommandMenu, type MenuItem } from '../components/ui/command-menu.tsx'
import type { Command } from '../board/connection.ts'
import { columnsFor } from '../board/view.ts'
import { findCards } from '../board/card-search.ts'
import { caretInto, hostOf, latestReply } from '../board/caret.ts'
import { focusElement, useKeyboard, type ActionContext } from './registry.tsx'
import { navigate, restoreAnchor, type BoardAnchor, type ColumnCards } from './navigation.ts'
import { hintLabels, visibleTargets, type Hint } from './hints.ts'

interface Overlay { kind: 'palette' | 'help' | 'move'; context: ActionContext; card?: string; revision?: number }
const anchorElement = ({ anchor }: { anchor: BoardAnchor }) => anchor.card ? `[data-card="${CSS.escape(anchor.card)}"]` : `[data-empty-column="${CSS.escape(anchor.column)}"]`
const readAnchor = ({ target }: {
  target: HTMLElement
}): BoardAnchor | undefined => target.dataset.card
  ? { card: target.dataset.card, column: target.closest<HTMLElement>('[data-column]')!.dataset.column! }
  : target.dataset.emptyColumn
    ? { column: target.dataset.emptyColumn }
    : undefined

// Cards listed under the actions when a Cmd+K query finds some.
const CARD_RESULTS = 8

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
}) {
  const [remembered, setRemembered] = useState<Record<string, string>>({}), [overlay, setOverlay] = useState<Overlay | null>(null), [hints, setHints] = useState<Hint[]>([]), [hintPrefix, setHintPrefix] = useState('')
  const focus = useRef<{ anchor?: BoardAnchor; owned: boolean }>({ owned: false })
  const previous = useRef(groups)
  const returnFocus = useRef<HTMLElement | null>(null)
  const restoring = useRef(0)
  const signature = JSON.stringify(groups)
  useEffect(() => {
    const track = (e: FocusEvent) => {
      const target = e.target as HTMLElement, anchor = readAnchor({ target })
      focus.current.owned = !!anchor

      if (anchor) {
        focus.current.anchor = anchor

        if (anchor.card) {
          setRemembered(
            r => r[anchor.column] === anchor.card ? r : { ...r, [anchor.column]: anchor.card! },
          )
        }
      }
    }

    document.addEventListener('focusin', track)

    return () => document.removeEventListener('focusin', track)
  }, [])
  useLayoutEffect(() => {
    if (page === 'board' && focus.current.owned && focus.current.anchor) {
      const restored = restoreAnchor({
        columns: groups,
        previous: previous.current,
        anchor: focus.current.anchor,
      })

      if (document.activeElement === document.body || !document.activeElement?.isConnected) {
        focusElement({ selector: anchorElement({ anchor: restored }) })

        if (restored.card !== focus.current.anchor.card) {
          notify({ text: 'Board focus moved to the nearest visible card.' })
        }
      }
    }

    previous.current = groups
  }, [signature, page]) // The serialized groups capture only focus-relevant changes.
  useEffect(() => {
    if (!hints.length) {
      return
    }

    const cancel = () => {
      setHints([]); setHintPrefix('')
    }

    window.addEventListener('resize', cancel); document.addEventListener('scroll', cancel, true); document.addEventListener('pointerdown', cancel, true)

    return () => {
      window.removeEventListener('resize', cancel); document.removeEventListener('scroll', cancel, true); document.removeEventListener('pointerdown', cancel, true)
    }
  }, [hints])
  useEffect(() => {
    setHints([]); setHintPrefix('')
  }, [state.seq])
  const focusDetail = ({ composer }: { composer: boolean }) => requestAnimationFrame(() => {
    document.querySelector<HTMLButtonElement>('[data-conversation-tab]')?.click()
    requestAnimationFrame(() => focusElement({ selector: composer ? '.composer textarea' : '[data-key-scope=thread]' }))
  })

  const closeOverlay = () => {
    setOverlay(null); restoring.current = requestAnimationFrame(() => {
      if (returnFocus.current?.isConnected) {
        returnFocus.current.focus()
      } else if (focus.current.anchor) {
        focusElement({
          selector: anchorElement({
            anchor: restoreAnchor({
              columns: groups,
              previous: previous.current,
              anchor: focus.current.anchor,
            }),
          }),
        })
      }
    })
  }

  const showOverlay = ({ kind, context }: { kind: Overlay['kind']; context: ActionContext }) => {
    cancelAnimationFrame(restoring.current)
    returnFocus.current = context.target
    const id = readAnchor({ target: context.target })?.card ?? selected ?? undefined
    setOverlay({ kind, context, card: id, revision: id ? state.cards[id]?.revision : undefined })
  }

  const onAction = ({ id, context }: { id: string; context: ActionContext }): boolean => {
    const anchor = readAnchor({ target: context.target })
      ?? focus.current.anchor
      ?? (groups[0] ? { column: groups[0].id, card: groups[0].cards[0] } : undefined)
    const cardId = context.scope === 'board' ? anchor?.card : selected ?? undefined

    if (id === 'cancel') {
      if (hints.length) {
        setHints([]); setHintPrefix('')
      } else if (overlay) {
        closeOverlay()
      } else if (newColumn) {
        cancelColumn()
      } else if (context.scope === 'composer') {
        const host = hostOf({ from: context.target })

        if (!host || !caretInto({ host, target: latestReply({ host }), edge: 'start' })) {
          focusDetail({ composer: false })
        }
      } else if (selected && page === 'board') {
        close()
      } else if (page !== 'board') {
        setPage({ page: 'board' }); requestAnimationFrame(() => anchor && focusElement({ selector: anchorElement({ anchor }) }))
      } else {
        return false
      }

      return true
    }

    if (id.startsWith('board.') && id !== 'board.open' && anchor) {
      focusElement({
        selector: anchorElement({
          anchor: navigate({
            columns: groups,
            current: anchor,
            action: id,
            remembered,
          }),
        }),
      })

      return true
    }

    if (id === 'thread.reply') {
      return focusElement({ selector: '.composer textarea' })
    }

    if (id.startsWith('thread.') && id !== 'thread.comment') {
      const el = document.querySelector<HTMLElement>('[data-key-scope=thread]')

      if (!el) {
        return false
      }

      const by = id === 'thread.up' ? -60 : id === 'thread.down' ? 60 : id === 'thread.pageUp' ? -el.clientHeight : el.clientHeight
      el.scrollTop = id === 'thread.first' ? 0 : id === 'thread.last' ? el.scrollHeight : el.scrollTop + by

      return true
    }

    if ((id === 'board.open' || id === 'reply') && cardId) {
      open({ id: cardId }); focusDetail({ composer: true })

      return true
    }

    if (id === 'move' && cardId && connected) {
      showOverlay({ kind: 'move', context })

      return true
    }

    if (id === 'find') {
      return (page === 'board' || page === 'history')
        && focusElement({ selector: page === 'board' ? "[aria-label='Find a card']" : "[aria-label='Search history']" })
    }

    if (id === 'search' || id === 'settings') {
      setPage({ page: id === 'search' ? 'history' : 'settings' }); requestAnimationFrame(() => focusElement({ selector: id === 'search' ? "[aria-label='Search history']" : '[data-settings-heading]' }))

      return true
    }

    if (id === 'palette' || id === 'help') {
      showOverlay({ kind: id, context })

      return true
    }

    if (id === 'hints') {
      const targets = visibleTargets(), labels = hintLabels({ count: targets.length }); setHints(targets.map((t, i) => ({ ...t, label: labels[i] }))); setHintPrefix('')

      return true
    }

    return false
  }

  const leaveField = () => {
    const anchor = focus.current.anchor
      ?? (groups[0] ? { column: groups[0].id, card: groups[0].cards[0] } : undefined)

    if (page === 'board' && anchor) {
      focusElement({
        selector: anchorElement({
          anchor: restoreAnchor({
            columns: groups,
            previous: previous.current,
            anchor,
          }),
        }),
      })
    }
  }

  const hintKey = ({ event }: { event: KeyboardEvent }) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.getModifierState('AltGraph') || event.repeat) {
      return false
    }

    if (event.key === 'Tab') {
      setHints([]); setHintPrefix('')

      return false
    }

    if (event.key === 'Backspace') {
      setHintPrefix(p => p.slice(0, -1))

      return true
    }

    if (event.key.length !== 1) {
      return false
    }

    const prefix = hintPrefix + event.key.toLowerCase()
    const matching = hints.filter(h => h.label.startsWith(prefix))

    if (!matching.length) {
      setHintPrefix(''); notify({ text: 'No target matches. Type a visible hint label.' })

      return true
    }

    const exact = matching.find(h => h.label === prefix)

    if (exact) {
      setHints([]); setHintPrefix('')

      if (exact.element.isConnected) {
        exact.element.focus()

        if (exact.element.matches('button,a')) {
          exact.element.click()
        }
      }
    } else {
      setHintPrefix(prefix)
    }

    return true
  }

  const move = ({ to }: { to: string }) => {
    if (!overlay?.card) {
      return
    }

    const { card, revision } = overlay
    closeOverlay()
    void command({ name: 'move', args: [card, to, '--if-revision', String(revision), '--event-id', crypto.randomUUID()] }).then(() => notify({ text: 'Placement updated. Source requests are unchanged.' }))
      .catch(e => notify({ text: e.message }))
  }

  // Cmd+K also finds cards, ranked like every other search. Stable across
  // renders, so a board update does not restart the palette's pending search.
  const latest = useRef({ command, open, closeOverlay })
  latest.current = { command, open, closeOverlay }
  const searchCards = useCallback(async ({ query: q }: { query: string }): Promise<MenuItem[]> => {
    const hits = await findCards({ command: latest.current.command, query: q })

    return hits.slice(0, CARD_RESULTS).map(h => ({
      id: `card:${h.card}`,
      label: h.title,
      detail: h.match === 'semantic' ? 'Open card · similar meaning' : 'Open card',
      run: () => {
        latest.current.closeOverlay(); latest.current.open({ id: h.card })
      },
    }))
  }, [])

  return {
    remembered,
    searchCards,
    onAction,
    leaveField,
    hintKey,
    hints,
    hintPrefix,
    overlay,
    closeOverlay,
    move,
  }
}

export function KeyboardToolbar({
  action,
}: {
  action({ id, context }: { id: string; context: ActionContext }): boolean
}) {
  const { label } = useKeyboard()

  return (
    <div className="keyboard-toolbar">
      <Button onClick={e => action({ id: 'palette', context: { scope: 'navigation', target: e.currentTarget } })}>
        Commands
        {' '}
        <kbd>{label({ id: 'palette' })}</kbd>
      </Button>
      <Button onClick={e => action({ id: 'help', context: { scope: 'navigation', target: e.currentTarget } })}>
        Help
        {' '}
        <kbd>{label({ id: 'help' })}</kbd>
      </Button>
      <Button onClick={e => action({ id: 'hints', context: { scope: 'navigation', target: e.currentTarget } })}>
        Hints
        {' '}
        <kbd>{label({ id: 'hints' })}</kbd>
      </Button>
    </div>
  )
}

export function KeyboardFooter() {
  const { label } = useKeyboard()

  return (
    <span>
      {label({ id: 'board.down' })}
      {' '}
      next ·
      {' '}
      {label({ id: 'board.open' })}
      {' '}
      open ·
      {' '}
      {label({ id: 'reply' })}
      {' '}
      reply
    </span>
  )
}

export function KeyboardLayers({
  keyboard,
  state,
  connected,
}: {
  keyboard: ReturnType<typeof useBoardKeyboard>
  state: BoardState
  connected: boolean
}) {
  const { label, prefs, handlers } = useKeyboard()
  const { overlay, closeOverlay, onAction, move, hints, hintPrefix, searchCards } = keyboard
  let items: MenuItem[] = []

  if (overlay) {
    const card = overlay.card ? state.cards[overlay.card] : undefined
    items = overlay.kind === 'move' ? columnsFor({ state }).map(c => ({ id: c.id, label: c.title, disabled: !connected || !card, run: () => move({ to: c.id }) })) : KEY_ACTIONS.filter(a => overlay.kind === 'help' || !['cancel', 'send', 'palette'].includes(a.id)).map(a => ({
      id: a.id,
      label: a.label,
      keyLabel: label({ id: a.id }),
      detail: `${a.scopes.join(' · ')}${!prefs.characterShortcuts ? ' · character keys disabled' : ''}`,
      disabled: ['cancel', 'send', 'palette'].includes(a.id) || (a.id.startsWith('board.') && overlay.context.scope !== 'board') || (a.id.startsWith('thread.') && overlay.context.scope !== 'thread') || (['move', 'reply'].includes(a.id) && (!card || (a.id === 'move' && !connected))),
      run: () => {
        // A component's own handler (such as comments on the thread) runs first.
        const run = () => handlers.get(a.id)?.({ context: overlay.context })
          || onAction({ id: a.id, context: overlay.context })
        setTimeout(run, 0); closeOverlay()
      },
    }))

    if (overlay.kind === 'palette') {
      items = items.filter(item => !item.disabled)
    }
  }

  return (
    <>
      {overlay && (
        <CommandMenu
          title={overlay.kind === 'move' ? 'Move card' : overlay.kind === 'help' ? 'Keyboard help' : 'Commands'}
          description={overlay.kind === 'move' ? 'Placement does not complete work or resolve a source request.' : 'Shortcuts follow the focused area. Edit every binding in Settings.'}
          items={items}
          close={closeOverlay}
          {...(overlay.kind === 'palette' ? { search: searchCards } : {})}
        />
      )}
      {hints.length > 0 && (
        <div className="hint-layer" aria-label="Target hints">
          {hints.filter(h => h.label.startsWith(hintPrefix)).map(h => <span className="target-hint" key={h.label} style={{ left: h.x, top: h.y }}>{h.label}</span>)}
          <div className="hint-instructions" role="status">
            {hints.length}
            {' '}
            targets · Type a label ·
            {' '}
            {label({ id: 'cancel' })}
            {' '}
            cancel · Backspace correct
          </div>
        </div>
      )}
    </>
  )
}

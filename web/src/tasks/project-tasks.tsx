import { runtimeStyle } from '#web-shared/ui/runtime-style.ts'
import { useFamilyFolds } from './task-view.ts'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { motion } from 'motion/react'
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Card } from '#tasks/model.ts'
import type { HydraState } from '#app/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { useSessionViewResource, sessionViewKey } from '#web-app/session-view.ts'
import { useWorkspaceViewport } from '#web-app/workspace-viewport.tsx'
import { CARD_SIZING, WORKSPACE_SIZING, cardGrid } from '#web-shared/card-sizing.ts'
import { useScrollOffset, observeCurrentScroll } from '#web-shared/ui/scroll-offset.ts'
import { taskRollup } from './project-view.ts'

interface Family {
  card: Card
  ids: string[]
  open: boolean
}

export function ProjectTasks({
  items,
  state,
  actions,
  selected,
  column,
  hydra,
  scroll,
  width,
  reveal,
  singleColumn = false,
  render,
}: {
  items: Card[]
  state: HydraState
  actions: Record<string, CurrentAction>
  selected: string[]
  column: string
  hydra: string
  scroll: HTMLElement | null
  width: number
  reveal?: string | null
  singleColumn?: boolean
  render({
    card,
    width,
  }: {
    card: Card
    width: number
  }): ReactNode
}) {
  const element = useRef<HTMLDivElement>(null)
  const margin = useScrollOffset({
    element,
    scroll,
  })
  const viewport = useWorkspaceViewport()
  const sizes = useSessionViewResource<Record<string, {
    width: number
    height: number
  }>>({
    key: sessionViewKey({
      scope: 'column',
      id: `${hydra}:${column}`,
      field: 'familySizes',
    }),
    initial: {},
  })
  const [folds] = useFamilyFolds({ hydraId: hydra })
  const gap = WORKSPACE_SIZING.cardGap
  const rows = useMemo(
    () => {
      const count = singleColumn ? 1 : cardGrid({ width }).columns
      const rows: Family[][] = []
      let row: Family[] = []

      for (const card of items) {
        const ids = [
          card.id,
          ...taskRollup({
            state,
            card,
            actions,
          }).children.map(child => child.id),
        ]
        const family = {
          card,
          ids,
          open: ids.some(id => selected.includes(id)) || ids.length > 1 && !!folds[card.id],
        }

        if (family.open && row.length) {
          rows.push(row)
          row = []
        }

        row.push(family)

        if (family.open || row.length === count) {
          rows.push(row)
          row = []
        }
      }

      if (row.length) {
        rows.push(row)
      }

      return rows
    },
    [
      items,
      state,
      actions,
      selected,
      width,
      singleColumn,
      folds,
    ],
  )
  const cellWidth = ({ row }: { row: Family[] }) => (width - (row.length - 1) * gap) / row.length
  const estimate = ({ row }: { row: Family[] }) => Math.max(...row.map(family => {
    const saved = sizes.snapshot()[family.card.key]

    return saved && Math.abs(saved.width - cellWidth({ row })) < 1 ? saved.height
      : family.open ? CARD_SIZING.open.height : CARD_SIZING.closed.minHeight
  }))
  const virtual = useVirtualizer({
    // The shared scroller owns restoration; mounting an inner window must not reset it.
    scrollToFn: () => undefined,
    observeElementOffset: observeCurrentScroll,
    count: rows.length,
    getScrollElement: () => scroll,
    // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
    getItemKey: index => rows[index]![0]!.card.key,
    // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
    estimateSize: index => estimate({ row: rows[index]! }),
    gap,
    overscan: 1,
    scrollMargin: margin,
    // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
    rangeExtractor: range => [
      ...new Set([
        ...defaultRangeExtractor(range),
        ...rows.flatMap((
          row,
          index,
        ) => row.some(family =>
          family.ids.some(id => viewport.tasks.get(hydra)?.has(id))) ? [index] : []),
      ]),
    ].sort((
      a,
      b,
    ) => a - b),
    useAnimationFrameWithResizeObserver: true,
  })
  const latest = useRef({
    rows,
    virtual,
  })
  latest.current = {
    rows,
    virtual,
  }
  const observer = useRef<ResizeObserver | null>(null)
  useLayoutEffect(
    () => {
      observer.current = new ResizeObserver(entries => {
        const previous = sizes.snapshot()
        const next = { ...previous }
        const changed = new Set<number>()

        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.virtualFamily!
          const size = entry.borderBoxSize[0]

          if (!size || (previous[key]?.width === size.inlineSize
          && previous[key]?.height === size.blockSize)) {
            continue
          }

          next[key] = {
            width: size.inlineSize,
            height: size.blockSize,
          }
          const index = latest.current.rows.findIndex(row =>
            row.some(family => family.card.key === key))

          if (index >= 0) {
            changed.add(index)
          }
        }

        sizes.remember({ value: next })
        changed.forEach(index => latest.current.virtual.resizeItem(
          index,
          Math.max(...latest.current.rows[index]!.map(family =>
            next[family.card.key]?.height ?? CARD_SIZING.closed.minHeight)),
        ))
      })
      element.current?.querySelectorAll('[data-virtual-family]').forEach(node => observer.current?.observe(node))

      return () => {
        observer.current?.disconnect()
        observer.current = null
        sizes.flush()
      }
    },
    [sizes],
  )
  const signature = rows.map(row => row.map(family => `${family.card.key}:${family.open}`).join(',')).join('|')
  useLayoutEffect(
    () => virtual.measure(),
    [
      signature,
      width,
    ],
  )
  useLayoutEffect(
    () => {
      const index = rows.findIndex(row => row.some(family => family.ids.includes(reveal ?? '')))

      if (index >= 0) {
        const offset = virtual.getOffsetForIndex(
          index,
          'start',
        )?.[0]

        if (offset !== undefined) {
          scroll?.scrollTo({
            top: offset,
            behavior: 'instant',
          })
        }
      }
    },
    [
      reveal,
      signature,
      margin,
    ],
  )
  const visible = virtual.getVirtualItems()

  return (
    <div
      ref={element}
      data-scroll-content
      className="relative w-full"
      style={runtimeStyle({ height: virtual.getTotalSize() })}
    >
      {visible.flatMap(row => rows[row.index]!.map((
        family,
        slot,
      ) => {
        const cell = cellWidth({ row: rows[row.index]! })

        return (
          <motion.div
            key={family.card.key}
            layout="position"
            data-virtual-family={family.card.key}
            // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
            ref={node => {
              if (node) {
                observer.current?.observe(node)
              }

              return () => {
                if (node) {
                  observer.current?.unobserve(node)
                }
              }
            }}
            className="absolute min-w-0"
            style={runtimeStyle({
              top: row.start - margin,
              left: slot * (cell + gap),
              width: cell,
            })}
          >{render({
              card: family.card,
              width: cell,
            })}
          </motion.div>
        )
      }))}
    </div>
  )
}

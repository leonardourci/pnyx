import { useFamilyFolds } from './task-view.ts'
import { motion } from 'motion/react'
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Card } from '#tasks/model.ts'
import type { HydraState } from '#app/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { WORKSPACE_SIZING, cardGrid } from '#web-shared/card-sizing.ts'
import { layoutOffset } from '#web-shared/ui/layout-geometry.ts'
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
  hydra,
  width,
  reveal,
  singleColumn = false,
  render,
}: {
  items: Card[]
  state: HydraState
  actions: Record<string, CurrentAction>
  selected: string[]
  hydra: string
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
  const revealedFamily = reveal
    ? rows.flat().find(family => family.ids.includes(reveal)) : undefined
  const revealedKey = revealedFamily?.card.key
  useLayoutEffect(
    () => {
      if (revealedKey === undefined) {
        return
      }

      const list = element.current
      const column = list?.closest<HTMLElement>('.column-cards')
      const family = list?.querySelector<HTMLElement>(`:scope > [data-family-key="${CSS.escape(revealedKey)}"]`)

      if (!column || !family) {
        return
      }

      const top = layoutOffset({
        element: family,
        horizontal: false,
      }) - layoutOffset({
        element: column,
        horizontal: false,
      }) - column.clientTop

      column.scrollTo({
        top,
        behavior: 'instant',
      })
    },
    [
      reveal,
      revealedKey,
      width,
    ],
  )

  return (
    <div
      ref={element}
      data-scroll-content
      className="relative flex w-full flex-wrap content-start"
      style={{ gap }}
    >
      {rows.flatMap(row => {
        const cellWidth = (width - (row.length - 1) * gap) / row.length

        return row.map(family => (
          <motion.div
            key={family.card.key}
            layout="position"
            data-family-key={family.card.key}
            className="min-w-0 flex-none"
            style={{ width: cellWidth }}
          >{render({
              card: family.card,
              width: cellWidth,
            })}
          </motion.div>
        ))
      })}
    </div>
  )
}

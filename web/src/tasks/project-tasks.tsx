import { useFamilyFolds } from './task-view.ts'
import { motion } from 'motion/react'
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Card } from '#tasks/model.ts'
import type { HydraState } from '#app/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { WORKSPACE_SIZING, cardGrid } from '#web-shared/card-sizing.ts'
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
  const cellWidth = ({ row }: { row: Family[] }) => (width - (row.length - 1) * gap) / row.length
  const signature = rows.map(row => row.map(family => family.card.key).join(',')).join('|')
  useLayoutEffect(
    () => {
      const family = rows.flat().find(family => family.ids.includes(reveal ?? ''))

      if (family) {
        const node = [...element.current?.querySelectorAll<HTMLElement>('[data-family-key]') ?? []]
          .find(node => node.dataset.familyKey === family.card.key)
        node?.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: 'instant',
        })
      }
    },
    [
      reveal,
      signature,
    ],
  )

  return (
    <div
      ref={element}
      data-scroll-content
      className="relative flex w-full flex-wrap content-start"
      style={{ gap }}
    >
      {rows.flatMap(row => row.map(family => (
        <motion.div
          key={family.card.key}
          layout="position"
          data-family-key={family.card.key}
          className="min-w-0 flex-none"
          style={{ width: cellWidth({ row }) }}
        >{render({
            card: family.card,
            width: cellWidth({ row }),
          })}
        </motion.div>
      )))}
    </div>
  )
}

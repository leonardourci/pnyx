import type { TitanState } from '#app/model.ts'
import type { TitanProjectSummary } from '#app/server-hydras.ts'
import type { CurrentAction } from '#titan/calls.ts'
import type { Hit } from '#oracle/model.ts'
import type { Command } from '#web-app/connection.ts'
import { knownCards } from '#tasks/select.ts'
import { taskRollup } from '#web-tasks/project-view.ts'
import type { Filter } from './filters.ts'
import { oracleResults, type OracleResult } from './results.ts'

export type ScopedHit = Hit & { hydra?: string }
export interface OracleWorkspace {
  state: TitanState
  hydra: {
    id: string
    name: string
    icon: string
  }
  projects: TitanProjectSummary[]
  actions: Record<string, CurrentAction>
}

export function workspaceSearch({
  ids,
  commandFor,
}: {
  ids: string[]
  commandFor({ id }: { id: string }): Command
}): Command {
  return async ({
    name,
    args,
  }) => {
    const receipts = await Promise.allSettled(ids.map(async id => {
      const receipt = await commandFor({ id })({
        name,
        args,
      })
      const hits = Array.isArray(receipt.hits) ? receipt.hits as Hit[] : []

      return hits.map(hit => ({
        ...hit,
        hydra: id,
      }))
    }))

    const hits: ScopedHit[] = []
    const failures: string[] = []

    for (const [
      index,
      receipt,
    ] of receipts.entries()) {
      if (receipt.status === 'fulfilled') {
        hits.push(...receipt.value)
      } else {
        failures.push(`${ids[index]}: ${receipt.reason instanceof Error ? receipt.reason.message : String(receipt.reason)}`)
      }
    }

    if (failures.length === ids.length && failures.length) {
      throw new Error(failures.join('; '))
    }

    return {
      hits,
      partialFailure: failures.join('; '),
    }
  }
}

export function workspaceResults({
  workspaces,
  hits,
  text,
  badges,
  now,
}: {
  workspaces: OracleWorkspace[]
  hits: ScopedHit[]
  text: string
  badges: Filter[]
  now: number
}) {
  const merged = new Map<string, OracleResult[]>()

  for (const workspace of workspaces) {
    const groups = oracleResults({
      state: workspace.state,
      hits: hits.filter(hit => hit.hydra === workspace.hydra.id),
      projects: workspace.projects,
      actions: [],
      cardActions: workspace.actions,
      hydra: workspace.hydra,
      text,
      badges,
      now,
    })

    for (const group of groups) {
      const results = group.results.filter(result => {
        if (text || badges.length) {
          return result.kind !== 'setting' && result.kind !== 'panel'
        }

        return result.kind === 'task' && taskRollup({
          state: workspace.state,
          card: result.card,
          actions: workspace.actions,
        }).status.kind === 'asks'
      }).map(result => {
        const parent = result.kind === 'task' && result.card.parentId
          ? knownCards({ state: workspace.state })[result.card.parentId] : undefined

        return {
          ...result,
          title: parent ? `${parent.title} › ${result.title}` : result.title,
          id: `${workspace.hydra.id}:${result.id}`,
        }
      })
      const label = !text && !badges.length ? 'Needs you' : group.label
      merged.set(
        label,
        [
          ...(merged.get(label) ?? []),
          ...results,
        ],
      )
    }
  }

  return [...merged].filter(([
    , results,
  ]) => results.length).map(([
    label,
    results,
  ]) => ({
    label,
    results,
  }))
}

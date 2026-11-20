import { useLinkRefresh } from './link-refresh.ts'
import { Prerequisites } from './prerequisites.tsx'
import { TaskUpdates } from './task-updates.tsx'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { columnsFor } from './view.ts'
import type { Command } from '#web-app/connection.ts'

export function Detail({
  card,
  state,
  command,
  connected,
}: {
  card: Card
  state: HydraState
  command: Command
  connected: boolean
}) {
  useLinkRefresh({
    task: card.id,
    command,
    connected,
  })

  return (
    <section aria-label={`Details for ${card.title}`} className="detail relative mt-0.75 flex min-h-0 min-w-0 flex-none flex-col overflow-visible border-t border-line bg-transparent pt-2">
      <Prerequisites card={card} state={state} />
      <TaskUpdates
        card={card}
        columns={columnsFor({ state })}
        command={command}
        connected={connected}
      />
    </section>
  )
}

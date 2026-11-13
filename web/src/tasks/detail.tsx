import { ZeroProvider } from '@rocicorp/zero/react'
import { usePageZero } from '#web-app/zero.ts'
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
  hydraId,
}: {
  card: Card
  state: HydraState
  command: Command
  connected: boolean
  // The open Hydra's id, which its unconfigured state does not carry.
  hydraId: string
}) {
  useLinkRefresh({
    task: card.id,
    command,
    connected,
  })
  // Updates read through the page's one Zero client once the connection opens it. The provider sits here, not at the
  // root, because a ZeroProvider renders nothing without a client, so at the root it would blank and remount the page.
  const zero = usePageZero()

  return (
    <section aria-label={`Details for ${card.title}`} className="detail inline">
      <Prerequisites card={card} state={state} />
      {zero && (
        <ZeroProvider zero={zero}>
          <TaskUpdates
            card={card}
            columns={columnsFor({ state })}
            hydraId={hydraId}
          />
        </ZeroProvider>
      )}
    </section>
  )
}

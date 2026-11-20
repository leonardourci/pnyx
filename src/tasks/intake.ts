import { HYDRA_ACTOR } from '#app/actors.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from './model.ts'

const INTAKE_HINT = 'Run `pnyx-axi task intake --title "<what>" --project <project> --ask "<owner words>" --message <owner-message-id> --brief "<instructions>" --reason "<why>" --event-id <stable-id>` to create and start it; add --behind <task> to queue it, --on <task> for a dependency, or --hold to hold it for the owner'

export function recordsWhyUnstarted({ card }: { card: Card }): boolean {
  return Boolean(card.hold || card.queue || card.wait || card.prerequisites?.length)
}

export function requireStartOrReason({
  actor,
  waits,
}: {
  actor: string
  waits: boolean
}): void {
  if (actor !== HYDRA_ACTOR || waits) {
    return
  }

  throw new HydraError({
    message: 'a task Hydra creates must start, or record why it waits: a hold, a queue or a dependency',
    code: 'NOT_STARTED',
    help: [INTAKE_HINT],
  })
}

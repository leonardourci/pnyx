import { reportReviewGaps } from '#investigations/inventory.ts'
import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { isFolder } from '#projects/copies.ts'
import { git } from '#projects/git.ts'
import { landedWork } from './proof.ts'
import { taskLanding } from './rule.ts'
import { loadHydra } from '#app/store.ts'

// What still stands between a task and done when it has no copy to read, or undefined when its copy must be read.
function gapsWithoutCopy({
  state,
  card,
  hydraId,
}: {
  state: HydraState
  card: Card
  hydraId: string
}): string[] | undefined {
  if (card.kind === 'investigation') {
    return card.report ? reportReviewGaps({
      state,
      card,
    }) : [`no stored report: store it with \`pnyx-axi task report ${card.id} --file <path> --hydra ${hydraId}\``]
  }

  // Without a copy to read, an unconfirmed pull request is the remaining landing evidence.
  if (card.copy?.state !== 'active' || !isFolder({ path: card.copy.path })) {
    const waiting = card.links.some(l => l.kind === 'github_pr' && l.state !== 'merged' && l.state !== 'closed')

    return waiting ? ['its pull request has not merged'] : []
  }

  return undefined
}

// What still stands between a task and done; empty when its work has landed by its project's rule.
export async function doneGaps({
  state,
  card,
  hydraId,
}: {
  state: HydraState
  card: Card
  hydraId: string
}): Promise<string[]> {
  const quick = gapsWithoutCopy({
    state,
    card,
    hydraId,
  })

  if (quick) {
    return quick
  }

  const copy = card.copy!

  const status = await git({
    cwd: copy.path,
    args: [
      'status',
      '--porcelain',
    ],
  })
  const head = await git({
    cwd: copy.path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })

  if (!status.ok || !head.ok) {
    return ['could not read the current copy; its landing is unproved']
  }

  const gaps: string[] = []
  const changed = status.out ? status.out.split('\n').length : 0

  if (changed > 0) {
    gaps.push(`${changed} ${changed === 1 ? 'file' : 'files'} uncommitted`)
  }

  const { landed } = await landedWork({
    card,
    copy,
    head: head.out,
  })
  const rule = taskLanding({
    state,
    card,
  })

  if (landed || rule?.landing === 'branch') {
    return gaps
  }

  const pushed = await git({
    cwd: copy.path,
    args: [
      'branch',
      '--remotes',
      '--contains',
      head.out,
    ],
  })

  if (!pushed.ok || !pushed.out) {
    gaps.push(`commit ${head.out.slice(
      0,
      7,
    )} is not pushed`)
  }

  if (card.links.some(l => l.kind === 'github_pr' && l.state !== 'closed')) {
    gaps.push(card.links.some(l => l.kind === 'github_pr' && l.state === 'merged')
      ? 'its merged pull request does not prove the current work landed'
      : 'its pull request has not merged')
  } else {
    gaps.push('no linked pull request')
  }

  return gaps
}

// The landing gaps of the tasks these refs name, read with git and gh before a write so the write itself never waits on them.
export async function landingGaps({
  hydraId,
  refs,
}: {
  hydraId: string
  refs: string[]
}): Promise<Map<string, string[]>> {
  const state = loadHydra({ hydraId }).state
  const gaps = new Map<string, string[]>()

  for (const ref of refs) {
    const card = Object.values(state.cards).find(card => card.id === ref || card.key === ref)

    if (card) {
      gaps.set(
        card.id,
        await doneGaps({
          state,
          card,
          hydraId,
        }),
      )
    }
  }

  return gaps
}

// A done declaration stands only once the work is where the project's rule says it lands.
export function refuseEarlyDone({
  state,
  card,
  hydraId,
  landing,
}: {
  state: HydraState
  card: Card
  hydraId: string
  // Gaps landingGaps read before the write, by card id.
  landing: ReadonlyMap<string, string[]>
}): void {
  const gaps = gapsWithoutCopy({
    state,
    card,
    hydraId,
  }) ?? landing.get(card.id)

  if (!gaps) {
    throw new HydraError({
      message: `task ${card.id} changed while its landing was checked`,
      code: 'CONFLICT',
      help: ['Run the command again'],
    })
  }

  if (!gaps.length) {
    return
  }

  throw new HydraError({
    message: `not done yet: ${gaps.join('; ')}`,
    code: 'NOT_LANDED',
    help: card.kind === 'investigation'
      ? ['Store the report and review its owner decision inventory, then declare done again']
      : [
        `Land the work as the project's rule says and link its pull request with \`pnyx-axi link ${card.id} --url <url> --hydra ${hydraId}\``,
        `A ready pull request waiting for its merge is \`pnyx-axi task status ${card.id} needs_you\`, not done; Pnyx marks the task done when it merges`,
        'Only the owner can mark unlanded work done, by moving its card',
      ],
  })
}

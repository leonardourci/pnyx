import { reportReviewGaps } from '../investigation/inventory.ts'
import { HydraError, type Card } from '../core/model.ts'
import { type HydraState } from '../app/model.ts'
import { isFolder } from '../copies/copies.ts'
import { git } from '../copies/git.ts'
import { landedWork } from './proof.ts'
import { taskLanding } from './rule.ts'

// What still stands between a task and done; empty when its work has landed by its project's rule.
export function doneGaps({
  state,
  card,
  hydraId,
}: {
  state: HydraState
  card: Card
  hydraId: string
}): string[] {
  if (card.kind === 'investigation') {
    return card.report ? reportReviewGaps({
      state,
      card,
    }) : [`no stored report: store it with \`pnyx-axi task report ${card.id} --file <path> --hydra ${hydraId}\``]
  }

  const copy = card.copy

  // Without a copy to read, an unconfirmed pull request is the remaining landing evidence.
  if (copy?.state !== 'active' || !isFolder({ path: copy.path })) {
    const waiting = card.links.some(l => l.kind === 'github_pr' && l.state !== 'merged' && l.state !== 'closed')

    return waiting ? ['its pull request has not merged'] : []
  }

  const status = git({
    cwd: copy.path,
    args: [
      'status',
      '--porcelain',
    ],
  })
  const head = git({
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

  const landed = landedWork({
    card,
    copy,
    head: head.out,
  }).landed
  const rule = taskLanding({
    state,
    card,
  })

  if (landed || rule?.landing === 'branch') {
    return gaps
  }

  const pushed = git({
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

// A done declaration stands only once the work is where the project's rule says it lands.
export function refuseEarlyDone({
  state,
  card,
  hydraId,
}: {
  state: HydraState
  card: Card
  hydraId: string
}): void {
  const gaps = doneGaps({
    state,
    card,
    hydraId,
  })

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

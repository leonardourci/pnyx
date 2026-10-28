import type { Link } from './model.ts'
import type { MergeOutcome } from '../../integrations/github/merge-evidence.ts'

export function mergeObservation({
  link,
  outcome,
  at,
}: {
  link: Link
  outcome: MergeOutcome
  at: string
}): Link {
  const observed = { ...link }

  if (observed.mergeAttempt) {
    observed.mergeAttempt = {
      ...observed.mergeAttempt,
      outcome: outcome.outcome,
    }

    if (outcome.outcome === 'merged') {
      delete observed.mergeAttempt.detail
    } else {
      observed.mergeAttempt.detail = outcome.detail
    }
  }

  if (outcome.outcome === 'merged') {
    observed.state = 'merged'
    observed.mergeProof = {
      head: outcome.head,
      commit: outcome.commit,
      confirmedAt: at,
    }
  }

  return observed
}

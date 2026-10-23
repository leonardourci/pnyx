import { mergeApproval } from '../core/asks.ts'
import { commit, required, type Output } from '../cli/commands.ts'
import { decideLink, findCard, type Meta } from '../core/decide.ts'
import { HYDRA_ACTOR, HydraError, ownerActor, type Link } from '../core/model.ts'
import { mergePullRequest, pullRequestStatus, type PullRequestStatus } from '../integrations/github/pull-request.ts'
import { loadHydra, withWriter } from '../store/hydra-store.ts'
import { declareMerged } from './follow.ts'
import { taskLanding } from './rule.ts'

// gh-axi's last lines say why a merge failed; the rest is its usage noise.
const MERGE_ERROR_TAIL_CHARS = 300

function refuse({
  message,
  code = 'CONFLICT',
}: {
  message: string
  code?: string
}): never {
  throw new HydraError({
    message,
    code,
  })
}

function pullRequest({
  links,
  url,
}: {
  links: Link[]
  url?: string
}): Link {
  const open = links.filter(l => l.kind === 'github_pr' && l.state !== 'merged' && l.state !== 'closed')
  const chosen = url === undefined ? open : open.filter(l => l.url === url)

  if (chosen.length === 0) {
    refuse({
      message: url === undefined ? 'the task has no open linked pull request' : `the task has no open linked pull request ${url}`,
      code: 'NOT_FOUND',
    })
  }

  if (chosen.length > 1) {
    refuse({ message: 'the task links several open pull requests; name one with --url' })
  }

  return chosen[0]!
}

// Green means open, not a draft, no failed check and none still running.
function mustBeGreen({ status }: { status: PullRequestStatus }): void {
  if (status.state === 'closed') {
    refuse({ message: 'the pull request is closed' })
  }

  if (status.draft) {
    refuse({ message: 'the pull request is still a draft' })
  }

  if (status.checks.failed > 0) {
    refuse({ message: `checks are red: ${status.checks.summary}` })
  }

  if (status.checks.pending > 0) {
    refuse({ message: `checks are still running: ${status.checks.summary}` })
  }
}

// task merge <task> [--url <pull request>]: the owner, or Hydra where the task's rule lets it, merges a green pull request.
export async function mergeCommand({
  hydraId,
  ref,
  url,
  meta,
  readStatus = pullRequestStatus,
  merge = mergePullRequest,
}: {
  hydraId: string
  ref?: string
  url?: string
  meta: Meta
  readStatus?: typeof pullRequestStatus
  merge?: typeof mergePullRequest
}): Promise<Output> {
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref: required({
      value: ref,
      what: 'task id',
    }),
  })
  const rule = taskLanding({
    state,
    card,
  })
  const owner = ownerActor({ actor: meta.actor })

  if (!owner && meta.actor !== HYDRA_ACTOR) {
    refuse({
      message: 'only the owner or Hydra merges a pull request',
      code: 'FORBIDDEN',
    })
  }

  const link = pullRequest({
    links: card.links,
    url,
  })

  if (!owner && rule?.merge !== 'hydra' && !mergeApproval({
    card,
    url: link.url,
  })) {
    refuse({
      message: 'the owner merges this project\'s pull requests; ask them',
      code: 'FORBIDDEN',
    })
  }

  const status = await readStatus({ url: link.url })

  if (!status) {
    refuse({
      message: `gh-axi could not read ${link.url}`,
      code: 'UNAVAILABLE',
    })
  }

  if (status.state !== 'merged') {
    mustBeGreen({ status })
    const latestState = loadHydra({ hydraId }).state
    const latest = findCard({
      state: latestState,
      ref: card.id,
    })
    const currentRule = taskLanding({
      state: latestState,
      card: latest,
    })

    if (!owner && currentRule?.merge !== 'hydra' && !mergeApproval({
      card: latest,
      url: link.url,
    })) {
      refuse({
        message: 'the owner’s merge approval was withdrawn',
        code: 'FORBIDDEN',
      })
    }

    try {
      await merge({ url: link.url })
    } catch (error) {
      refuse({
        message: `gh-axi could not merge ${link.url}: ${(error as Error).message.trim().slice(-MERGE_ERROR_TAIL_CHARS)}`,
        code: 'MERGE_FAILED',
      })
    }
  }

  const receipt = commit({
    hydraId,
    meta,
    intent: {
      type: 'card.linked',
      card: card.id,
    },
    decide: ({ state }) => decideLink({
      state,
      ref: card.id,
      url: link.url,
      link: {
        ...link,
        state: 'merged',
        checks: status.checks.summary,
        checkedAt: meta.at,
      },
      meta,
    }),
  })
  withWriter({
    hydraId,
    fn: ({ writer }) => declareMerged({
      writer,
      cardId: card.id,
      url: link.url,
      at: meta.at,
    }),
  })

  return receipt
}

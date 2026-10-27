import { mergeApproval } from '../core/asks.ts'
import { commit, required, type Output } from '../app/cli-support.ts'
import { decideLink, findCard, type Meta } from '../core/decide.ts'
import { HydraError, type Link } from '../core/model.ts'
import { HYDRA_ACTOR, ownerActor } from '../app/actors.ts'
import { pullRequestMergeEvidence, pullRequestMergeOutcome } from '../integrations/github/merge-evidence.ts'
import { MergeRejectedError, mergePullRequest, pullRequestStatus, type PullRequestStatus } from '../integrations/github/pull-request.ts'
import { withWriter } from '../app/writer.ts'
import { loadHydra } from '../app/store.ts'
import { mergeObservation } from './merge-observation.ts'
import { confirmedMerge } from './confirmed.ts'
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
  readEvidence = pullRequestMergeEvidence,
  readOutcome = pullRequestMergeOutcome,
}: {
  hydraId: string
  ref?: string
  url?: string
  meta: Meta
  readStatus?: typeof pullRequestStatus
  merge?: typeof mergePullRequest
  readEvidence?: typeof pullRequestMergeEvidence
  readOutcome?: typeof pullRequestMergeOutcome
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

  let attempt = link.mergeAttempt

  if (status.state !== 'merged' && !attempt) {
    mustBeGreen({ status })
    let evidence

    try {
      evidence = await readEvidence({ url: link.url })
    } catch (error) {
      refuse({
        message: `merge evidence unreadable: ${(error as Error).message}`,
        code: 'UNAVAILABLE',
      })
    }

    if (evidence.problems.length) {
      refuse({ message: evidence.problems.join('; ') })
    }

    attempt = {
      outcome: 'unknown',
      head: evidence.head,
      requestedAt: meta.at,
      detail: 'merge requested; awaiting GitHub confirmation',
    }
    const claimed = withWriter({
      hydraId,
      fn: ({ writer }) => {
        const currentCard = writer.state.cards[card.id]
        const current = currentCard?.links.find(current => current.url === link.url)

        if (currentCard && !owner && taskLanding({
          state: writer.state,
          card: currentCard,
        })?.merge !== 'hydra'
          && !mergeApproval({
            card: currentCard,
            url: link.url,
          })) {
          refuse({
            message: 'the owner’s merge approval was withdrawn',
            code: 'FORBIDDEN',
          })
        }

        if (!current || current.state === 'closed') {
          refuse({ message: 'the linked pull request was removed or closed' })
        }

        if (current.mergeAttempt || current.state === 'merged') {
          return false
        }

        const decision = decideLink({
          state: writer.state,
          ref: card.id,
          url: link.url,
          link: {
            ...current,
            mergeAttempt: attempt,
          },
          meta,
        })

        if (!('event' in decision)) {
          return false
        }

        writer.append({ event: decision.event })

        return true
      },
    })

    if (claimed) {
      try {
        await merge({
          url: link.url,
          head: evidence.head,
        })
      } catch (error) {
        if (error instanceof MergeRejectedError) {
          commit({
            hydraId,
            meta,
            intent: {
              type: 'card.linked',
              card: card.id,
            },
            decide: ({ state }) => {
              const current = state.cards[card.id]?.links.find(current => current.url === link.url)

              if (!current || current.mergeAttempt?.requestedAt !== attempt?.requestedAt) {
                return { skipped: 'unchanged' }
              }

              return decideLink({
                state,
                ref: card.id,
                url: link.url,
                link: {
                  ...current,
                  mergeAttempt: undefined,
                },
                meta,
              })
            },
          })
          refuse({
            message: `GitHub rejected the merge: ${(error as Error).message.trim().slice(-MERGE_ERROR_TAIL_CHARS)}`,
            code: 'MERGE_FAILED',
          })
        }

        refuse({
          message: `gh-axi could not merge ${link.url}: ${(error as Error).message.trim().slice(-MERGE_ERROR_TAIL_CHARS)}; confirmation remains pending`,
          code: 'MERGE_FAILED',
        })
      }
    }
  }

  const outcome = await readOutcome({ url: link.url })
  const at = new Date().toISOString()
  const receipt = commit({
    hydraId,
    meta,
    intent: {
      type: 'card.linked',
      card: card.id,
    },
    decide: ({ state }) => {
      const current = state.cards[card.id]?.links.find(current => current.url === link.url)

      if (!current || current.state === 'merged') {
        return { skipped: 'unchanged' }
      }

      return decideLink({
        state,
        ref: card.id,
        url: link.url,
        link: mergeObservation({
          link: {
            ...current,
            checks: status.checks.summary,
            checkedAt: at,
          },
          outcome,
          at,
        }),
        meta: {
          ...meta,
          at,
        },
      })
    },
  })

  if (outcome.outcome === 'merged') {
    await confirmedMerge({
      hydraId,
      cardId: card.id,
      url: link.url,
      proof: {
        head: outcome.head,
        commit: outcome.commit,
        confirmedAt: at,
      },
    })
  }

  if (outcome.outcome === 'merged') {
    return {
      ...receipt,
      merge: outcome.outcome,
      url: link.url,
      head: outcome.head,
      commit: outcome.commit,
    }
  }

  return {
    ...receipt,
    merge: outcome.outcome,
    url: link.url,
    detail: outcome.detail,
  }
}

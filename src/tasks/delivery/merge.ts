import { inform } from '#app/command-notices.ts'
import { mergeApproval } from './merge-questions.ts'
import { commit, required, type Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { decideLink } from './links.ts'
import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import { HydraError } from '#store/errors.ts'
import type { Link } from './model.ts'
import { pullRequestMergeEvidence, pullRequestMergeOutcome } from '#integrations/github/merge-evidence.ts'
import { MergeRejectedError, mergePullRequest, pullRequestStatus, type PullRequestStatus } from '#integrations/github/pull-request.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { mergeObservation } from './merge-observation.ts'
import { refreshConfirmedProject } from '#projects/refresh-confirmed.ts'
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

function mergeNotices({ status }: { status: PullRequestStatus }): void {
  const reasons: string[] = []

  if (status.state === 'closed') {
    reasons.push('Pull request is closed')
  }

  if (status.draft) {
    reasons.push('Pull request is a draft')
  }

  if (status.checks.failed > 0) {
    reasons.push(`Checks are red: ${status.checks.summary}`)
  }

  if (status.checks.pending > 0) {
    reasons.push(`Checks are running: ${status.checks.summary}`)
  }

  for (const reason of reasons) {
    inform({
      reason,
      clear: 'Use pnyx-axi task refresh-links <task> to refresh the pull request facts',
    })
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
    inform({
      task: card.id,
      reason: 'Merge requested by a worker',
      clear: `Use pnyx-axi task landing ${card.id} --merge <owner|hydra> to change the merge default`,
    })
  }

  const link = pullRequest({
    links: card.links,
    url,
  })

  if (!owner && rule?.merge !== 'hydra' && !mergeApproval({
    state,
    card,
    url: link.url,
  })) {
    inform({
      task: card.id,
      reason: 'Merge requested while the landing rule defaults to the owner',
      clear: `Use pnyx-axi task landing ${card.id} --merge hydra to change the default`,
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
    mergeNotices({ status })
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
      inform({
        task: card.id,
        reason: evidence.problems.join('; '),
        clear: `Use pnyx-axi task refresh-links ${card.id} to refresh merge evidence`,
      })
    }

    attempt = {
      outcome: 'unknown',
      head: evidence.head,
      requestedAt: meta.at,
      detail: 'merge requested; awaiting GitHub confirmation',
    }
    const claimed = await withWriter({
      hydraId,
      fn: ({ writer }) => {
        const currentCard = writer.state.cards[card.id]
        const current = currentCard?.links.find(current => current.url === link.url)

        if (currentCard && !owner && taskLanding({
          state: writer.state,
          card: currentCard,
        })?.merge !== 'hydra'
          && !mergeApproval({
            state: writer.state,
            card: currentCard,
            url: link.url,
          })) {
          inform({
            task: card.id,
            reason: 'Merge approval changed before the merge attempt',
            clear: `Use pnyx-axi task landing ${card.id} --merge owner to change the default`,
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
          const rejectedMeta = {
            ...meta,
            id: meta.id ? `${meta.id}:rejected` : undefined,
          }
          await commit({
            hydraId,
            meta: rejectedMeta,
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
                meta: rejectedMeta,
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
  const receipt = await commit({
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
    await refreshConfirmedProject({
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

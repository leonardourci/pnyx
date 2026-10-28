import { refreshTarget } from '../../projects/refresh-confirmed.ts'
import { confirmedMerge } from './confirmed.ts'
import { mergeObservation } from './merge-observation.ts'
import { sendReply } from '../../workers/reply.ts'
import { decideLink } from './links.ts'
import { HYDRA_CARD } from '../../core/hydra.ts'
import type { HydraState } from '../../app/model.ts'
import type { Card } from '../model.ts'
import { failedChecks, type Link } from './model.ts'
import { liveTask } from '../select.ts'
import { pullRequestRef, pullRequestStatus, type PullRequestStatus } from '../../integrations/github/pull-request.ts'
import { pullRequestMergeOutcome, type MergeOutcome } from '../../integrations/github/merge-evidence.ts'
import { drainSpool } from '../../integrations/hooks/ingest.ts'
import { loadHydra } from '../../app/store.ts'
import { withWriter } from '../../app/writer.ts'

// GitHub changes on human time; once a minute keeps a few followed pull requests well inside gh's rate limit.
export const FOLLOW_POLL_MS = 60_000

// Every open pull request linked to a live task, until it merges or closes.
export function followedLinks({ state }: { state: HydraState }): {
  card: Card
  link: Link
}[] {
  if (state.config?.hydra.kind === 'firstmate') {
    return []
  }

  return Object.values(state.cards)
    .filter(card => card.id !== HYDRA_CARD && liveTask({ card }))
    .flatMap(card => card.links
      .filter(link => link.kind === 'github_pr' && link.state !== 'merged' && link.state !== 'closed')
      .map(link => ({
        card,
        link,
      })))
}

export function needsPullRequestFollow({ state }: { state: HydraState }): boolean {
  if (state.config?.hydra.kind === 'firstmate') {
    return false
  }

  if (followedLinks({ state }).length > 0) {
    return true
  }

  return Object.values(state.cards).some(card => {
    if (card.links.some(link => refreshTarget({
      state,
      card,
      link,
    }))) {
      return true
    }

    if (!liveTask({ card }) || card.status?.state === 'done') {
      return false
    }

    const links = card.links.filter(link => link.kind === 'github_pr' && link.state !== 'closed')

    return links.length > 0 && links.every(link => link.state === 'merged')
      && links.some(link => link.mergeProof)
  })
}

// What the task's own worker should hear about this change, if anything. Comments count from the first read, which only sets their baseline.
export function workerNews({
  card,
  link,
  status,
}: {
  card: Card
  link: Link
  status: PullRequestStatus
}): string | undefined {
  if (status.state !== 'open') {
    return undefined
  }

  const pr = pullRequestRef({ url: link.url })
  const repo = pr ? ` --repo ${pr.repo}` : ''
  const number = pr ? pr.number : link.url
  const news: string[] = []

  if (status.checks.failed > failedChecks({ checks: link.checks })) {
    news.push(`Checks failed on ${link.url}: ${status.checks.summary}. Read them with \`gh-axi pr checks ${number}${repo}\`, fix them on your branch and push. If you cannot fix them, declare blocked with what you found.`)
  }

  if (link.comments !== undefined && status.comments > link.comments) {
    const count = status.comments - link.comments
    news.push(`${count} new review ${count === 1 ? 'comment' : 'comments'} on ${link.url}. Read them with \`gh-axi pr view ${number}${repo} --comments --reviews\`, address each one on your branch and push. Do not reply on the pull request: your replies would come back to you as new comments. Declare needs_you only for a comment that asks for something outside this task.`)
  }

  const finished = link.checks !== undefined && link.checks !== status.checks.summary
    && status.checks.pending === 0 && status.checks.failed === 0

  if (finished && card.status?.state === 'paused') {
    news.push(`Checks finished on ${link.url}: ${status.checks.summary}.`)
  }

  return news.length ? news.join('\n\n') : undefined
}

async function tellWorker({
  hydraId,
  card,
  text,
  id,
}: {
  hydraId: string
  card: Card
  text: string
  id: string
}): Promise<void> {
  const session = card.sessionIds?.[0]

  if (!session) {
    return
  }

  try {
    await sendReply({
      hydraId,
      request: {
        card: card.id,
        expectedSession: session,
        text,
        actor: 'pnyx',
        id,
        homes: [],
      },
    })
  } catch (error) {
    // A worker that cannot take it leaves the change on the card, where Hydra reads it.
    console.error(`pnyx-axi follow: ${(error as Error).message}`)
  }
}

// Reads each followed pull request once; a change is recorded on its link, and failed checks or new review comments go to the task's worker.
export async function followPullRequests({
  hydraId,
  readStatus = pullRequestStatus,
  tell = tellWorker,
  active = () => true,
  readOutcome = pullRequestMergeOutcome,
}: {
  hydraId: string
  readStatus?: typeof pullRequestStatus
  tell?: typeof tellWorker
  active?(): boolean
  readOutcome?: typeof pullRequestMergeOutcome
}): Promise<void> {
  const state = loadHydra({ hydraId }).state

  if (!active() || state.config?.hydra.kind === 'firstmate') {
    return
  }

  for (const card of Object.values(state.cards)) {
    if (!active()) {
      return
    }

    for (const link of card.links) {
      if (link.state !== 'merged' || !link.mergeProof) {
        continue
      }

      const pendingRefresh = refreshTarget({
        state,
        card,
        link,
      })

      if (!pendingRefresh && (card.status?.state === 'done' || !liveTask({ card }))) {
        continue
      }

      await confirmedMerge({
        hydraId,
        cardId: card.id,
        url: link.url,
        proof: link.mergeProof,
      })
    }
  }

  for (const {
    card,
    link,
  } of followedLinks({ state: loadHydra({ hydraId }).state })) {
    if (!active()) {
      return
    }

    let status: PullRequestStatus | undefined

    try {
      status = await readStatus({ url: link.url })
    } catch (error) {
      console.error(`pnyx-axi follow: ${(error as Error).message}`)
      continue
    }

    if (!status) {
      continue
    }

    if (!active()) {
      return
    }

    let outcome: MergeOutcome | undefined

    if (status.state === 'merged' || link.mergeAttempt) {
      outcome = await readOutcome({ url: link.url })
    }

    if (!active()) {
      return
    }

    let observedState = status.state

    if (outcome?.outcome === 'merged') {
      observedState = 'merged'
    } else if (status.state === 'merged') {
      observedState = link.state ?? 'open'
    }

    const sameOutcome = !link.mergeAttempt || (link.mergeAttempt.outcome === outcome?.outcome
      && (outcome?.outcome === 'merged' || link.mergeAttempt.detail === outcome?.detail))
    const known = link.state === observedState && link.checks === status.checks.summary
      && link.comments === status.comments && link.draft === status.draft
      && sameOutcome

    if (known) {
      continue
    }

    const at = new Date().toISOString()
    const recorded = withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const latest = writer.state.cards[card.id]
        const current = latest?.links.find(l => l.url === link.url)
        const settled = current?.state === 'merged' || current?.state === 'closed'

        if (!latest || !current || settled) {
          return undefined
        }

        let observedLink: Link = {
          ...current,
          state: observedState,
          checks: status.checks.summary,
          comments: status.comments,
          draft: status.draft,
          checkedAt: at,
        }

        if (outcome) {
          observedLink = mergeObservation({
            link: observedLink,
            outcome,
            at,
          })
        }

        const decision = decideLink({
          state: writer.state,
          ref: card.id,
          url: link.url,
          link: observedLink,
          meta: {
            actor: 'pnyx',
            at,
          },
        })

        if (!('event' in decision)) {
          return undefined
        }

        writer.append({ event: decision.event })

        return {
          card: latest,
          link: current,
          event: decision.event.id,
        }
      },
    })

    if (!recorded) {
      continue
    }

    if (outcome?.outcome === 'merged') {
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

    const news = workerNews({
      card: recorded.card,
      link: recorded.link,
      status,
    })

    if (news) {
      await tell({
        hydraId,
        card: recorded.card,
        text: news,
        id: `follow:${recorded.event}`,
      })
    }
  }
}

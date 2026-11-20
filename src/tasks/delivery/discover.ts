import { decode } from '@toon-format/toon'
import { git } from '#projects/git.ts'
import { githubRepository } from './proof.ts'
import { runProcess } from '#app/run-process.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { liveTask } from '#tasks/select.ts'
import { decideLink, parseLink } from './links.ts'
import { applyDecision } from '#app/decision.ts'
import { workingTask, IDLE_FOLLOW_MULTIPLIER } from './follow-schedule.ts'
import type { HydraState } from '#app/model.ts'
import { log } from '#app/diagnostics.ts'

const DISCOVERY_TIMEOUT_MS = 30_000
const DISCOVERY_LIMIT = 100

export function discoverableTasks({ state }: { state: HydraState }) {
  if (state.config?.hydra.kind === 'firstmate') {
    return []
  }

  return Object.values(state.cards).filter(card => liveTask({ card }) && !card.doneAt
    && Boolean(card.copy?.state === 'active' || card.agent || card.launch || card.branches?.length))
}

export async function discoverPullRequests({
  hydraId,
  interval,
  checked,
  active,
}: {
  hydraId: string
  interval: number
  checked: Map<string, number>
  active(): boolean
}): Promise<void> {
  const state = loadHydra({ hydraId }).state

  for (const card of discoverableTasks({ state })) {
    const delay = workingTask({ card }) ? interval : interval * IDLE_FOLLOW_MULTIPLIER
    const previous = checked.get(card.id)

    if (!active()) {
      return
    }

    if (previous !== undefined && Date.now() - previous < delay) {
      continue
    }

    checked.set(
      card.id,
      Date.now(),
    )
    const copy = card.copy?.state === 'active' ? { ...card.copy } : undefined
    const cwd = copy?.path ?? card.agent?.cwd ?? (card.launch ? card.folder : undefined)
    const branches = [...card.branches ?? []]

    if (cwd) {
      const origin = await git({
        cwd,
        args: [
          'config',
          '--get',
          'remote.origin.url',
        ],
      })
      let repository = githubRepository({ url: origin.out })

      if (!repository && copy?.project) {
        const projectOrigin = await git({
          cwd: copy.project,
          args: [
            'config',
            '--get',
            'remote.origin.url',
          ],
        })
        repository = githubRepository({ url: projectOrigin.out })
      }

      const head = await git({
        cwd,
        args: [
          'symbolic-ref',
          '--quiet',
          '--short',
          'HEAD',
        ],
      })
      const observedBranches = new Set([
        copy?.branch,
        head.ok ? head.out : undefined,
      ])

      for (const branch of observedBranches) {
        const recorded = branches.some(known => known.repository === repository
          && known.branch === branch)

        if (!repository || !branch || recorded) {
          continue
        }

        const found = {
          repository,
          branch,
        }
        branches.push(found)

        if (!active()) {
          return
        }

        withWriter({
          hydraId,
          fn: ({ writer }) => {
            const current = writer.state.cards[card.id]

            if (!current || !liveTask({ card: current }) || current.doneAt) {
              return
            }

            writer.append({
              event: {
                v: 1,
                id: `branch:${card.id}:${repository}:${branch}`,
                seq: writer.state.seq + 1,
                at: new Date().toISOString(),
                actor: 'pnyx',
                cardId: card.id,
                type: 'task.branch',
                data: found,
              },
            })
          },
        })
      }
    }

    for (const {
      repository,
      branch,
    } of branches) {
      const result = await runProcess({
        command: process.env.PNYX_GH_AXI || 'gh-axi',
        args: [
          'pr',
          'list',
          '--repo',
          repository,
          '--head',
          branch,
          '--state',
          'all',
          '--fields',
          'url',
          '--limit',
          String(DISCOVERY_LIMIT),
        ],
        timeout: DISCOVERY_TIMEOUT_MS,
      })

      if (!active()) {
        return
      }

      if (result.status !== 0) {
        log({
          level: 'warn',
          operation: 'follow.discover',
          hydraId,
          taskId: card.id,
          error: result.stderr || result.stdout,
        })
        continue
      }

      const output = decode(result.stdout) as { pull_requests?: { url: string }[] }

      for (const request of output.pull_requests ?? []) {
        withWriter({
          hydraId,
          fn: ({ writer }) => {
            const current = writer.state.cards[card.id]

            if (!current || !liveTask({ card: current }) || current.doneAt
              || current.links.some(link => link.url === request.url)) {
              return
            }

            applyDecision({
              writer,
              decision: decideLink({
                state: writer.state,
                ref: card.id,
                url: request.url,
                link: {
                  ...parseLink({ input: { url: request.url } }),
                  src: 'branch',
                },
                meta: {
                  at: new Date().toISOString(),
                  actor: 'pnyx',
                },
              }),
            })
          },
        })
      }
    }
  }
}

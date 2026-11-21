import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { git } from '#projects/git.ts'
import { githubRepository } from './proof.ts'
import { githubApi } from '#integrations/github/pull-request.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { liveTask } from '#tasks/select.ts'
import { decideLink, parseLink } from './links.ts'
import { applyDecision } from '#app/decision.ts'
import { workingTask, IDLE_FOLLOW_MULTIPLIER } from './follow-schedule.ts'
import type { HydraState } from '#app/model.ts'
import { log } from '#app/diagnostics.ts'

const DISCOVERY_LIMIT = 100

function discoveryFolder({ card }: { card: import('#tasks/model.ts').Card }): string | undefined {
  if (card.copy?.state === 'active') {
    return card.copy.path
  }

  const folder = card.agent?.cwd ?? (card.launch ? card.folder : undefined)

  if (!folder || !card.copy) {
    return folder
  }

  const canonical = ({ path }: { path: string }) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }

  return canonical({ path: folder }) === canonical({ path: card.copy.path }) ? undefined : folder
}

export function discoverableTasks({ state }: { state: HydraState }) {
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
    const cwd = discoveryFolder({ card })
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

        if (!active()) {
          return
        }

        const kept = withWriter({
          hydraId,
          fn: ({ writer }) => {
            const current = writer.state.cards[card.id]

            if (!current || !liveTask({ card: current }) || current.doneAt) {
              return false
            }

            if (copy && (current.copy?.state !== 'active' || current.copy.path !== copy.path
              || current.copy.branch !== copy.branch)) {
              return false
            }

            if (!copy && discoveryFolder({ card: current }) !== cwd) {
              return false
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

            return true
          },
        })

        if (kept) {
          branches.push(found)
        }
      }
    }

    for (const {
      repository,
      branch,
    } of branches) {
      if (!active()) {
        return
      }

      let requests: ReturnType<typeof parseLink>[]

      try {
        const [
          owner,
          repo,
        ] = repository.split('/')
        const response = await githubApi({
          args: [
            'graphql',
            '-f',
            `query=query($owner:String!,$repo:String!,$branch:String!){repository(owner:$owner,name:$repo){pullRequests(first:${DISCOVERY_LIMIT},headRefName:$branch,states:[OPEN,CLOSED,MERGED]){nodes{url}}}}`,
            '-f',
            `owner=${owner}`,
            '-f',
            `repo=${repo}`,
            '-f',
            `branch=${branch}`,
          ],
        }) as { data?: { repository?: { pullRequests?: { nodes?: unknown } } } }
        const output = response?.data?.repository?.pullRequests?.nodes

        if (!Array.isArray(output)) {
          throw new Error('Expected a pull request list')
        }

        requests = output.map(request => {
          if (!request || typeof request !== 'object' || !('url' in request)
            || typeof request.url !== 'string') {
            throw new Error('Expected a pull request URL')
          }

          const link = parseLink({ input: { url: request.url } })

          if (link.kind !== 'github_pr') {
            throw new Error('Expected a GitHub pull request URL')
          }

          return link
        })
      } catch (error) {
        log({
          level: 'warn',
          operation: 'follow.discover',
          hydraId,
          taskId: card.id,
          error,
        })
        continue
      }

      if (!active()) {
        return
      }

      for (const request of requests) {
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
                  ...request,
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

import { workerQueue } from '#workers/queue.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HydraError } from '#store/errors.ts'
import type { TaskCopy } from './model.ts'
import type { Card } from '#tasks/model.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { checkCopy, removeCopy, type CopyCheck } from './copy-check.ts'
import { pushFolder } from './copy-create.ts'
import { staysInPool, trimPool } from './copy-pool.ts'

const quiet = ({ meta }: { meta: Meta }): Meta => ({
  ...meta,
  id: undefined,
  ifRevision: undefined,
})

function releaseReason({
  copy,
  pooled,
  why,
}: {
  copy: TaskCopy
  pooled: boolean
  why: string
}): string {
  if (copy.via === 'command') {
    return `${why}; the folder stays for the project's copy tool`
  }

  return pooled ? `${why}; its folder went back to the pool` : why
}

export type Settle = 'check' | 'safe' | 'discard'

// Only the owner discards work that never landed; anything else unsafe is flagged for Hydra.
export async function settleCopy({
  hydraId,
  ref,
  mode = 'check',
  meta,
}: {
  hydraId: string
  ref: string
  mode?: Settle
  meta: Meta
}): Promise<{
  copy: TaskCopy | null
  check?: CopyCheck
}> {
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref,
  })
  const copy = card.copy

  if (!copy || copy.state === 'removed') {
    return { copy: copy ?? null }
  }

  const check = await checkCopy({
    card,
    copy,
  })

  if (mode === 'safe' && copy.via === 'worktree' && (!check.clean || !check.landed)) {
    throw new HydraError({
      message: `the copy of ${card.id} has uncommitted changes or unproved work, so it is not safe to remove`,
      code: 'CONFLICT',
      help: ['Land the current work first; discarding it needs the owner'],
    })
  }

  let after: TaskCopy
  let pooled = false

  if (check.gone) {
    after = {
      ...copy,
      state: 'removed',
      reason: 'its folder was already gone',
    }
  } else if (mode === 'discard' || mode === 'safe' || !('reason' in check)) {
    const why = mode === 'discard' ? 'discarded with the owner’s confirmation' : mode === 'safe' ? 'confirmed safe' : 'its work landed'
    pooled = mode !== 'discard' && copy.via === 'worktree' && await staysInPool({
      hydraId,
      state,
      copy,
    })
    // The project's copy tool owns the folders it makes, so Pnyx only lets them go.
    const failed = copy.via === 'command' || pooled ? undefined : await removeCopy({
      copy,
      force: mode === 'discard',
    })
    after = failed
      ? {
        ...copy,
        state: 'flagged',
        reason: failed,
      }
      : {
        ...copy,
        state: 'removed',
        reason: releaseReason({
          copy,
          pooled,
          why,
        }),
      }
  } else {
    after = {
      ...copy,
      state: 'flagged',
      reason: check.reason,
    }
  }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const now = findCard({
        state: writer.state,
        ref: card.id,
      })

      if (now.copy?.path !== copy.path || now.copy.state === 'removed'
        || (now.copy.state === after.state && now.copy.reason === after.reason)) {
        return {
          copy: now.copy ?? null,
          check,
        }
      }

      applyDecision({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            ifRevision: undefined,
          },
          cardId: now.id,
          change: {
            type: 'task.copy',
            data: {
              before: now.copy,
              after,
            },
          },
        }),
      })

      // A hook session in a pooled slot must not find this task by its old folder.
      if (pooled && now.folder === copy.path) {
        pushFolder({
          writer,
          card: now,
          folder: null,
          meta: quiet({ meta }),
        })
      }

      if (after.state === 'flagged') {
        const text = `The copy of task ${now.id} "${now.title}" at ${copy.path} was kept: ${after.reason}. `
          + `Prove its current work landed, then run \`pnyx-axi task copy ${now.id} remove --hydra ${hydraId}\`. `
          + `Discarding work that never landed needs the owner: \`pnyx-axi task copy ${now.id} remove --discard --hydra ${hydraId}\`.`
        applyDecision({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta: quiet({ meta }),
            cardId: now.id,
            change: {
              type: 'hydra.message',
              data: {
                task: now.id,
                action: 'send',
                text,
                hydra: hydraConfig({
                  state: writer.state,
                  id: hydraId,
                }).hydra.id,
              },
            },
          }),
        })
      }

      return {
        copy: after,
        check,
      }
    },
  })
}

// A task in Done whose agent is still working keeps its copy until the agent stops.
// An investigation keeps its copy, so the worker that becomes its build resumes in the same folder.
export const settles = ({ card }: { card: Card }) => Boolean(card.doneAt) && card.copy?.state === 'active'
  && card.activity !== 'working' && card.kind !== 'investigation'

export async function settleDone({
  hydraId,
  at = new Date().toISOString(),
}: {
  hydraId: string
  at?: string
}): Promise<number> {
  const state = loadHydra({ hydraId }).state

  if (state.config?.hydra.kind === 'firstmate') {
    return 0
  }

  const due = Object.values(state.cards).filter(card => settles({ card })
    && !workerQueue({
      state,
      session: card.sessionIds?.[0] ?? '',
    }).length)

  for (const card of due) {
    await settleCopy({
      hydraId,
      ref: card.id,
      meta: {
        actor: 'pnyx',
        at,
      },
    })
  }

  await trimPool({ hydraId })

  return due.length
}

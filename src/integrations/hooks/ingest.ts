import { readFileSync, renameSync, rmSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { decideLink, decideOutcome, decidePush, decideSession, joinedKey, parseLink } from '../../core/decide.ts'
import { type Decision } from '../../app/model.ts'
import { type Meta } from '../../app/command-meta.ts'
import { hydraEvent, HYDRA_CARD } from '../../core/hydra.ts'
import { type AgentRef } from '../../core/model.ts'
import { HydraError } from '../../store/errors.ts'
import { terminalFacts } from '../../core/route.ts'
import { cardSessionId, sessionId } from '../../core/tasks.ts'
import { spoolFiles } from '../../store/storage.ts'
import { withWriter, type Writer } from '../../app/writer.ts'
import { canonical } from '../../store/paths.ts'
import { harvestTranscripts } from './harvest.ts'
import { observedSettings, type FoundSettings } from './settings.ts'
import { HARNESSES, TERMINAL_EVENTS, attend, isHookEnvelope, observe, type HookEnvelope } from './observe.ts'

const HARVEST_AFTER = [
  'Stop',
  'SubagentStop',
  'PostCompact',
  'SessionEnd',
]
const HOOKS = 'hooks'

function ingest({
  writer,
  entry,
}: {
  writer: Writer
  entry: Record<string, unknown>
}): string[] {
  if (typeof entry?.id !== 'string' || typeof entry.at !== 'string') {
    throw new HydraError({
      message: 'spool entry needs id and at',
      code: 'VALIDATION_ERROR',
    })
  }

  const apply = ({ decision }: { decision: Decision }) => {
    if ('event' in decision) {
      writer.append({ event: decision.event })
    }
  }

  if (!isHookEnvelope({ value: entry })) {
    if (typeof entry.key !== 'string') {
      throw new HydraError({
        message: 'spool entry needs id, key and at',
        code: 'VALIDATION_ERROR',
      })
    }

    const actor = typeof entry.actor === 'string' ? entry.actor : 'hook'
    const card = (entry.card ?? {}) as Record<string, unknown>
    const source = card.source ?? {
      adapter: actor,
      objectId: entry.key,
      observedAt: entry.at,
    }
    apply({
      decision: decidePush(
        {
          state: writer.state,
          key: entry.key,
          input: {
            ...card,
            source,
          },
          meta: {
            id: entry.id,
            at: entry.at,
            actor,
          },
        },
      ),
    })

    return []
  }

  if (!(HARNESSES as readonly string[]).includes(entry.harness as string) || typeof entry.event !== 'string') {
    throw new HydraError({
      message: 'hook entry needs a known harness and an event',
      code: 'VALIDATION_ERROR',
    })
  }

  const harvest: string[] = []
  const folder = canonical({ path: (entry.payload as { cwd?: unknown } | null)?.cwd })
  const terminal = terminalFacts({ value: entry.terminal })
  const probed = TERMINAL_EVENTS.includes(entry.event)
  // A session (never a subagent, whose key has a /) started in a folder a source
  // assigned, such as a Firstmate task's worktree, reports to that card.
  const task = typeof entry.task === 'string' ? entry.task : undefined
  const resolve = ({ key }: { key: string }) => (key.includes('/') ? key : joinedKey({
    state: writer.state,
    key,
    folder,
    terminal,
    probed,
    task,
  }))

  for (const o of observe({ envelope: entry as unknown as HookEnvelope })) {
    // A hosted session's process closes whenever the server stops; the session itself
    // goes on with the next message, so it never ends.
    if (entry.event === 'SessionEnd' && o.card.agent
      && writer.state.sessions?.[sessionId({ agent: o.card.agent as AgentRef })]?.agent.host === 'pnyx') {
      continue
    }

    const key = resolve({ key: o.key })

    if (o.ifMissing && key in writer.state.keys) {
      continue
    }

    let card = typeof o.card.parent === 'string' ? {
      ...o.card,
      parent: resolve({ key: o.card.parent }),
    } : o.card
    const session = o.card.agent
      ? writer.state.sessions?.[sessionId({ agent: o.card.agent as AgentRef })] : undefined

    if (session && session.agent.host === 'pnyx') {
      card = {
        ...card,
        settings: observedSettings({
          agent: session.agent,
          held: session.settings,
          observed: card.settings as FoundSettings | undefined,
        }),
      }
    }

    const m: Meta = {
      id: o.id ? `${entry.id}:${o.id}` : entry.id,
      at: entry.at,
      actor: `hook:${entry.harness}`,
    }
    const current = writer.state.cards[writer.state.keys[key] ?? '']?.attention ?? []
    const attention = o.attend && attend({
      current,
      change: o.attend,
    })

    if (o.ifChanged && key in writer.state.keys && isDeepStrictEqual(
      attention,
      current,
    )) {
      continue
    }

    let pushed = decidePush({
      state: writer.state,
      key,
      input: attention ? {
        ...card,
        attention,
      } : card,
      meta: m,
    })

    if ('event' in pushed && o.card.agent) {
      const existing = Object.values(writer.state.sessions ?? {}).find(s => s.sourceRefs.some(r =>
        r.adapter === 'hooks' && `${r.instanceId}:${r.objectId}` === o.key))
      const previous = existing?.taskId ? writer.state.cards[existing.taskId] : undefined
      const target = writer.state.cards[writer.state.keys[key] ?? '']
      const replaced = target?.sessionIds?.[0]
      const moving = previous && previous.key !== key
        && previous.sourceRefs.some(r => r.adapter === 'firstmate')
      const incoming = sessionId({ agent: o.card.agent as AgentRef })
      const replacing = key !== o.key && replaced && replaced !== incoming

      if (moving || replacing) {
        const ref = moving ? existing!.id : replaced!
        harvestTranscripts({
          writer,
          cardIds: [(moving ? previous : target)!.id],
          at: m.at,
        })
        apply({
          decision: decideSession({
            state: writer.state,
            ref,
            task: null,
            meta: {
              ...m,
              id: `${m.id}:detach:${ref}`,
            },
          }),
        })
        pushed = decidePush({
          state: writer.state,
          key,
          input: attention ? {
            ...card,
            attention,
          } : card,
          meta: m,
        })
      }
    }

    apply({ decision: pushed })
    // Hooks own only the outcome they recorded on the session's own card: a joined
    // Firstmate task, or a Firstmate or manual outcome, keeps its own rule.
    const target = writer.state.cards[writer.state.keys[key] ?? '']
    const stale = 'skipped' in pushed && pushed.skipped === 'stale'
    const owned = !target?.sourceRefs.some(r => r.adapter === 'firstmate')
      && (!target?.outcome || target.outcome.source === HOOKS)

    if (o.outcome !== undefined && target && !stale && owned) {
      const outcome = o.outcome && { state: o.outcome }
      apply({
        decision: decideOutcome({
          state: writer.state,
          ref: key,
          outcome,
          meta: {
            ...m,
            id: `${m.id}:outcome`,
          },
          source: HOOKS,
        }),
      })
    }

    if (o.link) {
      apply({
        decision: decideLink({
          state: writer.state,
          ref: key,
          url: o.link,
          link: parseLink({ input: { url: o.link } }),
          meta: {
            ...m,
            id: `${m.id}:link`,
          },
        }),
      })
    }

    if (!o.ifMissing && !o.ifChanged && HARVEST_AFTER.includes(entry.event)
      && key in writer.state.keys) {
      harvest.push(writer.state.keys[key]!)
    }

    const config = writer.state.config

    if (task === HYDRA_CARD && o.card.agent && config && !config.hydra.session) {
      const session = sessionId({ agent: o.card.agent as AgentRef })

      const recorded = writer.state.sessions?.[session]

      if (recorded && (!recorded.taskId || writer.state.cards[recorded.taskId]?.automaticTask)) {
        apply({
          decision: hydraEvent({
            state: writer.state,
            meta: {
              ...m,
              id: `${m.id}:hydra`,
            },
            cardId: '$board',
            change: {
              type: 'board.configured',
              data: {
                ...config,
                hydra: {
                  ...config.hydra,
                  session,
                },
              },
            },
          }),
        })
      }
    }
  }

  return harvest
}

export function drainSpool({ writer }: {
  writer: Writer
}): {
  ingested: number
  rejected: number
  notes?: number
} {
  let ingested = 0
  let rejected = 0
  const harvest = new Set<string>()

  for (const file of spoolFiles({ dir: writer.dir })) {
    try {
      for (const id of ingest({
        writer,
        entry: JSON.parse(readFileSync(
          file,
          'utf8',
        )) as Record<string, unknown>,
      })) {
        harvest.add(id)
      }
    } catch (error) {
      if (!(error instanceof HydraError || error instanceof SyntaxError)) {
        throw error
      }

      renameSync(
        file,
        `${file}.rejected`,
      )
      rejected += 1
      continue
    }

    rmSync(file)
    ingested += 1
  }

  const hydra = writer.state.config?.hydra.session

  const turned = [...harvest].flatMap(id => writer.state.cards[id] ?? [])

  if (hydra && turned.some(card => cardSessionId({ card }) === hydra)) {
    harvest.add(HYDRA_CARD)
  }

  const notes = harvest.size ? harvestTranscripts({
    writer,
    cardIds: harvest,
    at: new Date().toISOString(),
  }) : 0

  return {
    ingested,
    rejected,
    ...(notes ? { notes } : {}),
  }
}

export function ingestSpool({ hydraId }: {
  hydraId: string
}): {
  ingested: number
  rejected: number
  notes?: number
} {
  return withWriter({
    hydraId,
    fn: ({ writer }) => drainSpool({ writer }),
  })
}

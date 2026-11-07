import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Catalog } from '#hydra/transcripts-catalog.ts'
import type { createCatalogIndex } from '#hydra/transcripts-catalog-index.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { findCard } from '#tasks/push-rules.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { DEFAULT_HARNESS, HARNESSES } from '#workers/providers.ts'
import type { createHost } from '#app/host.ts'
import type { HydraState } from '#app/model.ts'
import type { HydraClient } from '#app/server-transport.ts'
import type { CommandRequest } from './dispatch.ts'

// The skills and commands the composer offers: the `catalog` command, one read in flight per tab, and its warm-up.
export function createCatalog({
  dir,
  state,
  catalogIndex,
  agents,
}: {
  dir: string
  state(): HydraState
  catalogIndex: ReturnType<typeof createCatalogIndex>
  agents: ReturnType<typeof createHost>
}) {
  const catalogCard = ({
    card,
    provider,
  }: {
    card: Card
    provider?: string
  }): Card => {
    if (card.id !== HYDRA_CARD) {
      return card
    }

    const cwd = card.agent?.cwd ?? join(
      dir,
      'agent',
    )

    if (!card.agent?.cwd) {
      mkdirSync(
        cwd,
        { recursive: true },
      )
    }

    return {
      ...card,
      agent: {
        ...card.agent,
        sessionId: card.agent?.sessionId ?? '',
        cwd,
        provider: provider ?? card.agent?.provider ?? DEFAULT_HARNESS,
      },
    }
  }

  const warmCatalog = async () => {
    const card = state().cards[HYDRA_CARD]

    if (!card) {
      return
    }

    await Promise.all(HARNESSES.map(provider => catalogIndex.read({
      card: catalogCard({
        card,
        provider,
      }),
      projects: state().projects,
    })))
  }

  const catalogReads = new WeakMap<HydraClient, {
    scope: string
    read: Promise<Catalog>
  }>()

  const catalogCommand = ({
    ws,
    id,
    args,
    fail,
    send,
  }: CommandRequest) => {
    if (args.length !== 1) {
      throw new HydraError({
        message: 'catalog expects a card',
        code: 'VALIDATION_ERROR',
      })
    }

    const card = findCard({
      state: state(),
      ref: args[0],
    })
    const config = hydraConfig({ state: state() })
    const effective = effectiveDispatch()
    const receiving = card.id === HYDRA_CARD
      ? config.hydra.agent?.harness
        ?? effective.dispatch.rules.hydra?.candidates[0]?.harness
        ?? effective.dispatch.default[0]?.harness
      : card.agent?.provider
    const currentCard = catalogCard({
      card,
      provider: receiving,
    })
    const scope = JSON.stringify([
      card.id,
      receiving,
      state().projectsRevision,
    ])
    let entry = catalogReads.get(ws)

    if (entry?.scope !== scope) {
      const previous = entry?.read.catch(() => undefined)
      const next = {
        scope,
        read: Promise.resolve(previous).then(async () => {
          const native = await agents.catalogCommands({
            card,
            provider: receiving,
          })
          const catalog = await catalogIndex.read({
            card: currentCard,
            projects: state().projects,
          })

          return {
            ...catalog,
            suggestions: [
              ...catalog.suggestions,
              ...native,
            ],
            provider: receiving,
          }
        }),
      }
      catalogReads.set(
        ws,
        entry = next,
      )
      void next.read.catch(() => undefined).finally(() => {
        if (catalogReads.get(ws) === next) {
          catalogReads.delete(ws)
        }
      })
    }

    void entry.read.then(catalog => send({
      ws,
      message: {
        type: 'receipt',
        id,
        catalog,
      },
    })).catch(() => fail({
      error: 'Local catalog unavailable',
      code: 'CATALOG_UNAVAILABLE',
    }))
  }

  return {
    warmCatalog,
    catalogReads,
    catalogCommand,
  }
}

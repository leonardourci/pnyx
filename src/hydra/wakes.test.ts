import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HydraChange } from '#app/model.ts'
import { applyDecision } from '#app/decision.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { decidePush } from '#tasks/push.ts'
import type { AgentRef } from '#workers/model.ts'
import { hydraConfig } from './config.ts'
import { hydraEvent } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'
import { findHydraTurnToResume } from './wakes.ts'

const AT = '2026-11-13T12:00:00.000Z'
const SESSION_KEY = 'claude-code:hydra-session'
const AGENT: AgentRef = {
  provider: 'claude-code',
  sessionId: 'hydra-session',
  cwd: '/work/hydra',
  host: 'pnyx',
}

const turnState = ({
  writer,
  activity,
}: {
  writer: Writer
  activity: 'working' | 'finished'
}) => applyDecision({
  writer,
  decision: decidePush({
    state: writer.state,
    key: SESSION_KEY,
    input: {
      agent: AGENT,
      title: 'Hydra',
      activity,
      source: {
        adapter: 'pnyx',
        objectId: AGENT.sessionId,
        observedAt: AT,
      },
    },
    meta: {
      at: AT,
      actor: 'pnyx',
    },
  }),
})

const hydraChange = ({
  writer,
  id,
  actor,
  change,
}: {
  writer: Writer
  id: string
  actor: string
  change: Pick<HydraChange, 'type' | 'data'>
}) => applyDecision({
  writer,
  decision: hydraEvent({
    state: writer.state,
    meta: {
      id,
      at: AT,
      actor,
    },
    cardId: HYDRA_CARD,
    change,
  }),
})

const ownerMessage = ({
  writer,
  id,
  text,
}: {
  writer: Writer
  id: string
  text: string
}) => hydraChange({
  writer,
  id,
  actor: 'web',
  change: {
    type: 'hydra.message',
    data: {
      hydra: 'default',
      action: 'send',
      text,
    },
  },
})

test(
  'a restart that cuts a turn delivered with hydra.delivered resumes that turn, not the earlier configured one',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-wakes-',
    ))
    withWriter({
      hydraId: 'default',
      create: true,
      fn: ({ writer }) => {
        turnState({
          writer,
          activity: 'working',
        })
        ownerMessage({
          writer,
          id: 'first',
          text: 'Plan the release',
        })
        const config = hydraConfig({ state: writer.state })
        hydraChange({
          writer,
          id: 'first:hosted',
          actor: 'pnyx',
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra: {
                ...config.hydra,
                session: SESSION_KEY,
              },
            },
          },
        })
        turnState({
          writer,
          activity: 'finished',
        })
        ownerMessage({
          writer,
          id: 'second',
          text: 'Ship it',
        })
        turnState({
          writer,
          activity: 'working',
        })
        // The second turn runs in the session already configured, so only a delivery marks it.
        hydraChange({
          writer,
          id: 'second:hosted',
          actor: 'pnyx',
          change: {
            type: 'hydra.delivered',
            data: { session: SESSION_KEY },
          },
        })
      },
    })
    const cut = findHydraTurnToResume({
      hydraId: 'default',
      state: loadHydra({ hydraId: 'default' }).state,
      agent: AGENT,
    })

    assert.equal(
      cut?.resumeAttemptId,
      'resume:7',
    )
    assert.equal(
      cut?.wakeThrough,
      0,
    )
    // The cut turn is the one delivered at seq 5, so Hydra rereads from just before it.
    assert.match(
      cut!.resumeMessage,
      /pnyx-axi hydra messages --after 4 --hydra default/,
    )
  },
)

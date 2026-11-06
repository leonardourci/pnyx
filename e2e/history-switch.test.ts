import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { test } from 'node:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { skillSource } from '#setup/skills.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

const nativeStart = (): SDKMessage => ({
  type: 'system',
  subtype: 'status',
  status: 'compacting',
  uuid: randomUUID(),
  session_id: '',
})
const nativeDone = (): SDKMessage => ({
  type: 'system',
  subtype: 'status',
  status: null,
  compact_result: 'success',
  uuid: randomUUID(),
  session_id: '',
})
const inscription = ({ text }: { text: string }) => text.includes(skillSource({ name: 'inscribe' }))
const summary = ({ text }: { text: string }) => text.includes('pnyx-axi hydra history') && !inscription({ text })

test(
  'native compaction during a switch keeps each summary and boundary together and cannot finish a failed switch',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await page.command({
      name: 'hydra-agent',
      args: [
        JSON.stringify({
          harness: 'claude',
          model: 'sonnet',
        }),
      ],
    })
    const agent = await s.chat({ text: 'Original release discussion' })
    await until({
      what: 'the first turn to finish',
      check: () => s.answered({ cwd: agent.cwd }) === 1 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    await page.command({
      name: 'hydra-agent',
      args: [
        JSON.stringify({
          harness: 'claude',
          model: 'opus',
        }),
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Switch after saving memory',
        '--event-id',
        'switch-native',
      ],
    })
    const inscribe = pnyx.claude.plan({
      match: inscription,
      reply: 'Memory saved.',
      hold: true,
      before: [
        nativeStart(),
        nativeDone(),
      ],
    })
    const compact = pnyx.claude.plan({
      match: summary,
      reply: 'Switch handoff covers the pinned snapshot.',
      hold: true,
    })

    try {
      await page.command({
        name: 'hydra-agent-change',
        args: [
          'switch-native',
          'inscribe',
        ],
      })
      const pass = await until({
        what: 'inscribe and its native auto-compaction',
        check: () => {
          const state = s.state()
          const active = state.historyMilestones?.findLast(item => item.kind === 'inscribe' && item.state === 'started')

          return active && state.cards[HYDRA_CARD]?.compaction?.operations.some(operation => operation.trigger === 'auto' && operation.state === 'done') ? active : undefined
        },
      })
      assert.ok(pass.parent)
      const resumed = await page.command({
        name: 'hydra',
        args: [
          'inscribe',
          'start',
        ],
      })
      const readArgs = String(resumed.command).replace(
        ` --hydra ${s.hydraId}`,
        '',
      )
        .split(' ')
        .slice(1)
      const inscriber = await s.agent({ hydra: true })
      const pinnedHistory = await s.as({ agent: inscriber }).run({ args: readArgs })
      assert.match(
        pinnedHistory,
        /Original release discussion/,
      )

      const native = s.state().cards[HYDRA_CARD]!.compaction!.operations.at(-1)!
      assert.equal(
        s.state().historyMilestones?.find(item => item.id === pass.parent)?.state,
        'started',
      )
      await s.owner({
        args: [
          'hydra',
          'send',
          '--text',
          'Pending after the switch snapshot',
        ],
      })
      const transcriptPath = s.state().cards[HYDRA_CARD]?.agent?.transcriptPath
      assert.ok(transcriptPath)
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'user',
          isCompactSummary: true,
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          message: { content: 'Native context belongs only to the native operation.' },
        })}\n`,
      )
      await page.command({
        name: 'hydra',
        args: [
          'history',
          '--count',
        ],
      })
      await page.command({
        name: 'hydra',
        args: [
          'inscribe',
          'finish',
          '--key',
          pass.id,
          '--through',
          String(pass.through),
        ],
      })
      inscribe.release()
      await until({
        what: 'the separate summary session to read the pinned history',
        check: () => {
          const latest = pnyx.claude.sessions.findLast(session =>
            session.env.PNYX_HYDRA === s.hydraId)

          return latest && latest.id !== s.state().cards[HYDRA_CARD]?.agent?.sessionId
          && latest.received.some(text => summary({ text }))
        },
      })
      assert.equal(
        s.state().historyMilestones?.find(item => item.id === pass.parent)?.state,
        'started',
      )
      assert.equal(
        s.state().hydraOperation?.id,
        pass.parent,
      )
      assert.equal(
        s.state().historyMilestones?.find(item => item.id === native.id)?.summary,
        'Native context belongs only to the native operation.',
      )
      compact.release()
      await until({
        what: 'the switch to finish with its own summary',
        check: () => s.state().historyMilestones?.find(item => item.id === pass.parent)?.state === 'finished' && s.state().hydraAgent?.model === 'opus',
      })
      const switched = s.state().historyMilestones!.find(item => item.id === pass.parent)!
      assert.equal(
        switched.summary,
        'Switch handoff covers the pinned snapshot.',
      )
      assert.equal(
        switched.through,
        pass.through,
      )
      assert.equal(
        s.state().historyMilestones?.find(item => item.id === native.id)?.summary,
        'Native context belongs only to the native operation.',
      )
      const history = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-compaction',
        ],
      })
      assert.equal(
        history.boundary,
        switched.through,
      )
      assert.match(
        String(history.text),
        /Pending after the switch snapshot/,
      )
      await until({
        what: 'the replacement agent to receive the matching summary and history boundary',
        check: () => pnyx.claude.sessions.some(session => session.env.PNYX_HYDRA === s.hydraId && session.model === 'opus' && session.received.some(text => text.includes(switched.summary!) && text.includes(`--since ${switched.id}`))),
      })
      await until({
        what: 'the replacement turn to settle',
        check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      await page.command({
        name: 'hydra-agent',
        args: [
          JSON.stringify({
            harness: 'claude',
            model: 'sonnet',
          }),
        ],
      })
      await s.owner({
        args: [
          'hydra',
          'send',
          '--text',
          'Try another inscription',
          '--event-id',
          'failed-native',
        ],
      })
      pnyx.claude.plan({
        match: inscription,
        reply: 'Memory was not saved.',
        before: [
          nativeStart(),
          nativeDone(),
        ],
      })
      await page.command({
        name: 'hydra-agent-change',
        args: [
          'failed-native',
          'inscribe',
        ],
      })
      await until({
        what: 'the failed inscription to leave its switch failed',
        check: () => s.state().hydraAgentChange?.id === 'failed-native' && s.state().hydraAgentChange?.state === 'failed' && !s.state().hydraOperation,
      })
      const failed = s.state().historyMilestones!.findLast(item => item.kind === 'inscribe' && item.state === 'failed')!
      assert.equal(
        s.state().historyMilestones?.find(item => item.id === failed.parent)?.state,
        'failed',
      )
      assert.equal(
        s.state().hydraMessages?.some(message => message.id === `milestone:${failed.parent}` && message.text === 'Compacted'),
        false,
      )
      assert.equal(
        s.state().hydraAgent?.model,
        'opus',
      )
      assert.equal(
        s.events().some(event => event.type === 'hydra.operation' && 'seq' in event.data),
        false,
      )
      assert.equal(
        s.events().some(event => event.type === 'hydra.operation' && 'summary' in event.data),
        false,
      )
    } finally {
      inscribe.release()
      compact.release()
      page.close()
    }
  },
)

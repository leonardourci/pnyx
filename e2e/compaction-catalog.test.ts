import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Catalog } from '#hydra/transcripts-catalog.ts'

for (const {
  harness,
  provider,
} of [
    {
      harness: 'claude',
      provider: 'claude-code',
    },
    {
      harness: 'codex',
      provider: 'codex',
    },
  ]) {
  test(
    `${harness} remote sessions offer native compaction before command discovery`,
    async t => {
      const app = await fixtureApplication({ t })
      const server = await app.start()
      await app.cli({
        args: [
          'rule',
          'set',
          'hydra',
          '--harness',
          harness,
          '--model',
          'fixture',
        ],
      })
      const previousHome = process.env.PNYX_HOME
      process.env.PNYX_HOME = app.home
      t.after(() => {
        if (previousHome === undefined) {
          delete process.env.PNYX_HOME
        } else {
          process.env.PNYX_HOME = previousHome
        }
      })
      const page = await openPage({
        port: server.port,
        hydraId: 'default',
      })
      t.after(page.close)
      const result = await page.command({
        name: 'catalog',
        args: [HYDRA_CARD],
      })
      const catalog = result.catalog as Catalog
      assert.deepEqual(
        catalog.suggestions.filter(item => item.command === '/compact'),
        [
          {
            command: '/compact',
            description: 'Compact the conversation',
            source: 'Agent commands',
            kind: 'command',
          },
        ],
      )
      const selected = catalog.suggestions.find(item => item.command === '/compact')
      assert.ok(selected)
      await page.command({
        name: 'hydra',
        args: [
          'send',
          `--text=${selected.command}`,
        ],
      })
      await until({
        what: 'the selected command to reach the native session',
        check: async () => (await app.host.stats()).some(session => session.input.some(input => input.text === '/compact')),
      })
      await page.shows({
        what: 'the native session attachment',
        check: ({ state }) => state.cards[HYDRA_CARD]?.agent,
      })
      assert.equal(
        app.state().cards[HYDRA_CARD]?.agent?.provider,
        provider,
      )

      const unsupported = join(
        app.folder,
        'unsupported.json',
      )
      writeFileSync(
        unsupported,
        JSON.stringify({
          agent: {
            provider: 'unsupported',
            sessionId: 'synthetic-unsupported',
            cwd: app.folder,
          },
        }),
      )
      await app.cli({
        args: [
          'push',
          '--key',
          'unsupported',
          '--file',
          unsupported,
        ],
      })
      await page.shows({
        what: 'the unsupported session card',
        check: ({ state }) => Object.values(state.cards).some(card => card.key === 'unsupported'),
      })
      const unknown = await page.command({
        name: 'catalog',
        args: ['unsupported'],
      })
      assert.deepEqual(
        (unknown.catalog as Catalog).suggestions,
        [],
      )
    },
  )
}

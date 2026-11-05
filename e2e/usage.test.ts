import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'both provider transcripts send neutral current context to task cards and the composer',
  async t => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Claude usage',
        '--key',
        'claude-usage',
      ],
    })
    await s.owner({
      args: [
        'push',
        '--key',
        'claude-usage',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: 'usage-claude',
          transcriptPath: join(
            import.meta.dirname,
            'fixtures/usage/claude.jsonl',
          ),
        },
      }),
    })
    const claude = s.task({ key: 'claude-usage' })
    await s.owner({
      args: [
        'push',
        '--key',
        'composer-usage',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: 'usage-composer',
          transcriptPath: join(
            import.meta.dirname,
            'fixtures/usage/claude.jsonl',
          ),
        },
      }),
    })
    await s.owner({
      args: [
        'hydra',
        'set',
        '--session',
        'claude-code:usage-composer',
      ],
    })
    const taskUsage = await until({
      what: 'Claude task context',
      check: () => page.usages[claude.id]?.context && page.usages[claude.id],
    })
    const composerUsage = await until({
      what: 'composer context',
      check: () => page.usages[HYDRA_CARD]?.context && page.usages[HYDRA_CARD],
    })
    assert.deepEqual(
      taskUsage.context,
      {
        used: 84_000,
        window: 200_000,
        left: 116_000,
        source: 'reported',
      },
    )
    assert.deepEqual(
      composerUsage.context,
      taskUsage.context,
    )
    assert.deepEqual(
      composerUsage.who,
      taskUsage.who,
    )
    const cliUsage = await page.command({
      name: 'hydra',
      args: [
        'usage',
        '--task',
        claude.id,
      ],
    })
    assert.deepEqual(
      cliUsage.context,
      taskUsage.context,
    )
    assert.deepEqual(
      cliUsage.recorded,
      taskUsage.recorded,
    )
    assert.equal(
      cliUsage.helper,
      undefined,
    )
    assert.equal(
      taskUsage.who.provider,
      'Claude',
    )
    assert.equal(
      taskUsage.recorded.tokens,
      110_000,
    )

    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Codex usage',
        '--key',
        'codex-usage',
      ],
    })
    await s.owner({
      args: [
        'push',
        '--key',
        'codex-usage',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'codex',
          sessionId: 'usage-codex',
          transcriptPath: join(
            import.meta.dirname,
            'fixtures/usage/codex.jsonl',
          ),
        },
      }),
    })
    const codex = s.task({ key: 'codex-usage' })
    const codexUsage = await until({
      what: 'Codex task context',
      check: () => page.usages[codex.id]?.context && page.usages[codex.id],
    })
    assert.deepEqual(
      codexUsage.context,
      taskUsage.context,
    )
    assert.deepEqual(
      codexUsage.recorded,
      taskUsage.recorded,
    )
    assert.equal(
      codexUsage.who.provider,
      'Codex',
    )

    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Unknown usage',
        '--key',
        'unknown-usage',
      ],
    })
    await s.owner({
      args: [
        'push',
        '--key',
        'unknown-usage',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'codex',
          sessionId: 'usage-missing',
          transcriptPath: join(
            s.folder({ name: 'unknown-transcript' }),
            'missing.jsonl',
          ),
        },
      }),
    })
    const unknown = s.task({ key: 'unknown-usage' })
    const unavailable = await until({
      what: 'unavailable usage',
      check: () => page.usages[unknown.id]?.who.provider === 'Codex' && page.usages[unknown.id],
    })
    assert.equal(
      unavailable.context,
      undefined,
    )
    assert.equal(
      unavailable.recorded.tokens,
      undefined,
    )
    assert.equal(
      unavailable.unavailable,
      'Current context has not been reported',
    )
  },
)

test(
  'live Claude and Codex readings reach the page without waiting for recorded task totals',
  async t => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    await s.chat({ text: 'Read the current usage.' })
    const liveHydra = await until({
      what: 'live Hydra context',
      check: () => page.usages[HYDRA_CARD]?.context,
    })
    assert.deepEqual(
      liveHydra,
      {
        used: 601,
        window: 1_000_000,
        left: 999_399,
        source: 'reported',
      },
    )
    const folder = s.folder({ name: 'usage-worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Live usage',
        '--key',
        'live-usage',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'live-usage',
        '--harness',
        'codex',
      ],
    })
    const card = s.task({ key: 'live-usage' })
    const liveWorker = await until({
      what: 'live worker context',
      check: () => page.usages[card.id]?.context,
    })
    assert.deepEqual(
      liveWorker,
      {
        used: 22_192,
        window: 475_000,
        left: 452_808,
        source: 'reported',
      },
    )
    assert.equal(
      page.usages[card.id]?.who.provider,
      'Codex',
    )
  },
)

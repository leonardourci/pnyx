import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync } from 'node:fs'
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
    const transcript = join(
      s.folder({ name: 'claude-transcript' }),
      'usage.jsonl',
    )
    copyFileSync(
      join(
        import.meta.dirname,
        'fixtures/usage/claude.jsonl',
      ),
      transcript,
    )
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
          transcriptPath: transcript,
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
          transcriptPath: transcript,
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
    assert.deepEqual(
      cliUsage.who,
      taskUsage.who,
    )
    assert.equal(
      taskUsage.who.account,
      'claude:test',
    )
    assert.equal(
      cliUsage.used,
      undefined,
    )
    assert.equal(
      cliUsage.account,
      undefined,
    )
    const refreshed = await page.command({
      name: 'hydra',
      args: [
        'usage',
        'refresh',
        '--task',
        claude.id,
        '--force',
      ],
    })
    assert.equal(
      refreshed.refreshed,
      'plan limits',
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
      {
        used: 84_000,
        window: 200_000,
        left: 116_000,
        source: 'reported',
      },
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
    const empty = s.task({ key: 'unknown-usage' })
    const noAgent = await page.command({
      name: 'hydra',
      args: [
        'usage',
        '--task',
        empty.id,
      ],
    })
    assert.equal(
      noAgent.usage,
      'none: task has no agent session',
    )
    assert.equal(
      page.usages[empty.id],
      undefined,
    )
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
    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
      }) + '\n',
    )
    await until({
      what: 'compaction to clear the transcript context',
      check: () => {
        const worker = page.usages[claude.id]?.context
        const composer = page.usages[HYDRA_CARD]?.context

        return worker === undefined && composer === undefined
      },
    })
    assert.equal(
      page.usages[claude.id]?.recorded.tokens,
      110_000,
    )
    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-05T12:03:00Z',
        message: {
          id: 'after-compaction',
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 100,
            output_tokens: 5,
          },
        },
      }) + '\n',
    )
    await until({
      what: 'real response after compaction to restore context',
      check: () =>
        page.usages[claude.id]?.context?.used === 100,
    })
    assert.deepEqual(
      page.usages[claude.id]?.context,
      {
        used: 100,
        source: 'reported',
      },
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

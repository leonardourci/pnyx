import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyHydra } from '#app/reducer.ts'
import { hydraDigest } from './digest.ts'
import { createDigestContext } from './digest-context.ts'

test(
  'native digest recovery survives compaction and restores owner memory once per context',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-digest-context-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const path = join(
      root,
      'session.jsonl',
    )
    const state = emptyHydra()
    const owner = {
      preferences: {
        text: 'Synthetic release approval policy',
        at: '2026-01-01T00:00:00Z',
      },
    }
    const full = hydraDigest({
      hydraId: 'lab',
      state,
      owner,
      checkpointed: true,
    })
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: 'user',
          message: { content: full },
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
        }),
        JSON.stringify({
          type: 'attachment',
          attachment: {
            type: 'hook_additional_context',
            content: [full],
          },
        }),
      ].join('\n') + '\n',
    )
    const render = async ({ previousDigest }: { previousDigest?: string }) => hydraDigest({
      hydraId: 'lab',
      state,
      owner,
      previousDigest,
      checkpointed: true,
    })
    const context = createDigestContext({
      agent: {
        provider: 'claude-code',
        sessionId: 'synthetic',
        transcriptPath: path,
      },
      render,
    })
    assert.doesNotMatch(
      await context(),
      /Synthetic release approval policy/,
    )
    assert.match(
      await context({ compacted: true }),
      /Synthetic release approval policy/,
    )
    assert.doesNotMatch(
      await context(),
      /Synthetic release approval policy/,
    )
    writeFileSync(
      path,
      JSON.stringify({
        type: 'compacted',
        payload: {},
      }) + '\n',
    )
    const restarted = createDigestContext({
      agent: {
        provider: 'codex',
        sessionId: 'synthetic',
        transcriptPath: path,
      },
      render: async ({
        previousDigest,
        compacted,
      }) => {
        const digest = await render({ previousDigest })

        return compacted ? digest + '\nRead conversation history after compaction.' : digest
      },
    })
    assert.match(
      await restarted(),
      /Read conversation history after compaction/,
    )
    assert.doesNotMatch(
      await restarted(),
      /Read conversation history after compaction/,
    )
    const changed = await render({ previousDigest: '<pnyx-digest checkpoint="invalid">' })
    assert.match(
      changed,
      /Synthetic release approval policy/,
    )
  },
)

test(
  'digest recovery reads the latest checkpoint across read boundaries and partial records',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-digest-tail-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const path = join(
      root,
      'session.jsonl',
    )
    const digest = `<pnyx-digest>${'é'.repeat(70_000)}</pnyx-digest>`
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: 'user',
          message: { content: '<pnyx-digest>old</pnyx-digest>' },
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
        }),
        JSON.stringify({
          type: 'user',
          message: { content: digest },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: 'x'.repeat(80_000) },
        }),
        '{"partial":',
      ].join('\n'),
    )
    const context = createDigestContext({
      agent: {
        provider: 'claude-code',
        sessionId: 'synthetic',
        transcriptPath: path,
      },
      render: async ({
        previousDigest,
        compacted,
      }) => {
        assert.equal(
          compacted,
          false,
        )

        return previousDigest ?? ''
      },
    })
    assert.equal(
      await context(),
      digest,
    )
  },
)

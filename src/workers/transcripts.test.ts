import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { readTranscriptRecord, transcriptMessages } from './transcripts.ts'

const records = JSON.parse(readFileSync(
  new URL(
    './fixtures/transcripts.json',
    import.meta.url,
  ),
  'utf8',
))
const at = '2026-10-22T10:00:00.000Z'

test(
  'Claude and Codex records read as the same neutral role, timestamp and typed text',
  () => {
    const claude = readTranscriptRecord({ record: records.claude })
    assert.equal(
      claude.role,
      'assistant',
    )
    assert.equal(
      claude.at,
      at,
    )
    assert.deepEqual(
      claude.messages,
      [
        {
          at,
          text: 'Ready',
        },
      ],
    )

    const codex = readTranscriptRecord({ record: records.codex })
    assert.equal(
      codex.role,
      'assistant',
    )
    assert.equal(
      codex.at,
      at,
    )
    assert.deepEqual(
      codex.messages,
      [
        {
          at,
          text: 'Ready',
        },
      ],
    )
  },
)

test(
  'neutral traces preserve source positions and pair calls without exposing protocol blocks',
  () => {
    const claude = readTranscriptRecord({ record: records.claude })
    assert.deepEqual(
      claude.traces,
      [
        {
          index: 1,
          kind: 'thinking',
          role: 'thinking',
          text: 'Check the build',
        },
        {
          index: 2,
          kind: 'tool',
          role: 'Bash',
          text: '{"command":"pnpm build"}',
          call: 'build',
        },
      ],
    )
    assert.deepEqual(
      claude.calls,
      [
        {
          id: 'build',
          tool: 'Bash',
          command: 'pnpm build',
        },
      ],
    )

    const codex = readTranscriptRecord({ record: records.codexCall })
    assert.deepEqual(
      codex.calls,
      [
        {
          id: 'build',
          tool: 'shell',
          command: 'pnpm build',
        },
      ],
    )
    assert.deepEqual(
      codex.traces,
      [
        {
          index: 0,
          kind: 'tool',
          role: 'shell',
          text: '{"command":"pnpm build"}',
          call: 'build',
        },
      ],
    )
  },
)

test(
  'adapter settings retain native values and isolate sidechain settings',
  () => {
    assert.deepEqual(
      readTranscriptRecord({ record: records.codexContext }).settings,
      {
        model: 'gpt-6.1',
        effort: 'high',
        fast: 'on',
        approval: 'on-request',
        sandbox: 'workspace-write',
        collaboration: 'default',
      },
    )
    assert.deepEqual(
      readTranscriptRecord({
        record: {
          type: 'session_meta',
          payload: {
            originator: 'codex_cli_rs',
            cli_version: '0.200.0',
          },
        },
      }).settings,
      {
        client: 'codex_cli_rs',
        version: '0.200.0',
      },
    )
    assert.deepEqual(
      readTranscriptRecord({
        record: {
          type: 'event_msg',
          payload: {
            type: 'thread_settings_applied',
            thread_settings: {
              model: 'gpt-6.1-mini',
              reasoning_effort: 'low',
              service_tier: 'flex',
              approval_policy: 'never',
              collaboration_mode: { mode: 'plan' },
              reasoning_summary: 'concise',
            },
          },
        },
      }).settings,
      {
        model: 'gpt-6.1-mini',
        effort: 'low',
        fast: 'off',
        approval: 'never',
        collaboration: 'plan',
        summary: 'concise',
      },
    )
    const sidechain = {
      ...records.claude,
      isSidechain: true,
    }
    assert.equal(
      readTranscriptRecord({ record: sidechain }).settings,
      undefined,
    )
    assert.deepEqual(
      readTranscriptRecord({
        record: sidechain,
        subagent: true,
      }).settings,
      { model: 'opus' },
    )
    assert.deepEqual(
      readTranscriptRecord({ record: sidechain }).calls,
      [],
    )
  },
)

test(
  'image wrappers stay out of text and hidden wake boundaries remain opt-in',
  () => {
    assert.equal(
      readTranscriptRecord({ record: records.codexImage }).role,
      'user',
    )
    assert.deepEqual(
      transcriptMessages({ record: records.codexImage }),
      [
        {
          at,
          text: 'Describe this image',
        },
      ],
    )
    assert.deepEqual(
      transcriptMessages({ record: records.codexWake }),
      [],
    )
    assert.deepEqual(
      transcriptMessages({
        record: records.codexWake,
        includeInternal: true,
      }),
      [
        {
          text: '',
          at,
          internal: true,
        },
      ],
    )
    assert.deepEqual(
      transcriptMessages({
        record: {
          ...records.claude,
          isMeta: true,
        },
      }),
      [],
    )
    assert.deepEqual(
      transcriptMessages({ record: null }),
      [],
    )
  },
)

test(
  'native user records retain digest checkpoints separately from visible chat and clear them at compaction',
  () => {
    const text = '<pnyx-digest hydra="lab" through="12">Saved context</pnyx-digest>\nHello'
    const claude = readTranscriptRecord({
      record: {
        type: 'user',
        message: { content: text },
      },
    })
    const codex = readTranscriptRecord({
      record: {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text,
            },
          ],
        },
      },
    })
    assert.equal(
      claude.digest,
      '<pnyx-digest hydra="lab" through="12">Saved context</pnyx-digest>',
    )
    assert.equal(
      codex.digest,
      claude.digest,
    )
    assert.equal(
      claude.messages[0]?.text,
      'Hello',
    )
    assert.equal(
      codex.messages[0]?.text,
      'Hello',
    )
    assert.equal(
      readTranscriptRecord({
        record: {
          type: 'system',
          subtype: 'compact_boundary',
        },
      }).contextReset,
      true,
    )
    assert.equal(
      readTranscriptRecord({
        record: {
          type: 'compacted',
          payload: {},
        },
      }).contextReset,
      true,
    )
    assert.equal(
      readTranscriptRecord({
        record: {
          type: 'assistant',
          message: { content: text },
        },
      }).digest,
      undefined,
    )
  },
)

test(
  'context notes hide in both providers while preserving the owner message',
  () => {
    const context = '<pnyx-context>Since your last turn (context only):\nA routine update.\n</pnyx-context>'
    const claude = ({ text }: { text: string }) => ({
      type: 'user',
      timestamp: at,
      message: { content: text },
    })
    const codex = ({ text }: { text: string }) => ({
      type: 'response_item',
      timestamp: at,
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text,
          },
        ],
      },
    })
    assert.deepEqual(
      transcriptMessages({ record: claude({ text: `${context}\nExplain the result.` }) }),
      [
        {
          at,
          text: 'Explain the result.',
        },
      ],
    )
    assert.deepEqual(
      transcriptMessages({ record: codex({ text: `${context}\nExplain the result.` }) }),
      [
        {
          at,
          text: 'Explain the result.',
        },
      ],
    )
    assert.deepEqual(
      transcriptMessages({ record: claude({ text: context }) }),
      [],
    )
    assert.deepEqual(
      transcriptMessages({ record: codex({ text: context }) }),
      [],
    )
  },
)

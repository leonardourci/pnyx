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

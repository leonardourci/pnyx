// Agent settings: model, effort, mode, fast mode and harness-specific settings read
// from hook payloads and recorded transcripts. Fixtures and a temp PNYX_HOME only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadHydra } from '../src/app/store.ts'
import { spoolWrite } from '../src/app/spool.ts'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
const FIXTURES = join(
  import.meta.dirname,
  'fixtures',
)
const transcript = ({ name }: { name: string }) => join(
  FIXTURES,
  'transcripts',
  `${name}.jsonl`,
)

function hydraId() {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-settings-',
  ))
  process.env.PNYX_HOME = home
  const env = {
    ...process.env,
    PNYX_HOME: home,
  }
  const run = ({ args = [] }: { args?: string[] } = {}) => execFileSync(
    process.execPath,
    [
      BIN,
      ...args,
    ],
    {
      env,
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  )

  const nudge = () => {
    writeFileSync(
      join(
        home,
        'other.json',
      ),
      '{}',
    )
    run({
      args: [
        'push',
        '--key',
        'other',
        '--file',
        join(
          home,
          'other.json',
        ),
      ],
    })
  }

  return {
    home,
    run,
    nudge,
  }
}

const settingsOf = ({ key }: { key: string }) => {
  const { state } = loadHydra({ hydraId: 'default' })

  return state.cards[state.keys[key]!]!.settings
}

test(
  'a subagent card reports the settings its own transcript records',
  () => {
    const {
      home,
      nudge,
    } = hydraId()
    const path = join(
      home,
      'agent-a1.jsonl',
    )
    // A subagent's own transcript holds only sidechain records.
    writeFileSync(
      path,
      readFileSync(
        transcript({ name: 'claude-settings' }),
        'utf8',
      ).split('\n')
        .filter(line => line.includes('"isSidechain":true'))
        .map(line => `${line}\n`)
        .join(''),
    )
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h1',
        at: '2026-10-14T09:00:10Z',
        harness: 'claude',
        event: 'SubagentStop',
        payload: {
          session_id: 's1',
          transcript_path: join(
            home,
            's1.jsonl',
          ),
          cwd: '/work',
          permission_mode: 'default',
          agent_id: 'agent-a1',
          agent_type: 'Explore',
          agent_transcript_path: path,
        },
      },
    })
    nudge()
    assert.deepEqual(
      settingsOf({ key: 'claude:s1/agent-a1' }),
      {
        mode: 'default',
        model: 'claude-haiku-5-5',
        effort: 'low',
        fast: 'off',
        client: 'cli',
        version: '2.1.299',
      },
    )
  },
)

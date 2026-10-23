import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeRecording, codexRecording } from './scenarios/fake-agents.ts'

const root = join(
  import.meta.dirname,
  '..',
)
const json = <T>({ path }: { path: string }) => JSON.parse(readFileSync(
  join(
    root,
    path,
  ),
  'utf8',
)) as T
const REFRESH = 'run `pnpm refresh-agent-fixtures` after changing the Agent SDK or Codex'

test(
  'the Agent SDK is pinned to one exact version, the one the fake Claude’s recording came from',
  () => {
    const pinned = json<{ dependencies: Record<string, string> }>({ path: 'package.json' }).dependencies['@anthropic-ai/claude-agent-sdk']!
    assert.match(
      pinned,
      /^\d+\.\d+\.\d+$/,
    )
    assert.equal(
      json<{ version: string }>({ path: 'node_modules/@anthropic-ai/claude-agent-sdk/package.json' }).version,
      pinned,
    )
    assert.equal(
      claudeRecording.sdk,
      pinned,
      REFRESH,
    )
  },
)

test(
  'every Codex app-server method Pnyx sends or reads exists in the protocol of the recorded Codex version',
  () => {
    const used = new Set(readFileSync(
      join(
        root,
        'src/server/codex.ts',
      ),
      'utf8',
    ).match(/'(initialize|[a-zA-Z]+\/[a-zA-Z/]+)'/g)!.map(quoted => quoted.slice(
      1,
      -1,
    )))
    const known = new Set(Object.values(codexRecording.protocol).flat())
    assert.ok(used.size > 10)
    assert.deepEqual(
      [...used].filter(method => !known.has(method)),
      [],
      `${codexRecording.codex} does not have these methods; ${REFRESH}`,
    )
  },
)

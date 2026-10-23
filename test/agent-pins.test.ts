import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
  'every Codex app-server request Pnyx sends, and every request or notification it reads, is in the recorded Codex protocol',
  () => {
    const source = readdirSync(join(
      root,
      'src/server',
    )).filter(name => /^codex.*\.ts$/.test(name))
      .map(name => readFileSync(
        join(
          root,
          'src/server',
          name,
        ),
        'utf8',
      ))
      .join('\n')
    const methods = ({ text }: { text: string }) => [...text.matchAll(/'(initialize|[a-zA-Z]+\/[a-zA-Z/]+)'/g)].map(m => m[1]!)
    const sent = new Set(source.split('\n').filter(line => /\bmethod: (?!message|event)/.test(line))
      .flatMap(line => methods({ text: line })))
    const read = new Set(methods({ text: source }).filter(method => !sent.has(method)))
    const { protocol } = codexRecording
    assert.ok(
      sent.has('turn/start') && read.has('turn/completed'),
      'the scan finds what Pnyx sends and reads',
    )
    assert.deepEqual(
      {
        sent: [...sent].filter(method => !protocol.clientRequests.includes(method)),
        read: [...read].filter(method => ![
          ...protocol.serverRequests,
          ...protocol.serverNotifications,
        ].includes(method)),
      },
      {
        sent: [],
        read: [],
      },
      `${codexRecording.codex} does not have these methods; ${REFRESH}`,
    )
  },
)

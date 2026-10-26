import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpawnCodex } from '../src/server/codex.ts'

export function fakeCodex({
  root,
  refuse,
  models = [],
  holdOpen,
  compact,
}: {
  root: string
  refuse?: string
  models?: string[]
  holdOpen?: boolean
  compact?: 'hold' | 'fail'
}) {
  const log = join(
      root,
      'rpc.jsonl',
    ), transcript = join(
      root,
      'codex.jsonl',
    )
  writeFileSync(
    log,
    '',
  )
  writeFileSync(
    transcript,
    '',
  )
  const children: ChildProcessWithoutNullStreams[] = []
  const environments: NodeJS.ProcessEnv[] = []
  let initialized = () => {}
  const initializing = new Promise<void>(resolve => {
    initialized = resolve
  })

  const spawnCodex: SpawnCodex = ({
    cwd,
    env,
  }) => {
    environments.push(env)
    const child = spawn(
      process.execPath,
      [
        join(
          import.meta.dirname,
          'fixtures/hosts/codex.mjs',
        ),
      ],
      {
        cwd,
        env: {
          ...env,
          FAKE_CODEX_LOG: log,
          FAKE_CODEX_TRANSCRIPT: transcript,
          FAKE_CODEX_REFUSE: refuse,
          FAKE_CODEX_MODELS: models.join(','),
          ...(holdOpen ? { FAKE_CODEX_HOLD_OPEN: '1' } : {}),
          ...(compact ? { FAKE_CODEX_COMPACT: compact } : {}),
        },
        stdio: 'pipe',
      },
    )
    child.stdout.once(
      'data',
      initialized,
    )
    children.push(child)

    return child
  }

  const messages = () => readFileSync(
    log,
    'utf8',
  ).trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as {
      method?: string
      id?: string | number
      params?: Record<string, unknown>
      result?: Record<string, unknown>
    })

  return {
    spawnCodex,
    children,
    environments,
    messages,
    transcript,
    initializing,
  }
}

import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
)

export function payload({ root }: { root: string }) {
  const source = join(
    root,
    'payload',
  )
  cpSync(
    join(
      ROOT,
      'src',
      'agent-host',
    ),
    join(
      source,
      'src',
      'agent-host',
    ),
    { recursive: true },
  )

  for (const file of [
    'workers/claude.ts',
    'workers/codex.ts',
    'workers/native-session.ts',
    'workers/native-work.ts',
    'workers/native-prompts.ts',
    'workers/compact-command.ts',
    'workers/input.ts',
    'workers/model.ts',
    'workers/provider.ts',
    'store/storage.ts',
    'store/paths.ts',
    'store/errors.ts',
  ]) {
    const destination = join(
      source,
      'src',
      file,
    )
    mkdirSync(
      dirname(destination),
      { recursive: true },
    )
    cpSync(
      join(
        ROOT,
        'src',
        file,
      ),
      destination,
    )
  }

  writeFileSync(
    join(
      source,
      'package.json',
    ),
    JSON.stringify({
      type: 'module',
      imports: { '#*.ts': './src/*.ts' },
    }),
  )

  return source
}

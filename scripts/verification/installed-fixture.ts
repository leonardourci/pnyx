import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function installedFixture({
  root,
  file,
}: {
  root: string
  file: string
}) {
  const source = join(
    import.meta.dirname,
    '..',
    '..',
  )
  const install = join(
    root,
    'installed-pnyx',
  )
  mkdirSync(install)
  cpSync(
    join(
      source,
      'dist',
    ),
    join(
      install,
      'dist',
    ),
    { recursive: true },
  )
  cpSync(
    join(
      source,
      'skills',
    ),
    join(
      install,
      'skills',
    ),
    { recursive: true },
  )
  cpSync(
    join(
      source,
      'setup',
    ),
    join(
      install,
      'setup',
    ),
    { recursive: true },
  )
  cpSync(
    join(
      source,
      'src/test-harness',
    ),
    join(
      install,
      'src/test-harness',
    ),
    { recursive: true },
  )
  mkdirSync(join(
    install,
    'e2e',
  ))
  cpSync(
    join(
      source,
      file,
    ),
    join(
      install,
      file,
    ),
  )
  symlinkSync(
    join(
      source,
      'node_modules',
    ),
    join(
      install,
      'node_modules',
    ),
    'dir',
  )
  writeFileSync(
    join(
      install,
      'package.json',
    ),
    JSON.stringify({
      type: 'module',
      imports: {
        '#test-harness/*.ts': './src/test-harness/*.ts',
        '#*.ts': './dist/*.js',
      },
    }),
  )

  return install
}

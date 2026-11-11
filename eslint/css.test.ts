import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test(
  'CSS lint accepts Tailwind v4 and still rejects duplicate properties',
  t => {
    const folder = mkdtempSync(join(
      process.cwd(),
      '.css-lint-',
    ))
    t.after(() => rmSync(
      folder,
      {
        recursive: true,
        force: true,
      },
    ))
    const file = join(
      folder,
      'fixture.css',
    )

    const lint = ({ css }: { css: string }) => {
      writeFileSync(
        file,
        css,
      )

      return spawnSync(
        process.execPath,
        [
          'node_modules/@biomejs/biome/bin/biome',
          'lint',
          '--config-path=biome.json',
          '--error-on-warnings',
          file,
        ],
        { encoding: 'utf8' },
      )
    }

    const valid = lint({ css: '@theme { --color-brand: #123456; } @utility content-auto { content-visibility: auto; }' })
    assert.equal(
      valid.status,
      0,
      valid.stderr,
    )
    const invalid = lint({ css: '@theme { --color-brand: #123456; } .card { color: red; color: blue; }' })
    assert.equal(
      invalid.status,
      1,
    )
    assert.match(
      invalid.stderr,
      /noDuplicateProperties/,
    )
  },
)

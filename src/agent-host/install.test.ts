import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { installBundle } from './install.ts'
import { validateBundle } from './bundle.ts'

test(
  'installed build identity changes when only provider dependency bytes change',
  t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-build-identity-'))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const source = join(
      root,
      'source',
    )
    const dependency = join(
      source,
      'node_modules/@anthropic-ai/claude-agent-sdk',
    )
    mkdirSync(
      dependency,
      { recursive: true },
    )
    writeFileSync(
      join(
        source,
        'package.json',
      ),
      JSON.stringify({ type: 'module' }),
    )
    writeFileSync(
      join(
        dependency,
        'package.json',
      ),
      JSON.stringify({
        name: '@anthropic-ai/claude-agent-sdk',
        version: '1.0.0',
        main: 'index.js',
      }),
    )
    writeFileSync(
      join(
        dependency,
        'index.js',
      ),
      'export const version = 1',
    )

    for (const folder of [
      'agent-host',
      'workers',
      'store',
    ]) {
      mkdirSync(
        join(
          source,
          'dist',
          folder,
        ),
        { recursive: true },
      )
      writeFileSync(
        join(
          source,
          'dist',
          folder,
          'main.js',
        ),
        'export {}',
      )
    }

    const directory = join(
      root,
      'bundles',
    )
    const previous = installBundle({
      source,
      directory,
    })
    writeFileSync(
      join(
        dependency,
        'index.js',
      ),
      'export const version = 2',
    )
    const updated = installBundle({
      source,
      directory,
    })
    assert.notEqual(
      validateBundle({ directory: previous }).build,
      validateBundle({ directory: updated }).build,
    )
    assert.equal(
      readFileSync(
        join(
          previous,
          'node_modules/@anthropic-ai/claude-agent-sdk/index.js',
        ),
        'utf8',
      ),
      'export const version = 1',
    )
  },
)

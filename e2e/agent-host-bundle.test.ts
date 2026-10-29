import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fork } from 'node:child_process'
import { connectHost } from '#agent-host/client.ts'
import { deferred } from '#agent-host/deferred.ts'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { stageBundle, validateBundle } from '#agent-host/bundle.ts'
import { fixtureHost, controlledSession, until } from '#agent-host/fixtures/harness.ts'

const ROOT = join(
  import.meta.dirname,
  '..',
)
const PROCESS_MS = 5000

function payload({ root }: { root: string }) {
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

test(
  'a staged host and its provider dependency bytes survive rebuilding the source payload',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-host-bundle-'))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const source = payload({ root })
    const entry = 'src/agent-host/fixtures/process.ts'
    const bundle = stageBundle({
      source,
      directory: join(
        root,
        'bundles',
      ),
      build: 'fixture',
      entry,
    })
    const host = await fixtureHost({
      t,
      entry: join(
        bundle,
        entry,
      ),
    })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    writeFileSync(
      join(
        source,
        'src',
        'workers',
        'native-session.ts',
      ),
      'throw new Error("source payload was rebuilt")\n',
    )
    assert.equal(
      validateBundle({ directory: bundle }).build,
      'fixture',
    )
    const restartedOldBundle = await fixtureHost({
      t,
      entry: join(
        bundle,
        entry,
      ),
    })
    const oldClient = await restartedOldBundle.connect()
    await controlledSession({
      host: restartedOldBundle,
      client: oldClient,
    })
    assert.equal(
      (await restartedOldBundle.stats()).length,
      1,
    )
    await restartedOldBundle.control({ kind: 'stop' })
    await restartedOldBundle.exited
    const nextBundle = stageBundle({
      source,
      directory: join(
        root,
        'bundles',
      ),
      build: 'next',
      entry,
    })
    assert.notEqual(
      nextBundle,
      bundle,
    )
    await assert.rejects(
      fixtureHost({
        t,
        entry: join(
          nextBundle,
          entry,
        ),
      }),
      /Fixture exited/,
    )
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    const admitted = await client.call({
      id: randomUUID(),
      operation: {
        kind: 'input',
        ref: session.ref,
        controller: session.token,
        input: {
          id: 'after-build',
          text: 'Still here',
          images: [],
        },
      },
    })
    assert.equal(
      admitted.kind,
      'input',
    )
    await until({ check: async () => (await host.stats())[0]?.input.length === 1 })
    await host.control({ kind: 'stop' })
    await host.exited
  },
)

test(
  'the copied production entry starts an empty host and refuses wrong entry identity or changed bytes',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-host-entry-'))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const source = payload({ root })
    const entry = 'src/agent-host/main.ts'
    const bundle = stageBundle({
      source,
      directory: join(
        root,
        'bundles',
      ),
      build: 'entry-fixture',
      entry,
    })

    const start = ({
      script,
      runtime,
    }: {
      script: string
      runtime: string
    }) => {
      const child = fork(
        script,
        [
          bundle,
          runtime,
          'entry-installation',
        ],
        {
          execArgv: ['--conditions=source'],
          silent: true,
          env: {
            ...process.env,
            HOME: root,
            PNYX_HOME: runtime,
            CLAUDE_CONFIG_DIR: root,
            CODEX_HOME: root,
          },
        },
      )
      const finished = deferred<{
        code: number | null
        stderr: string
      }>()
      let stderr = '', exited = false
      child.stderr?.on(
        'data',
        chunk => {
          stderr += chunk
        },
      )
      child.stdout?.resume()
      const deadline = setTimeout(
        () => child.kill('SIGKILL'),
        PROCESS_MS,
      )
      child.once(
        'exit',
        code => {
          exited = true
          clearTimeout(deadline)
          finished.resolve({
            code,
            stderr,
          })
        },
      )
      child.once(
        'error',
        error => {
          exited = true
          clearTimeout(deadline)
          finished.resolve({
            code: null,
            stderr: error.message,
          })
        },
      )
      t.after(async () => {
        if (!exited) {
          child.kill('SIGKILL')
        }

        await finished.promise
      })

      return {
        child,
        finished: finished.promise,
        exited: () => exited,
      }
    }

    const runtime = join(
      root,
      'runtime',
    )
    const running = start({
      script: join(
        bundle,
        entry,
      ),
      runtime,
    })
    await until({
      check: () => {
        assert.equal(
          running.exited(),
          false,
        )

        return existsSync(join(
          runtime,
          'host.sock',
        ))
      },
    })
    const client = await connectHost({
      socket: join(
        runtime,
        'host.sock',
      ),
      installation: 'entry-installation',
      token: readFileSync(
        join(
          runtime,
          'token',
        ),
        'utf8',
      ),
    })
    t.after(() => client.detach())
    assert.equal(
      client.ready.build,
      'entry-fixture',
    )
    assert.deepEqual(
      client.ready.sessions,
      [],
    )
    client.detach()
    running.child.kill('SIGTERM')
    assert.equal(
      (await running.finished).code,
      0,
    )

    const wrongRuntime = join(
      root,
      'wrong-entry',
    )
    const wrong = start({
      script: join(
        ROOT,
        entry,
      ),
      runtime: wrongRuntime,
    })
    const refusedEntry = await wrong.finished
    assert.equal(
      refusedEntry.code,
      1,
    )
    assert.match(
      refusedEntry.stderr,
      /INVALID_BUNDLE/,
    )
    assert.equal(
      existsSync(wrongRuntime),
      false,
    )

    const dependency = join(
      bundle,
      'src',
      'workers',
      'native-session.ts',
    )
    chmodSync(
      dependency,
      0o600,
    )
    writeFileSync(
      dependency,
      '\n// changed runtime bytes\n',
      { flag: 'a' },
    )
    const changedRuntime = join(
      root,
      'changed-runtime',
    )
    const changed = start({
      script: join(
        bundle,
        entry,
      ),
      runtime: changedRuntime,
    })
    const refusedBytes = await changed.finished
    assert.equal(
      refusedBytes.code,
      1,
    )
    assert.match(
      refusedBytes.stderr,
      /INVALID_BUNDLE/,
    )
    assert.equal(
      existsSync(changedRuntime),
      false,
    )
  },
)

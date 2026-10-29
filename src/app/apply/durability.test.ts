import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { until } from '#test-harness/harness.ts'

interface Result {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

interface Running {
  child: ChildProcess
  finished: Promise<Result>
  prefix: string
  readonly result: Result | undefined
}

function fixture({ t }: { t: TestContext }) {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-apply-sync-',
  ))
  const file = join(
    root,
    'changes.json',
  )
  const log = join(
    root,
    'home',
    'hydras',
    'default',
    'events.jsonl',
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PNYX_HOME: join(
      root,
      'home',
    ),
    PNYX_ACTOR: 'cli',
  }
  delete env.PNYX_TASK
  delete env.PNYX_HYDRA
  delete env.PNYX_STEERING_WORKER
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      changes: [
        {
          op: 'task.create',
          key: 'atomic',
          title: 'Atomic task',
        },
      ],
    }),
  )
  const children: Running[] = []

  const run = ({
    name,
    mode,
    check = false,
  }: {
    name: string
    mode: string
    check?: boolean
  }): Running => {
    const prefix = join(
      root,
      name,
    )
    const args = [
      '--conditions=source',
      '--import',
      new URL(
        './fixtures/fsync-probe.mjs',
        import.meta.url,
      ).href,
      'src/cli/pnyx-axi.ts',
      'apply',
      '--file',
      file,
      '--event-id',
      'durable-batch',
    ]

    if (check) {
      args.push('--check')
    }

    const child = spawn(
      process.execPath,
      args,
      {
        env: {
          ...env,
          PNYX_SYNC_PROBE: prefix,
          PNYX_SYNC_MODE: mode,
        },
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    )
    let stdout = ''
    let stderr = ''
    let result: Result | undefined
    child.stdout.on(
      'data',
      chunk => {
        stdout += String(chunk)
      },
    )
    child.stderr.on(
      'data',
      chunk => {
        stderr += String(chunk)
      },
    )
    const finished = new Promise<Result>((
      resolve,
      reject,
    ) => {
      child.once(
        'error',
        reject,
      )
      child.once(
        'close',
        (
          code,
          signal,
        ) => {
          result = {
            code,
            signal,
            stdout,
            stderr,
          }
          resolve(result)
        },
      )
    })
    const running = {
      child,
      finished,
      prefix,
      get result() {
        return result
      },
    }
    children.push(running)

    return running
  }

  t.after(async () => {
    for (const running of children) {
      if (!running.result) {
        running.child.kill('SIGKILL')
      }

      await running.finished
    }

    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })

  return {
    run,
    log,
  }
}

test(
  'a duplicate waits for the first writer to finish fsync before acknowledging the transaction',
  async t => {
    const f = fixture({ t })
    const first = f.run({
      name: 'first',
      mode: 'gate',
    })
    await until({
      what: 'the first writer gated before log fsync',
      check: () => existsSync(`${first.prefix}.entered`),
    })
    const written = readFileSync(
      f.log,
      'utf8',
    )
    const preview = f.run({
      name: 'preview',
      mode: 'observe',
      check: true,
    })
    const previewResult = await preview.finished
    assert.equal(
      previewResult.code,
      0,
      previewResult.stderr,
    )
    assert.match(
      previewResult.stdout,
      /applied: false/,
    )
    assert.equal(
      existsSync(`${preview.prefix}.lock-attempt`),
      false,
    )
    assert.equal(
      existsSync(`${preview.prefix}.completed`),
      false,
    )
    const retry = f.run({
      name: 'retry',
      mode: 'observe',
    })
    await until({
      what: 'retry attempts the writer lock or exits',
      check: () =>
        existsSync(`${retry.prefix}.lock-attempt`) || retry.result !== undefined,
    })
    assert.equal(
      retry.result,
      undefined,
      'a duplicate must wait while the first log flush is gated',
    )
    assert.equal(
      existsSync(`${first.prefix}.completed`),
      false,
    )
    assert.equal(
      existsSync(`${retry.prefix}.completed`),
      false,
    )
    writeFileSync(
      `${first.prefix}.release`,
      '',
    )
    const firstResult = await first.finished
    const retried = await retry.finished
    assert.equal(
      firstResult.code,
      0,
      firstResult.stderr,
    )
    assert.equal(
      retried.code,
      0,
      retried.stderr,
    )
    assert.match(
      retried.stdout,
      /duplicate: true/,
    )
    assert.equal(
      existsSync(`${first.prefix}.completed`),
      true,
    )
    assert.equal(
      existsSync(`${retry.prefix}.completed`),
      true,
    )
    assert.equal(
      readFileSync(
        f.log,
        'utf8',
      ),
      written,
    )
  },
)

test(
  'retry after a writer is killed before fsync flushes the complete record under the lock',
  async t => {
    const f = fixture({ t })
    const first = f.run({
      name: 'killed',
      mode: 'kill',
    })
    const killed = await first.finished
    assert.equal(
      killed.signal,
      'SIGKILL',
    )
    assert.equal(
      existsSync(`${first.prefix}.entered`),
      true,
    )
    assert.equal(
      existsSync(`${first.prefix}.completed`),
      false,
    )
    const written = readFileSync(
      f.log,
      'utf8',
    )
    assert.equal(
      written.trim().split('\n').length,
      1,
    )
    const retry = f.run({
      name: 'recovery',
      mode: 'observe',
    })
    const recovered = await retry.finished
    assert.equal(
      recovered.code,
      0,
      recovered.stderr,
    )
    assert.match(
      recovered.stdout,
      /duplicate: true/,
    )
    assert.equal(
      existsSync(`${retry.prefix}.lock-attempt`),
      true,
    )
    assert.equal(
      existsSync(`${retry.prefix}.completed`),
      true,
    )
    assert.equal(
      readFileSync(
        f.log,
        'utf8',
      ),
      written,
    )
  },
)

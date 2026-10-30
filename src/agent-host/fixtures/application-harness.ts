import { execFile, fork, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { HydraState } from '#app/model.ts'
import { deferred } from '#agent-host/deferred.ts'
import { fixtureHost } from './harness.ts'

const READY_MS = 15000

export async function fixtureApplication({
  t,
  boot,
  groups = false,
  built = true,
  local = false,
  measureNative = false,
}: {
  t: TestContext
  boot?: string
  groups?: boolean
  built?: boolean
  local?: boolean
  measureNative?: boolean
}) {
  const root = realpathSync(mkdtempSync('/tmp/pnyx-app-'))
  const messages: string[] = []
  const children: {
    child: ChildProcess
    exited: Promise<void>
  }[] = []
  t.after(async () => {
    for (const {
      child,
      exited,
    } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }

      await exited
    }
  })
  const host = await fixtureHost({
    t,
    directory: root,
    boot,
    groups,
    built,
    measure: measureNative,
  })
  t.after(() => rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  ))
  const home = join(
      root,
      'state',
    ), folder = join(
      root,
      'work',
    )

  for (const path of [
    folder,
    join(
      root,
      'codex-login',
    ),
    join(
      root,
      'claude-login',
    ),
  ]) {
    mkdirSync(path)
  }

  const env = {
    ...process.env,
    PNYX_FIXTURE_LOCAL: local ? '1' : '0',
    PNYX_HOME: home,
    HOME: root,
    CODEX_HOME: join(
      root,
      'codex-login',
    ),
    CLAUDE_CONFIG_DIR: join(
      root,
      'claude-login',
    ),
    XDG_CONFIG_HOME: join(
      root,
      'config',
    ),
    XDG_CACHE_HOME: join(
      root,
      'cache',
    ),
  }

  const cli = async ({ args }: { args: string[] }) => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        join(
          import.meta.dirname,
          '../../../dist/cli/pnyx-axi.js',
        ),
        ...args,
      ],
      { env },
    )

    return result.stdout
  }

  const state = (): HydraState => JSON.parse(readFileSync(
    join(
      home,
      'hydras/default/snapshot.json',
    ),
    'utf8',
  )).state

  const start = async ({
    holdInputs = false,
    holdCompletionAcks = false,
    traceOpens = false,
    holdHelperCompletion = false,
  }: {
    holdInputs?: boolean | 'wake'
    holdCompletionAcks?: boolean
    traceOpens?: boolean
    holdHelperCompletion?: boolean
  } = {}) => {
    const child = fork(
      join(
        import.meta.dirname,
        'application.ts',
      ),
      [
        root,
        join(
          root,
          'journal',
        ),
      ],
      {
        silent: true,
        execArgv: built ? [] : ['--conditions=source'],
        env: {
          ...env,
          PNYX_FIXTURE_HOLD_HELPER_COMPLETION: holdHelperCompletion ? '1' : '0',
          PNYX_FIXTURE_TRACE_OPENS: String(traceOpens),
          PNYX_FIXTURE_HOLD_INPUTS: String(holdInputs),
          PNYX_FIXTURE_HOLD_COMPLETION_ACKS: String(holdCompletionAcks),
        },
      },
    )
    const ready = deferred<void>(), exited = deferred<void>()
    const heldInputs: {
      epoch: string
      id: string
    }[] = []
    let port = 0
    const requests = new Map<string, ReturnType<typeof deferred<unknown>>>()
    let errors = ''
    child.stderr!.on(
      'data',
      chunk => {
        errors += chunk

        if (process.env.PNYX_TEST_VERBOSE === '1') {
          process.stderr.write(String(chunk))
        }

        messages.push(String(chunk))
      },
    )
    child.on(
      'message',
      message => {
        const held = message as {
          type: string
          epoch: string
          inputId: string
        }

        if (held.type === 'input-held') {
          heldInputs.push({
            epoch: held.epoch,
            id: held.inputId,
          })
        }

        const id = (message as { id?: string }).id

        if (id) {
          requests.get(id)?.resolve(message)
        }

        if ((message as { type: string }).type === 'ready') {
          port = (message as { port: number }).port
          ready.resolve()
        }
      },
    )
    child.on(
      'error',
      error => ready.reject(error),
    )
    child.on(
      'exit',
      () => {
        exited.resolve(); ready.reject(new Error(errors))
      },
    )
    children.push({
      child,
      exited: exited.promise,
    })
    const timeout = setTimeout(
      () => ready.reject(new Error(`Application did not become ready: ${errors}`)),
      READY_MS,
    )

    try {
      await ready.promise
    } finally {
      clearTimeout(timeout)
    }

    return {
      child,
      heldInputs,
      port,
      control: async ({
        kind,
        nativeId,
        text,
      }: {
        kind: string
        nativeId?: string
        text?: string
      }) => {
        const id = String(Math.random())
        const result = deferred<unknown>()
        requests.set(
          id,
          result,
        )
        const timer = setTimeout(
          () => result.reject(new Error('Application fixture control timed out')),
          READY_MS,
        )
        child.send({
          id,
          kind,
          nativeId,
          text,
        })

        try {
          return await result.promise
        } finally {
          clearTimeout(timer); requests.delete(id)
        }
      },
      exited: exited.promise,
    }
  }

  return {
    root,
    home,
    folder,
    cli,
    state,
    start,
    errors: () => messages.join(''),
    host,
  }
}

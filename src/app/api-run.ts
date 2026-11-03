import { Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { HydraError } from '#store/errors.ts'
import { nonblockingLocks } from '#store/storage.ts'
import { runCli } from '#cli/run.ts'
import { IDENTITY, requestExitCode, runForClient } from './request-context.ts'

export type RunRequest = {
  argv: string[]
  cwd: string
  env: Partial<Record<(typeof IDENTITY)[number], string>>
  stdin?: string
}

export type RunAnswer = {
  stdout: string
  exitCode: number
}

const strings = ({ value }: { value: unknown }) => Array.isArray(value) && value.every(item => typeof item === 'string')

function request({ body }: { body: unknown }): RunRequest {
  const given = (body ?? {}) as Partial<Record<keyof RunRequest, unknown>>
  const env = (given.env ?? {}) as Record<string, unknown>

  if (!strings({ value: given.argv }) || typeof given.cwd !== 'string' || !given.cwd.startsWith('/')
    || (given.stdin !== undefined && typeof given.stdin !== 'string')
    || typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string')) {
    throw new HydraError({
      message: 'a run needs argv, an absolute cwd, string identity variables and optional stdin text',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    argv: given.argv as string[],
    cwd: given.cwd,
    env: Object.fromEntries(IDENTITY.flatMap(name => typeof env[name] === 'string' ? [
      [
        name,
        env[name],
      ],
    ] : [])),
    stdin: given.stdin as string | undefined,
  }
}

// While a Hydra's log still has a writer lock, a command can meet a write the server itself has under way;
// a command refused at the lock is tried again shortly, up to a bound.
const LOCKED_RETRY_MS = 50
const LOCKED_WAIT_MS = 5000

// Runs a pnyx-axi command line for a client, in the client's identity and folder, and answers with exactly what it printed.
export async function runForRequest({ body }: { body: unknown }): Promise<RunAnswer> {
  const end = Date.now() + LOCKED_WAIT_MS
  let answer = await runOnce({ body })

  while (answer.exitCode !== 0 && /^code: LOCKED$/m.test(answer.stdout) && Date.now() < end) {
    await delay(LOCKED_RETRY_MS)
    answer = await runOnce({ body })
  }

  return answer
}

async function runOnce({ body }: { body: unknown }): Promise<RunAnswer> {
  const {
    argv,
    cwd,
    env,
    stdin,
  } = request({ body })
  let stdout = ''
  const sink = new Writable({
    // eslint-disable-next-line pnyx/object-params -- Node's Writable owns the write signature.
    write(
      chunk,
      _encoding,
      done,
    ) {
      stdout += String(chunk)
      done()
    },
  })

  return runForClient({
    identity: env,
    cwd,
    stdin,
    run: async () => {
      const before = process.exitCode
      // Inside the server a held lock is refused at once, never waited on with the event loop blocked.
      await nonblockingLocks.run(
        true,
        () => runCli({
          argv,
          stdout: sink,
        }),
      )
      // The SDK also sets the process exit code for a refused command line; the server keeps its own, and the
      // request's status comes only from its own record.
      process.exitCode = before

      return {
        stdout,
        exitCode: requestExitCode() ?? 0,
      }
    },
  })
}

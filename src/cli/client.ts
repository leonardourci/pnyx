import { existsSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { pnyxHome } from '#store/paths.ts'
import { IDENTITY } from '#app/request-context.ts'
import type { RunAnswer } from '#app/api-run.ts'
import { join } from 'node:path'

// How long a command waits for a server that is starting; restart waits on its own.
const STARTING_MS = 10_000
const RETRY_MS = 100
// The session-start hook's one try at the server.
const CONTEXT_MS = 1000

const record = () => {
  try {
    return JSON.parse(readFileSync(
      join(
        pnyxHome(),
        'server.json',
      ),
      'utf8',
    )) as {
      pid: number
      port: number
    }
  } catch {
    return undefined
  }
}

const alive = ({ pid }: { pid: number }) => {
  try {
    process.kill(
      pid,
      0,
    )

    return true
  } catch {
    return false
  }
}

// The command's stdin, only when it reads `--file -`; anything else leaves stdin alone.
const stdinText = ({ argv }: { argv: string[] }) => argv.some((
  arg,
  i,
) => arg === '--file=-' || (arg === '-' && argv[i - 1] === '--file'))
  ? readFileSync(
    0,
    'utf8',
  )
  : undefined

async function send({
  port,
  argv,
  stdin,
  timeout,
}: {
  port: number
  argv: string[]
  stdin?: string
  // Milliseconds of silence before giving up; without it a long `--wait` keeps the request open as long as it needs.
  timeout?: number
}): Promise<RunAnswer> {
  const body = JSON.stringify({
    argv,
    cwd: process.cwd(),
    env: Object.fromEntries(IDENTITY.flatMap(name => process.env[name] === undefined ? [] : [
      [
        name,
        process.env[name],
      ],
    ])),
    stdin,
  })

  // node:http rather than fetch, whose five-minute header timeout would cut a long `hydra check --wait`.
  return new Promise((
    resolve,
    reject,
  ) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/run',
        method: 'POST',
        timeout,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'authorization': `Bearer ${readFileSync(
            join(
              pnyxHome(),
              'token',
            ),
            'utf8',
          ).trim()}`,
        },
      },
      // eslint-disable-next-line pnyx/object-params -- node:http owns the response callback signature.
      response => {
        let text = ''
        response.setEncoding('utf8')
        response.on(
          'data',
          (chunk: string) => {
            text += chunk
          },
        )
        response.on(
          'end',
          () => {
            if (response.statusCode !== 200) {
              reject(new Error(`the Pnyx server answered ${response.statusCode}`))

              return
            }

            try {
              resolve(JSON.parse(text) as RunAnswer)
            } catch (error) {
              reject(error)
            }
          },
        )
      },
    )
    request.on(
      'timeout',
      () => request.destroy(new Error('the Pnyx server did not answer in time')),
    )
    request.on(
      'error',
      reject,
    )
    request.end(body)
  })
}

const unavailable = ({ message }: { message: string }) => {
  process.stdout.write(`error: ${JSON.stringify(`The Pnyx server did not answer: ${message}`)}\ncode: SERVER_UNAVAILABLE\nhelp[1]: "Run \`pnyx-axi restart\`"\n`)
  process.exitCode = 1
}

// The session-start hook runs `context`: one quick try, and nothing printed or started when the server is down.
async function context({ argv }: { argv: string[] }) {
  const server = record()

  if (!server || !alive(server)) {
    return
  }

  try {
    const answer = await send({
      port: server.port,
      argv,
      timeout: CONTEXT_MS,
    })
    process.stdout.write(answer.stdout)
  } catch {
    // A hook prints nothing but its summary and never fails the session it runs in.
  }
}

// Sends one command line to the running server and prints its answer; when it is down, its login service starts it.
export async function forward({ argv }: { argv: string[] }): Promise<void> {
  if (argv[0] === 'context') {
    await context({ argv })

    return
  }

  const stdin = stdinText({ argv })
  const end = Date.now() + STARTING_MS
  let started = false
  let last = 'it is not running'

  while (Date.now() <= end) {
    const server = record()

    if (server && alive(server)) {
      try {
        const answer = await send({
          port: server.port,
          argv,
          stdin,
        })
        process.stdout.write(answer.stdout)
        process.exitCode = answer.exitCode

        return
      } catch (error) {
        // Only a refused connection is safe to send again: any other failure may come after the server ran the command.
        if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
          unavailable({ message: (error as Error).message })

          return
        }

        last = (error as Error).message
      }
    } else if (!started) {
      started = true
      const { restartPnyx } = await import('#upgrade/restart.ts')
      const { serviceFile } = await import('#setup/service.ts')

      // Only the login service starts it; a server nobody installed is started by its owner.
      if (!existsSync(serviceFile().path)) {
        process.stdout.write('error: "Pnyx is not running"\ncode: NOT_RUNNING\nhelp[1]: "Run `pnyx-axi serve`, or `pnyx-axi setup` to start it at login"\n')
        process.exitCode = 1

        return
      }

      try {
        await restartPnyx()
      } catch (error) {
        process.stdout.write(`error: ${JSON.stringify(`Pnyx could not start: ${(error as Error).message}`)}\ncode: SERVER_UNAVAILABLE\n`)
        process.exitCode = 1

        return
      }
    }

    await delay(RETRY_MS)
  }

  unavailable({ message: last })
}

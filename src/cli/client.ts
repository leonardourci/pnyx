import { readFileSync } from 'node:fs'
import { pnyxHome } from '#store/paths.ts'
import { IDENTITY } from '#app/request-context.ts'
import type { RunAnswer } from '#app/api-run.ts'
import { join } from 'node:path'

// How long a command waits for a server that is starting; restart waits on its own.
const STARTING_MS = 10_000
const RETRY_MS = 100

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
}: {
  port: number
  argv: string[]
  stdin?: string
}): Promise<RunAnswer> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/run`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${readFileSync(
          join(
            pnyxHome(),
            'token',
          ),
          'utf8',
        ).trim()}`,
      },
      body: JSON.stringify({
        argv,
        cwd: process.cwd(),
        env: Object.fromEntries(IDENTITY.flatMap(name => process.env[name] === undefined ? [] : [
          [
            name,
            process.env[name],
          ],
        ])),
        stdin,
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`the Pnyx server answered ${response.status}`)
  }

  return await response.json() as RunAnswer
}

// Sends one command line to the running server and prints its answer; starts the server first when it is down.
// `context`, which the session-start hook runs, never starts it and prints nothing when it is down.
export async function forward({ argv }: { argv: string[] }): Promise<void> {
  const stdin = stdinText({ argv })
  const quiet = argv[0] === 'context'
  let started = false

  for (const end = Date.now() + STARTING_MS; ;) {
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
        if (Date.now() > end) {
          if (!quiet) {
            process.stdout.write(`error: ${JSON.stringify(`The Pnyx server did not answer: ${(error as Error).message}`)}\ncode: SERVER_UNAVAILABLE\nhelp[1]: "Run \`pnyx-axi restart\`"\n`)
            process.exitCode = 1
          }

          return
        }
      }
    } else if (quiet) {
      return
    } else if (!started) {
      started = true
      const { restartPnyx } = await import('#upgrade/restart.ts')

      try {
        await restartPnyx()
      } catch (error) {
        process.stdout.write(`error: ${JSON.stringify(`Pnyx could not start: ${(error as Error).message}`)}\ncode: SERVER_UNAVAILABLE\n`)
        process.exitCode = 1

        return
      }
    }

    await new Promise(resolve => setTimeout(
      resolve,
      RETRY_MS,
    ))
  }
}

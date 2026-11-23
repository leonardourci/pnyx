import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { MAX_BODY } from '#app/server-protocol.ts'
import { request as httpRequest } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { pnyxHome } from '#store/paths.ts'
import { cliArguments } from './arguments.ts'
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
  ? readMessageInput({ source: process.stdin })
  : undefined

async function commandInput({ argv }: { argv: string[] }): Promise<{
  argv: string[]
  stdin?: string
}> {
  const parsed = cliArguments({ argv })
  const files = parsed.tokens.filter(token => token.kind === 'option' && token.name === 'file')
  const file = files[0]

  if (parsed.argv[0] !== 'send' || files.length !== 1 || file?.kind !== 'option' || !file.value) {
    return { argv }
  }

  if (file.value === '-') {
    return {
      argv,
      stdin: await stdinText({
        argv: [
          '--file',
          '-',
        ],
      }),
    }
  }

  const stdin = await readMessageInput({ source: createReadStream(file.value) })
  const forwarded = [...argv]

  if (file.inlineValue) {
    forwarded[file.index] = '--file=-'
  } else {
    forwarded[file.index + 1] = '-'
  }

  return {
    argv: forwarded,
    stdin,
  }
}

async function readMessageInput({ source }: {
  source: AsyncIterable<Buffer>
}): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0

  for await (const chunk of source) {
    bytes += chunk.length

    if (bytes > MAX_BODY) {
      throw new Error('message input exceeds the request size limit')
    }

    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}

// Runs one command line in the server and answers with what it printed and its exit code.
async function send({
  port,
  argv,
  stdin,
}: {
  port: number
  argv: string[]
  stdin?: string
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
        // A connection of its own: the shared agent's idle timeout would cut a command that takes longer than five seconds.
        agent: false,
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
      'error',
      reject,
    )
    request.end(body)
  })
}

const failure = ({
  argv,
  message,
  code,
}: {
  argv: string[]
  message: string
  code: string
}) => {
  const { json } = cliArguments({ argv })
  process.stderr.write(json ? `${JSON.stringify({
    error: message,
    code,
  })}\n` : `${code}: ${message}\n`)
  process.exitCode = code === 'VALIDATION_ERROR' ? 2 : 1
}

// Sends one command line to the running server and prints its answer; when it is down, its login service starts it.
export async function forward({ argv }: { argv: string[] }): Promise<void> {
  let input: Awaited<ReturnType<typeof commandInput>>

  try {
    input = await commandInput({ argv })
  } catch (error) {
    failure({
      argv,
      message: (error as Error).message,
      code: 'VALIDATION_ERROR',
    })

    return
  }

  argv = input.argv
  const stdin = input.stdin
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
        const stream = answer.exitCode === 0 ? process.stdout : process.stderr
        stream.write(answer.stdout)
        process.exitCode = answer.exitCode

        return
      } catch (error) {
        // Only a refused connection is safe to send again: any other failure may come after the server ran the command.
        if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
          failure({
            argv,
            message: (error as Error).message,
            code: 'SERVER_UNAVAILABLE',
          })

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
        failure({
          argv,
          message: 'Pnyx is not running',
          code: 'NOT_RUNNING',
        })

        return
      }

      try {
        await restartPnyx()
      } catch (error) {
        failure({
          argv,
          message: (error as Error).message,
          code: 'SERVER_UNAVAILABLE',
        })

        return
      }
    }

    await delay(RETRY_MS)
  }

  failure({
    argv,
    message: last,
    code: 'SERVER_UNAVAILABLE',
  })
}

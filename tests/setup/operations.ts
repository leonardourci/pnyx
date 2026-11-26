import { invocationOf } from '#cli/run.ts'
import { commands } from '#app/cli.ts'
import { approval } from '#app/confirmations.ts'
import { project } from '#projects/cli.ts'
import { dispatchCommands } from '#workers/dispatch-cli.ts'
import { agent } from '#workers/agent-cli.ts'
import { reply } from '#workers/reply-cli.ts'
import { integrationsCommand } from '#integrations/cli.ts'
import { oracleCommands } from '#oracle/cli.ts'
import { supervisedCommands } from '#routine-helper/commands.ts'
import { agentNotices } from '#titan/titan-session.ts'
import { workerScoped } from '#workers/worker-scope.ts'
import { runForClient, requestInvocation, IDENTITY } from '#app/request-context.ts'
import { TitanError } from '#store/errors.ts'
import { ApplyError } from '#app/apply/schema.ts'
import { readFileSync } from 'node:fs'
import { infoPath } from '#app/server-state.ts'
import { CLI_COMMANDS } from '#app/command-registry.ts'
import { openPage } from './othrys.ts'
import { home } from '#cli/home.ts'
import type { Run } from './othrys.ts'

const operations = workerScoped({
  commands: agentNotices({
    commands: {
      ...commands,
      ...supervisedCommands({
        commands: {
          approval,
          project,
          ...dispatchCommands,
          agent,
          reply,
          integrations: integrationsCommand,
          ...oracleCommands,
        },
      }),
    },
  }),
})

export async function serverOperation({
  args,
  env,
  input,
}: {
  args: string[]
  env: NodeJS.ProcessEnv
  input?: string
}): Promise<Run> {
  const server = JSON.parse(readFileSync(
    infoPath(),
    'utf8',
  )) as {
    pid: number
    port: number
  }

  if (server.pid !== process.pid) {
    const [
      name = '',
      ...rest
    ] = args

    if (!(CLI_COMMANDS as string[]).includes(name)) {
      throw new Error(`No browser operation for ${name}`)
    }

    const titanIndex = rest.indexOf('--titan')
    const titanId = (titanIndex < 0 ? env.OTHRYS_TITAN : rest[titanIndex + 1]) ?? 'default'
    const forwarded = rest.filter((
      _,
      index,
    ) => titanIndex < 0 || (index !== titanIndex && index !== titanIndex + 1))

    if (!forwarded.includes('--actor')) {
      forwarded.push(
        '--actor',
        env.OTHRYS_ACTOR ?? 'cli',
      )
    }

    const page = await openPage({
      port: server.port,
      titanId,
    })

    try {
      const answer = await page.send({
        name,
        args: forwarded,
      })

      return {
        status: answer.type === 'error' ? 1 : 0,
        signal: null,
        stderr: '',
        stdout: `${JSON.stringify(answer)}\n`,
      }
    } finally {
      page.close()
    }
  }

  return runForClient({
    identity: Object.fromEntries(IDENTITY.flatMap(name => env[name] === undefined ? [] : [
      [
        name,
        env[name],
      ],
    ])),
    cwd: process.cwd(),
    stdin: input,
    run: async () => {
      requestInvocation().name = invocationOf({ argv: args }).name
      const [
        name,
        ...rest
      ] = args

      try {
        const handler = operations[name as keyof typeof operations]

        if (name && !handler) {
          throw new TitanError({
            message: `Unknown internal operation ${name}`,
            code: 'VALIDATION_ERROR',
          })
        }

        const output = name ? await handler!(rest) : await home({ titanId: env.OTHRYS_TITAN })

        return {
          status: 0,
          signal: null,
          stderr: '',
          stdout: `${JSON.stringify(output)}\n`,
        }
      } catch (error) {
        const code = error instanceof TitanError ? error.code : 'UNKNOWN'

        return {
          status: code === 'VALIDATION_ERROR' ? 2 : 1,
          signal: null,
          stderr: '',
          stdout: `${JSON.stringify({
            code,
            error: error instanceof Error ? error.message : String(error),
            help: error instanceof TitanError ? error.help : [],
            ...(error instanceof ApplyError ? {
              applied: false,
              errors: error.errors,
            } : {}),
          })}\n`,
        }
      }
    },
  })
}

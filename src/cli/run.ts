import { readCommand } from './reads.ts'
import { cliArguments } from './arguments.ts'
import type { Writable } from 'node:stream'
import { parse, meta, required, guard, WRITE, COMMON, type Options } from '#app/cli-support.ts'
import { HydraError } from '#store/errors.ts'
import { createCommand } from '#workers/create.ts'
import { sendReply } from '#workers/reply.ts'
import { hydraSend } from '#hydra/send-cli.ts'
import { taskCommand } from '#app/task-cli.ts'
import { setup } from '#setup/cli.ts'
import { serve } from '#app/server-cli.ts'
import { debug } from '#diagnostics/cli.ts'
import { readInput, recordExitCode, requestInvocation } from '#app/request-context.ts'
import { home } from './home.ts'
import { version } from './version.ts'
import { withCommandNotices } from '#app/command-notices.ts'
import { workerScoped } from '#workers/worker-scope.ts'
import { supervisedCommands } from '#routine-helper/commands.ts'
import { agentNotices } from '#hydra/hydra-session.ts'

const HELP = `usage: pnyx <command> [--hydra <id>] [--json]

pnyx task create --title <title> --brief <instructions> [--project <name|path>]
pnyx send --text <message> [--task <id>] [--idempotency-key <key>]
pnyx answer <task> <question> --text <answer> [--from-message <id>]
pnyx board
pnyx serve [--port <n>]
pnyx setup [check|hooks|skills] [--preview]
pnyx debug health

Task creation starts its worker. Use --harness, --account, --model, --effort,
--mode, --fast or --rule to choose its settings.
Send addresses Hydra unless --task names a worker. --file <path|-> reads message text.
Reads: task list|show|history|updates|messages|chat|questions|inbox read,
hydra check|digest|messages|message|history, card, history, context and oracle.
Add --json when a script or agent reads structured records.
Workers append needs-you, blocked, done, link or note lines to their worker.log.
`

const CREATE_OPTIONS: Options = {
  ...COMMON,
  actor: WRITE.actor,
  reason: WRITE.reason,
  details: WRITE.details,
  'event-id': WRITE['event-id'],
  'if-revision': WRITE['if-revision'],
  title: { type: 'string' },
  brief: { type: 'string' },
  project: { type: 'string' },
  ask: { type: 'string' },
  intent: { type: 'string' },
  message: { type: 'string' },
  key: { type: 'string' },
  harness: { type: 'string' },
  account: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  mode: { type: 'string' },
  fast: { type: 'string' },
  rule: { type: 'string' },
  folder: { type: 'string' },
  'in-place': { type: 'boolean' },
}

export const invocationOf = ({ argv }: { argv: string[] }) => ({
  name: argv.slice(
    0,
    argv[0] === 'task' || argv[0] === 'debug' ? 2 : 1,
  ).join(' '),
})

function runAction<T>({
  name,
  args,
  run,
}: {
  name: string
  args: string[]
  run(): T
}): T {
  const actions = workerScoped({
    commands: agentNotices({
      commands: supervisedCommands({
        commands: {
          [name]: guard({ handler: run }),
        },
      }),
    }),
  })

  return actions[name]!(args)
}

async function execute({ argv }: { argv: string[] }): Promise<unknown> {
  const [
    command,
    ...args
  ] = argv

  const subcommand = cliArguments({ argv }).tokens.find(token => token.kind === 'positional' && token.index > 0)

  if (command === 'task' && subcommand?.kind === 'positional' && subcommand.value === 'create') {
    const {
      values,
      hydraId,
    } = parse({
      args: args.filter((
        _,
        index,
      ) => index + 1 !== subcommand.index),
      options: CREATE_OPTIONS,
      positionals: 0,
    })
    required({
      value: values.title as string | undefined,
      what: '--title',
    })
    const output = await runAction({
      name: 'task',
      args,
      run: () => createCommand({
        hydraId,
        values,
        positionals: ['create'],
        meta: meta({ values }),
      }),
    })
    const card = output.card as { id: string } | undefined

    return {
      task: card?.id,
      event: output.event,
      launch: output.launch,
      worker: output.worker,
      code: output.code,
      blocker: output.blocker,
      notices: output.notices,
    }
  }

  if (command === 'send') {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        actor: { type: 'string' },
        reason: { type: 'string' },
        task: { type: 'string' },
        text: { type: 'string' },
        file: { type: 'string' },
        'idempotency-key': { type: 'string' },
      },
      positionals: 0,
    })

    if ((values.text === undefined) === (values.file === undefined)) {
      throw new HydraError({
        message: 'give either --text or --file',
        code: 'VALIDATION_ERROR',
      })
    }

    const file = values.file as string | undefined
    const text = file === undefined ? values.text as string : readInput({ file })
    const m = meta({ values })
    const task = values.task as string | undefined

    if (task !== undefined) {
      return {
        reply: await runAction({
          name: 'reply',
          args: [
            `--hydra=${hydraId}`,
            ...(values.actor ? [`--actor=${values.actor}`] : []),
            '--',
            task,
          ],
          run: () => sendReply({
            hydraId,
            request: {
              card: required({
                value: task,
                what: '--task',
              }),
              text,
              actor: m.actor,
              reason: m.reason,
              id: values['idempotency-key'] as string | undefined,
            },
          }),
        }),
      }
    }

    const output = await runAction({
      name: 'hydra',
      args: [
        'send',
        ...args,
      ],
      run: () => hydraSend({
        hydraId,
        values: {
          ...values,
          text,
          'event-id': values['idempotency-key'],
        },
      }),
    })

    return {
      message: output.message,
      state: output.state,
      delivery: output.delivery,
      notices: output.notices,
    }
  }

  if (command === 'answer') {
    parse({
      args,
      positionals: 2,
      options: {
        ...WRITE,
        text: { type: 'string' },
        choice: { type: 'string' },
        'from-message': { type: 'string' },
        undelivered: { type: 'boolean' },
      },
    })
    const output = await runAction({
      name: 'task',
      args: [
        'answer',
        ...args,
      ],
      run: () => taskCommand({
        args: [
          'answer',
          ...args,
        ],
      }),
    })

    return {
      event: output.event,
      card: output.card,
      reply: output.reply,
      duplicate: output.duplicate,
      state: output.state,
      sent: output.sent,
      detail: output.detail,
      recordError: output.recordError,
      notices: output.notices,
    }
  }

  if (command === 'board') {
    const { hydraId } = parse({
      args,
      options: COMMON,
      positionals: 0,
    })

    return home({ hydraId })
  }

  if (command === 'setup') {
    return runAction({
      name: 'setup',
      args,
      run: () => setup(args),
    })
  }

  if (command === 'debug' && subcommand?.kind === 'positional' && subcommand.value === 'health') {
    return runAction({
      name: 'debug',
      args,
      run: () => debug(args),
    })
  }

  const read = readCommand({ argv })

  if (read) {
    return read(args)
  }

  throw new HydraError({
    message: `unknown command: ${argv.join(' ')}`,
    code: 'VALIDATION_ERROR',
  })
}

function plain({
  value,
  prefix = '',
}: {
  value: unknown
  prefix?: string
}): string {
  if (value === undefined) {
    return ''
  }

  if (value === null || typeof value !== 'object') {
    return `${prefix}${String(value)}\n`
  }

  if (Array.isArray(value)) {
    return value.map(item => plain({
      value: item,
      prefix: `${prefix}- `,
    })).join('') || `${prefix}none\n`
  }

  return Object.entries(value).filter(([
    ,
    entry,
  ]) => entry !== undefined)
    .map(([
      key,
      entry,
    ]) => {
      if (entry !== null && typeof entry === 'object') {
        return `${prefix}${key}:\n${plain({
          value: entry,
          prefix: `${prefix}  `,
        })}`
      }

      return `${prefix}${key}: ${String(entry)}\n`
    })
    .join('')
}

export async function runCli({
  argv,
  stdout,
  stderr = stdout,
  remote = false,
}: {
  argv: string[]
  stdout: Writable
  stderr?: Writable
  remote?: boolean
}): Promise<void> {
  let json = argv.includes('--json')

  try {
    const parsed = cliArguments({ argv })
    json = parsed.json
    const args = parsed.argv
    requestInvocation().name = invocationOf({ argv: parsed.tokens.flatMap(token => token.kind === 'positional' ? [token.value] : []) }).name

    if (parsed.version) {
      stdout.write(json ? `${JSON.stringify({ version })}\n` : `${version}\n`)

      return
    }

    if (!args.length || parsed.help) {
      stdout.write(json ? `${JSON.stringify({ help: HELP })}\n` : HELP)

      return
    }

    const command = args[0]

    if (remote && (command === 'serve' || command === 'setup')) {
      throw new HydraError({
        message: `${command} must run in the local CLI`,
        code: 'VALIDATION_ERROR',
      })
    }

    if (remote && command === 'send' && parsed.tokens.some(token => token.kind === 'option' && token.name === 'file' && token.value !== '-')) {
      throw new HydraError({
        message: 'send file contents through stdin with --file -',
        code: 'VALIDATION_ERROR',
      })
    }

    let output = command === 'serve'
      ? await runAction({
        name: 'serve',
        args: args.slice(1),
        run: () => serve({
          args: args.slice(1),
          stdout,
          json,
        }),
      })
      : await withCommandNotices({ run: () => execute({ argv: args }) })

    if (output && typeof output === 'object' && !Array.isArray(output)) {
      output = Object.fromEntries(Object.entries(output).filter(([key]) => key !== 'help'))
    }

    if (output !== undefined) {
      stdout.write(json ? `${JSON.stringify(output)}\n` : plain({ value: output }))
    }
  } catch (error) {
    const argumentError = error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')
    let code = 'UNKNOWN'

    if (error instanceof HydraError) {
      code = error.code
    } else if (argumentError) {
      code = 'VALIDATION_ERROR'
    }

    const message = error instanceof Error ? error.message : String(error)
    const exitCode = code === 'VALIDATION_ERROR' ? 2 : 1
    recordExitCode({ code: exitCode })
    stderr.write(json ? `${JSON.stringify({
      error: message,
      code,
    })}\n` : `${code}: ${message}\n`)
  }
}

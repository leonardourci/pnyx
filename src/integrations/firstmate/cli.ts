import { AxiError } from 'axi-sdk-js'
import { COMMON, guard, parse, type Options, type Output } from '#app/cli-support.ts'
import { resolveHome } from './home.ts'
import { syncHome, watchHome, type SyncResult } from './sync.ts'

const HOMES: Options = {
  ...COMMON,
  home: {
    type: 'string',
    multiple: true,
  },
}

function homes({ values }: { values: Record<string, unknown> }): string[] {
  const list = (values.home as string[] | undefined) ?? []

  if (list.length === 0) {
    throw new AxiError(
      'missing --home',
      'VALIDATION_ERROR',
      ['Pass each Firstmate home with --home <path>'],
    )
  }

  return list.map(path => resolveHome({ path }))
}

function sync({
  hydraId,
  list,
}: {
  hydraId: string
  list: string[]
}): Output {
  const results = list.map(home => ({
    home,
    ...syncHome({
      hydraId,
      home,
    }),
  }))
  const ignored = results.filter(r => r.ignored).map(r => r.home)

  return {
    synced: results.map(({
      home,
      tasks,
      appended,
    }) => ({
      home,
      tasks,
      appended,
    })),
    ...(ignored.length ? { ignored: results.filter(r => r.ignored).map(r => `${r.home}: ${r.ignored}`) } : {}),
    help: [
      ...ignored.map(home => `Ignored ${home}: run \`pnyx-axi hydra set --firstmate ${home} --hydra ${hydraId}\` to make it this Hydra, or sync it into another Hydra`),
      'Run `pnyx-axi` to see the Hydra',
    ],
  }
}

export function watchHomes({
  hydraId,
  list,
}: {
  hydraId: string
  list: string[]
}): { close(): Output } {
  const totals = {
    syncs: 0,
    appended: 0,
    errors: 0,
  }
  const ignored = new Set<string>()
  let lastError: string | undefined

  const onSync = ({ home }: { home: string }) => ({ result }: { result: SyncResult | Error }) => {
    if (result instanceof Error) {
      totals.errors += 1
      lastError = result.message

      return
    }

    totals.syncs += 1
    totals.appended += result.appended

    if (result.ignored && !ignored.has(home)) {
      ignored.add(home)
      process.stdout.write(`ignored: ${JSON.stringify(`${home}: ${result.ignored}`)}\n`)
    }
  }

  const watches = list.map(home => watchHome({
    hydraId,
    home,
    onSync: onSync({ home }),
  }))

  return {
    close() {
      for (const w of watches) {
        w.close()
      }

      return {
        watched: list,
        ...totals,
        ...(ignored.size ? { ignored: [...ignored] } : {}),
        ...(lastError ? { lastError } : {}),
      }
    },
  }
}

async function watch({
  hydraId,
  list,
}: {
  hydraId: string
  list: string[]
}): Promise<Output> {
  const watches = watchHomes({
    hydraId,
    list,
  })
  await new Promise<void>(resolve => {
    process.once(
      'SIGINT',
      resolve,
    )
    process.once(
      'SIGTERM',
      resolve,
    )
  })

  return watches.close()
}

const firstmate = guard<Output | Promise<Output>>({
  handler: ({ args }) => {
    const [
      sub,
      ...rest
    ] = args

    if (sub !== 'sync' && sub !== 'watch') {
      throw new AxiError(
        `unknown firstmate command: ${sub ?? '(none)'}`,
        'VALIDATION_ERROR',
        ['Run `pnyx-axi firstmate sync --home <path>` or `pnyx-axi firstmate watch --home <path>`'],
      )
    }

    const {
      values,
      hydraId,
    } = parse({
      args: rest,
      options: HOMES,
      positionals: 0,
    })
    const list = homes({ values })

    return sub === 'sync' ? sync({
      hydraId,
      list,
    }) : watch({
      hydraId,
      list,
    })
  },
})

export const firstmateCommands = { firstmate }

const HELP: Record<string, string> = {
  firstmate: `usage: pnyx-axi firstmate sync|watch --home <path> [--home <path>]... [--hydra <name>]
Reads each Firstmate home's state/<task>.meta, state/<task>.status, data/backlog.md and
data/<task>/brief.md, never writing them. Each task becomes a card under the home's card: backlog
title, repo tag, pull request link, and open needs-decision or blocked keys, or a latest failed: or
blocked: line, as Needs you attention. Its needs-decision, resolved and done lines and the brief's
Captain's intent become the card's notes, each kept once. A task under the backlog's Done section
is recorded as done (a closed failure after a failed: line). sync folds the files once; watch syncs,
then again on every change until SIGINT or SIGTERM.
`,
}

export function firstmateHelp({ command }: { command: string }): string | undefined {
  return HELP[command]
}

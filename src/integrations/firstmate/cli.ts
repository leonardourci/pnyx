// pnyx-axi commands for the Firstmate integration: `firstmate sync|watch` and `reply`.
import { readFileSync } from 'node:fs'
import { AxiError } from 'axi-sdk-js'
import { COMMON, guard, meta, parse, required, type Options, type Output } from '../../cli/commands.ts'
import { resolveHome } from './home.ts'
import { sendReply } from './reply.ts'
import { syncHome, watchHome, type SyncResult } from './sync.ts'

const HOMES: Options = { ...COMMON, home: { type: 'string', multiple: true } }

function homes(values: Record<string, unknown>): string[] {
  const list = (values.home as string[] | undefined) ?? []

  if (list.length === 0) {
    throw new AxiError('missing --home', 'VALIDATION_ERROR', ['Pass each Firstmate home with --home <path>'])
  }

  return list.map(resolveHome)
}

function sync(board: string, list: string[]): Output {
  const results = list.map(home => ({ home, ...syncHome(board, home) }))

  return { synced: results, help: ['Run `pnyx-axi` to see the board'] }
}

// Runs until SIGINT or SIGTERM, then reports what it folded in.
async function watch(board: string, list: string[]): Promise<Output> {
  const totals = { syncs: 0, appended: 0, errors: 0 }
  let lastError: string | undefined

  const onSync = (result: SyncResult | Error) => {
    if (result instanceof Error) {
      totals.errors += 1
      lastError = result.message

      return
    }

    totals.syncs += 1
    totals.appended += result.appended
  }

  const watches = list.map(home => watchHome(board, home, onSync))
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })

  for (const w of watches) {
    w.close()
  }

  return { watched: list, ...totals, ...(lastError ? { lastError } : {}) }
}

const firstmate = guard<Output | Promise<Output>>(args => {
  const [sub, ...rest] = args

  if (sub !== 'sync' && sub !== 'watch') {
    throw new AxiError(`unknown firstmate command: ${sub ?? '(none)'}`, 'VALIDATION_ERROR', [
      'Run `pnyx-axi firstmate sync --home <path>` or `pnyx-axi firstmate watch --home <path>`',
    ])
  }

  const { values, board } = parse(rest, HOMES, 0)
  const list = homes(values)

  return sub === 'sync' ? sync(board, list) : watch(board, list)
})

const reply = guard(args => {
  const options: Options = {
    ...HOMES,
    actor: { type: 'string' },
    text: { type: 'string' },
    file: { type: 'string' },
    'idempotency-key': { type: 'string' },
    'resolve-key': { type: 'string' },
  }
  const { values, positionals, board } = parse(args, options, 1)
  const ref = required(positionals[0], 'card id')
  const file = values.file as string | undefined

  if ((values.text === undefined) === (file === undefined)) {
    throw new AxiError('give either --text or --file', 'VALIDATION_ERROR', ['Run `pnyx-axi reply --help`'])
  }

  let text = values.text as string | undefined

  if (file !== undefined) {
    try {
      text = readFileSync(file === '-' ? 0 : file, 'utf8')
    } catch (error) {
      throw new AxiError(`cannot read reply text from ${file}: ${(error as Error).message}`, 'VALIDATION_ERROR')
    }
  }

  const receipt = sendReply(board, {
    card: ref,
    text: text!,
    homes: homes(values),
    actor: meta(values).actor,
    ...(values['idempotency-key'] ? { id: values['idempotency-key'] as string } : {}),
    ...(values['resolve-key'] ? { resolveKey: values['resolve-key'] as string } : {}),
  })
  const out: Output = { reply: receipt }

  if (receipt.recordError && receipt.state === 'failed') {
    out.help = ['fm-send failed and nothing was delivered; once the cause is fixed, send again without --idempotency-key']
  } else if (receipt.recordError) {
    out.help = [
      `The send ended ${receipt.state} but was not recorded, so the board still shows it queued; check the task's inbox before sending again`,
    ]
  } else if (receipt.state === 'failed') {
    out.help = [`Fix the cause, then retry with --idempotency-key ${receipt.reply}`]
  } else if (receipt.state === 'delivery_unknown') {
    out.help = ["The message may have landed; confirm on the card and in the task's inbox before sending again, a retry with the same key does not resend"]
  } else if (receipt.state === 'queued') {
    out.help = ["Check the task's inbox before sending again; a retry with the same key does not resend"]
  } else {
    out.help = [`Run \`pnyx-axi history --card ${receipt.card} --kind replied\` for its receipts`]
  }

  return out
})

export const firstmateCommands = { firstmate, reply }

const HELP: Record<string, string> = {
  firstmate: `usage: pnyx-axi firstmate sync|watch --home <path> [--home <path>]... [--board <name>]
Reads each Firstmate home's state/<task>.meta, state/<task>.status, data/backlog.md and
data/<task>/brief.md, never writing them. Each task becomes a card under the home's card: backlog
title, repo tag, pull request link, and open needs-decision or blocked keys, or a latest failed: or
blocked: line, as Needs you attention. Its needs-decision, resolved and done lines and the brief's
Captain's intent become the card's notes, each kept once. A task under the backlog's Done section
is recorded as done (a closed failure after a failed: line). sync folds the files once; watch syncs,
then again on every change until SIGINT or SIGTERM.
`,
  reply: `usage: pnyx-axi reply <id> --text <text> | --file <file|-> --home <path> [--resolve-key <key>] [--idempotency-key <key>]
Sends the text to the card's Firstmate task through the home's bin/fm-send.sh, with FM_HOME set.
--resolve-key answers that open decision. The card's home must be passed with --home.
Receipts: queued, then delivered, delivery_unknown or failed. Retrying the same --idempotency-key
resends only after a failed send.
`,
}

export function firstmateHelp(command: string): string | undefined {
  return HELP[command]
}

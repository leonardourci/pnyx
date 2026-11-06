import { AxiError } from 'axi-sdk-js'
import { readInput } from '#app/request-context.ts'
import { loadHydra } from '#app/store.ts'
import { COMMON, guard, meta, parse, required, type Options, type Output } from '#app/cli-support.ts'
import { invalid, sendReply, type ReplyRequest } from './reply.ts'

export const reply = guard({
  handler: async ({ args }) => {
    const options: Options = {
      ...COMMON,
      home: {
        type: 'string',
        multiple: true,
      },
      actor: { type: 'string' },
      text: { type: 'string' },
      file: { type: 'string' },
      'idempotency-key': { type: 'string' },
      'resolve-key': { type: 'string' },
      answer: { type: 'string' },
      json: { type: 'string' },
      seen: { type: 'string' },
      'task-message': { type: 'boolean' },
      question: { type: 'string' },
      'from-message': { type: 'string' },
      choice: { type: 'string' },
    }
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 1,
    })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })

    const question = values.question as string | undefined
    const fromMessage = values['from-message'] as string | undefined
    const choice = values.choice as string | undefined

    if (question !== undefined || fromMessage !== undefined || choice !== undefined) {
      if (!question || !fromMessage) {
        throw invalid({ message: '--question and --from-message are required together' })
      }

      if (values.answer !== undefined || values['resolve-key'] !== undefined || values['task-message']) {
        throw invalid({ message: '--question cannot be combined with --answer, --resolve-key or --task-message' })
      }
    }

    if (values['task-message'] && (values.answer !== undefined || values['resolve-key'] !== undefined)) {
      throw invalid({ message: '--task-message takes context text; answer requests with reply --answer or --resolve-key' })
    }

    const file = values.file as string | undefined
    const request = values.answer as string | undefined
    let answer: ReplyRequest['answer']

    if (request !== undefined) {
      if (values.text !== undefined || file !== undefined || values.json === undefined) {
        throw new AxiError(
          '--answer takes --json with the answer, not --text or --file',
          'VALIDATION_ERROR',
          ['Run `pnyx-axi reply --help`'],
        )
      }

      try {
        const seen = values.seen as string | undefined
        const value: unknown = JSON.parse(values.json as string)
        answer = {
          request,
          value,
          ...(seen !== undefined ? { seen } : {}),
        }
      } catch {
        throw new AxiError(
          '--json is not valid JSON',
          'VALIDATION_ERROR',
          ['Example: --json \'{"choice":"allow"}\''],
        )
      }
    } else if (values.json !== undefined || values.seen !== undefined) {
      throw new AxiError(
        '--json and --seen go with --answer',
        'VALIDATION_ERROR',
        ['Run `pnyx-axi reply --help`'],
      )
    } else if ((values.text === undefined) === (file === undefined)) {
      throw new AxiError(
        'give either --text or --file',
        'VALIDATION_ERROR',
        ['Run `pnyx-axi reply --help`'],
      )
    }

    let text = (values.text as string | undefined) ?? (answer ? '' : undefined)

    if (file !== undefined) {
      try {
        text = readInput({ file: file })
      } catch (error) {
        throw new AxiError(
          `cannot read reply text from ${file}: ${(error as Error).message}`,
          'VALIDATION_ERROR',
        )
      }
    }

    const send = values['task-message'] ? (await import('./task-message.ts')).sendTaskMessage : sendReply
    const receipt = await send({
      hydraId,
      request: {
        card: ref,
        text: text!,
        homes: (values.home as string[] | undefined) ?? [],
        actor: meta({ values }).actor,
        reason: meta({ values }).reason,
        ask: question ? {
          id: question,
          fromMessage,
          choice,
        } : undefined,
        ...(values['idempotency-key'] ? { id: values['idempotency-key'] as string } : {}),
        ...(values['resolve-key'] ? { resolveKey: values['resolve-key'] as string } : {}),
        ...(answer ? { answer } : {}),
      },
    })
    const out: Output = { reply: receipt }
    const current = loadHydra({ hydraId }).state.cards[receipt.card]
    const savedAnswer = current?.replies?.find(saved => saved.id === receipt.reply
      && saved.accepted)
    const source = savedAnswer?.decision?.fromMessage

    if (savedAnswer?.answers && source) {
      const help = [`Owner answer recorded; delivery ${receipt.state}. The saved decision is unchanged.`]
      const recordError = 'recordError' in receipt ? receipt.recordError : undefined

      if (receipt.state === 'failed' && !recordError) {
        help.push(`Retry with reply ${receipt.card} --text "Resend saved answer" --idempotency-key ${receipt.reply}`)
      } else if (receipt.state !== 'delivered' || recordError) {
        help.push(`Check the worker's session. Only if it never arrived, run task answer ${receipt.card} ${savedAnswer.answers} --from-message ${source.id} --event-id ${receipt.reply} --undelivered --reason "Retry saved delivery" --hydra ${hydraId}`)
      }

      out.help = help

      return out
    }

    if ('recordError' in receipt && receipt.recordError && receipt.state === 'failed') {
      out.help = ['The send failed and nothing was delivered; once the cause is fixed, send again without --idempotency-key']
    } else if ('recordError' in receipt && receipt.recordError) {
      out.help = [`The send ended ${receipt.state} but was not recorded, so the Hydra still shows it queued; check the task's inbox or the session before sending again`]
    } else if (current?.steering
      ?.some(message => message.reply === receipt.reply)
      && receipt.state !== 'delivered') {
      out.help = [`Instruction ${receipt.reply} is saved in the task inbox until the worker acknowledges it. Pending IDs replay when the worker opens or resumes; held workers wait for release. Retry with the same key to preserve its identity.`]
    } else if (receipt.state === 'failed') {
      out.help = [`Fix the cause, then retry with --idempotency-key ${receipt.reply}`]
    } else if (receipt.state === 'delivery_unknown') {
      out.help = ['The message may have landed; a retry with the same key does not resend. When its session has a transcript, Pnyx checks it once the session is idle and resends a missing message up to twice itself']
    } else if (receipt.state === 'queued') {
      out.help = ["Check the task's inbox or the session before sending again; a retry with the same key does not resend"]
    } else {
      out.help = [`Run \`pnyx-axi history --card ${receipt.card} --kind replied\` for its receipts`]
    }

    return out
  },
})

export const REPLY_HELP = `usage: pnyx-axi reply <id> --text <text> | --file <file|-> [--home <path>]... [--resolve-key <key>] [--idempotency-key <key>] [--task-message]
       pnyx-axi reply <task> --question <question> --from-message <owner-message> [--choice Go|Hold|Merge] --text <relay> [--idempotency-key <key>]
       pnyx-axi reply <id> --answer <request key> --json <answer> [--seen <request id>] [--idempotency-key <key>]
--question records an owner answer and its outgoing relay together before attempting delivery. Hydra
must name an owner message newer than the question; Go/Hold and Merge/Hold also take --choice.
The source words stay separate from --text. Failed, queued or unknown delivery does not reopen the
question. Retry a failed delivery with the same key to preserve its saved answer and relay.
--question cannot be combined with --answer, --resolve-key or --task-message. Ordinary replies do
not answer task questions.
A Firstmate task card replies through its home's bin/fm-send.sh, with FM_HOME set; its home must
be passed with --home, and --resolve-key answers that open decision.
--task-message also queues the text for Hydra with its task reference and returns both route receipts; without an agent, only Hydra is addressed. An agent Pnyx runs (task start)
gets an inbox notice from the Hydra's server after the instruction is persisted. Pending IDs survive
a stopped server and replay on worker opening or resumption until read or explicitly acknowledged.
A worker inbox read records receipt and stops reminders; acknowledgements never mean work is complete. Native tasks reached
through Paseo also receive inbox notices through its agent API. A terminal task receives a notice
only with a verified live process and empty tmux composer. Drafts and permission prompts defer it;
other terminal backends report uncertainty without typing. Timed recovery allows three notifications
or two busy/held deferrals before one durable unread-instruction result wakes Hydra. Holds stay held.
Unattached sessions and dedicated native commands retain their direct delivery routes.
Receipts: queued, then delivered, delivery_unknown or failed. Retrying the same --idempotency-key
resends only after a failed send.
--answer answers an agent's open question, permission, plan or MCP form prompt (its request key, from
\`pnyx-axi card <id>\`) by pressing the keys that prompt expects in the session's tmux pane (other
terminals are answered in the session itself):
  question:   --json '{"answers":[{"pick":[2]},{"pick":[1,3]},{"text":"free text"}]}'  one per question,
              options numbered from 1; text only for a single-choice question
  permission: --json '{"choice":"allow"}' or '{"choice":"deny","text":"do this instead"}'
  plan:       --json '{"choice":"approve"}' or '{"choice":"revise","text":"what to change"}'
  MCP form:   --json '{"choice":"accept","values":{"name":"Ada","count":2,"agree":true}}' or '{"choice":"decline"}'
--seen refuses the answer when the request changed since that id was shown. A delivered answer marks
the request answered; the session's own hooks close it once it moves on.
`

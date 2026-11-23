import { HydraError } from '#store/errors.ts'
import { readInput } from '#app/request-context.ts'
import { loadHydra } from '#app/store.ts'
import { COMMON, guard, meta, parse, required, type Options, type Output } from '#app/cli-support.ts'
import { invalid, sendReply, type ReplyRequest } from './reply.ts'

export const reply = guard({
  handler: async ({ args }) => {
    const options: Options = {
      ...COMMON,
      actor: { type: 'string' },
      text: { type: 'string' },
      file: { type: 'string' },
      'idempotency-key': { type: 'string' },
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

      if (values.answer !== undefined || values['task-message']) {
        throw invalid({ message: '--question cannot be combined with --answer or --task-message' })
      }
    }

    if (values['task-message'] && values.answer !== undefined) {
      throw invalid({ message: '--task-message takes context text; answer requests with reply --answer' })
    }

    const file = values.file as string | undefined
    const request = values.answer as string | undefined
    let answer: ReplyRequest['answer']

    if (request !== undefined) {
      if (values.text !== undefined || file !== undefined || values.json === undefined) {
        throw new HydraError({
          message: '--answer takes --json with the answer, not --text or --file',
          code: 'VALIDATION_ERROR',
        })
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
        throw new HydraError({
          message: '--json is not valid JSON',
          code: 'VALIDATION_ERROR',
          help: ['Example: --json \'{"choice":"allow"}\''],
        })
      }
    } else if (values.json !== undefined || values.seen !== undefined) {
      throw new HydraError({
        message: '--json and --seen go with --answer',
        code: 'VALIDATION_ERROR',
      })
    } else if ((values.text === undefined) === (file === undefined)) {
      throw new HydraError({
        message: 'give either --text or --file',
        code: 'VALIDATION_ERROR',
      })
    }

    let text = (values.text as string | undefined) ?? (answer ? '' : undefined)

    if (file !== undefined) {
      try {
        text = readInput({ file: file })
      } catch (error) {
        throw new HydraError({
          message: `cannot read reply text from ${file}: ${(error as Error).message}`,
          code: 'VALIDATION_ERROR',
        })
      }
    }

    const send = values['task-message'] ? (await import('./task-message.ts')).sendTaskMessage : sendReply
    const receipt = await send({
      hydraId,
      request: {
        card: ref,
        text: text!,
        actor: meta({ values }).actor,
        reason: meta({ values }).reason,
        ask: question ? {
          id: question,
          fromMessage,
          choice,
        } : undefined,
        ...(values['idempotency-key'] ? { id: values['idempotency-key'] as string } : {}),
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
      out.help = [`Read tasks/${receipt.card}/task.log in Hydra ${hydraId} or inspect the session before sending again. A retry with the same key does not resend.`]
    } else {
      out.help = [`Read tasks/${receipt.card}/task.log in Hydra ${hydraId} for its receipts`]
    }

    return out
  },
})

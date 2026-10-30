import { fail } from './protocol.ts'
import type { ToHost, Fact, SessionRef } from './protocol.ts'

const object = ({ value }: { value: unknown }): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const string = ({ value }: { value: unknown }) => typeof value === 'string'
const name = ({ value }: { value: unknown }) => typeof value === 'string' && value.length > 0
const integer = ({ value }: { value: unknown }) => Number.isSafeInteger(value) && Number(value) >= 0

const strings = ({ value }: { value: unknown }) => {
  const fields = object({ value })

  return fields !== undefined && Object.values(fields).every(value => string({ value }))
}

const ref = ({ value }: { value: unknown }) => {
  const fields = object({ value })

  return fields !== undefined && name({ value: fields.id }) && name({ value: fields.epoch })
}

const provider = ({ value }: { value: unknown }) => value === 'claude-code' || value === 'codex'
const list = ({ value }: { value: unknown }) =>
  Array.isArray(value) && value.every(value => string({ value }))
const optional = ({
  value,
  valid,
}: {
  value: unknown
  valid({ value }: { value: unknown }): unknown
}) =>
  value === undefined || Boolean(valid({ value }))

export function readFrame({ text }: { text: string }): ToHost {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return fail({
      code: 'INVALID_FRAME',
      message: 'Expected a JSON native host message',
    })
  }

  const frame = object({ value })

  if (!frame) {
    return fail({
      code: 'INVALID_FRAME',
      message: 'Expected a native host message object',
    })
  }

  let valid = false

  if (frame.type === 'hello') {
    valid = integer({ value: frame.protocol })
      && name({ value: frame.installation })
      && name({ value: frame.token })
      && optional({
        value: frame.capabilities,
        valid: list,
      })
  } else if (frame.type === 'result') {
    valid = name({ value: frame.id }) && name({ value: frame.requestId })
  } else if (frame.type === 'watch') {
    valid = ref({ value: frame.ref }) && optional({
      value: frame.after,
      valid: integer,
    })
  } else if (frame.type === 'ack') {
    valid = name({ value: frame.id })
      && ref({ value: frame.ref })
      && name({ value: frame.controller })
      && integer({ value: frame.appliedFactsThrough })
  } else if (frame.type === 'call' && name({ value: frame.id })) {
    const op = object({ value: frame.operation })
    const scope = object({ value: op?.scope })
    const options = object({ value: op?.options })

    if (op?.kind === 'status') {
      valid = true
    } else if (op?.kind === 'shutdown') {
      valid = name({ value: op.controller }) && op.when === 'quiescent'
    } else if (op?.kind === 'attach' && scope) {
      valid = integer({ value: op.expectedRevision }) && (scope.kind === 'host'
        || scope.kind === 'session' && ref({ value: scope.ref }))
    } else if (op?.kind === 'open' && options) {
      const resume = object({ value: options.resume })
      valid = name({ value: op.controller })
      && provider({ value: options.provider })
      && name({ value: options.cwd })
        && strings({ value: options.settings }) && strings({ value: options.environment })
        && optional({
          value: options.context,
          valid: string,
        })
        && optional({
          value: options.instructions,
          valid: string,
        })
        && optional({
          value: options.outputSchema,
          valid: object,
        })
        && optional({
          value: options.allow,
          valid: list,
        })
        && (options.resume === undefined || Boolean(resume && name({ value: resume.nativeId })
          && optional({
            value: resume.path,
            valid: string,
          })))
    } else if (op?.kind === 'catalog') {
      valid = provider({ value: op.provider })
      && name({ value: op.cwd })
      && strings({ value: op.environment })
    } else if (op?.kind === 'commands') {
      valid = ref({ value: op.ref })
    } else if (op && ref({ value: op.ref }) && name({ value: op.controller })) {
      const input = object({ value: op.input })
      const decision = object({ value: op.decision })

      if (op.kind === 'input' && input) {
        valid = name({ value: input.id })
      && string({ value: input.text })
      && Array.isArray(input.images)
          && input.images.every(value => {
            const image = object({ value })

            return image && name({ value: image.path }) && name({ value: image.digest })
              && [
                'image/png',
                'image/jpeg',
                'image/gif',
                'image/webp',
              ].includes(String(image.mediaType))
          })
      } else if (op.kind === 'answer' && decision) {
        const values = object({ value: decision.values })
        const allow = decision.behavior === 'allow'
          && (decision.answers === undefined || Array.isArray(decision.answers)
            && decision.answers.every(value => list({ value })))
          && (decision.values === undefined || values !== undefined
            && Object.values(values).every(value =>
              [
                'string',
                'number',
                'boolean',
              ].includes(typeof value)))
        const deny = decision.behavior === 'deny' && string({ value: decision.message })
        valid = name({ value: op.answerId }) && name({ value: op.permission }) && (allow || deny)
      } else if (op.kind === 'interrupt') {
        valid = name({ value: op.expectedTurn })
      } else if (op.kind === 'set') {
        valid = name({ value: op.setting }) && string({ value: op.value })
      } else if (op.kind === 'context') {
        valid = string({ value: op.text })
      } else if (op.kind === 'close') {
        valid = typeof op.expectedIdle === 'boolean'
      }
    }
  }

  if (!valid) {
    return fail({
      code: 'INVALID_FRAME',
      message: 'Unknown or malformed native host message',
    })
  }

  // All dispatcher variants are validated before this narrowing.
  return frame as ToHost
}

export function readFact({
  value,
  session,
}: {
  value: unknown
  session: SessionRef
}): Fact {
  const row = object({ value })
  const identity = object({ value: row?.ref })
  const event = object({ value: row?.event })
  let valid = false

  if (event?.type === 'input' || event?.type === 'answer') {
    const receipt = object({ value: event.receipt })
    const phases = event.type === 'input'
      ? [
        'queued',
        'taken',
        'confirmed',
        'carried',
        'settled',
        'unknown',
      ]
      : [
        'received',
        'submitted',
        'aborted',
        'failed',
        'unknown',
      ]
    valid = receipt !== undefined && phases.includes(String(receipt.phase))
      && name({ value: event.type === 'input' ? receipt.inputId : receipt.answerId })
      && (event.type === 'input' || name({ value: receipt.permission }))
  } else if (event?.type === 'turn-ended') {
    const outcome = object({ value: event.outcome })
    valid = outcome !== undefined && name({ value: outcome.turn })
      && list({ value: outcome.inputIds })
      && string({ value: outcome.at }) && [
      'completed',
      'interrupted',
      'failed',
    ].includes(String(outcome.status))
      && Array.isArray(outcome.assistant) && outcome.assistant.every(value => {
      const text = object({ value })

      return text && name({ value: text.id }) && string({ value: text.text })
    })
  } else if (event?.type === 'permission') {
    const request = object({ value: event.request })
    valid = request !== undefined && name({ value: request.id }) && name({ value: request.tool })
      && object({ value: request.input }) !== undefined
  } else if (event?.type === 'permission-ended') {
    valid = name({ value: event.id })
  } else if (event?.type === 'ended') {
    valid = event.reason === 'closed' || event.reason === 'failed'
  } else if (event?.type === 'structured') {
    valid = 'value' in event
  } else if (event?.type === 'compaction') {
    valid = name({ value: event.id }) && [
      'running',
      'done',
      'failed',
      'cancelled',
    ].includes(String(event.state))
      && [
        'manual',
        'auto',
      ].includes(String(event.trigger))
  }

  if (!valid || !row || identity?.id !== session.id || identity?.epoch !== session.epoch
    || !integer({ value: row.seq }) || row.seq === 0 || !name({ value: row.at })) {
    return fail({
      code: 'RECOVERY_REQUIRED',
      message: 'Unrecognized native outbox fact; preserve it for reconciliation',
    })
  }

  // The envelope and the closed critical event variants are checked above.
  return row as Fact
}

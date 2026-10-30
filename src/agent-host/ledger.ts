import { deferred } from './deferred.ts'
import { createHash } from 'node:crypto'
import type { Operation, Result, SessionRef } from './protocol.ts'
import { errorResult, fail } from './protocol.ts'

const MAX_REQUESTS = 10000
const CONTROL_RESERVE = 1000

function ordered({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) {
    return value.map(item => ordered({ value: item }))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort((
      [left],
      [right],
    ) => left.localeCompare(right))
      .map(([
        key,
        item,
      ]) => [
        key,
        ordered({ value: item }),
      ]))
  }

  return value
}

export const fingerprint = ({ value }: { value: unknown }) =>
  createHash('sha256').update(JSON.stringify(ordered({ value })))
    .digest('hex')

export function requestLedger({ intact }: { intact: boolean }) {
  const entries = new Map<string, {
    fingerprint: string
    result?: Result
    pending: Promise<Result>
  }>()

  return {
    async call({
      id,
      operation,
      run,
    }: {
      id: string
      operation: Operation
      run(): Promise<Result>
    }) {
      let identity: unknown = operation

      if ('controller' in operation) {
        const payload = Object.fromEntries(Object.entries(operation).filter(([key]) => key !== 'controller'))
        identity = payload

        if (operation.kind === 'answer') {
          // Secret values have no fingerprint; this ID records delivery without retaining values.
          identity = {
            kind: operation.kind,
            ref: operation.ref,
            answerId: operation.answerId,
            permission: operation.permission,
            behavior: operation.decision.behavior,
          }
        }
      }

      const identityHash = fingerprint({ value: identity })
      const previous = entries.get(id)

      if (previous) {
        if (previous.fingerprint !== identityHash) {
          fail({
            code: 'CONFLICTING_ID',
            message: 'This request ID was used for a different operation',
          })
        }

        if (previous.result) {
          return structuredClone(previous.result)
        }

        return previous.pending
      }

      const admission = operation.kind === 'open' || operation.kind === 'input'

      if (entries.size >= MAX_REQUESTS + (admission ? 0 : CONTROL_RESERVE)) {
        fail({
          code: 'LEDGER_FULL',
          message: 'The request ledger is full; reconcile before admitting more work',
        })
      }

      const completion = deferred<Result>()
      const entry = {
        fingerprint: identityHash,
        pending: completion.promise,
        result: undefined as Result | undefined,
      }
      entries.set(
        id,
        entry,
      )

      try {
        entry.result = await run()
      } catch (error) {
        entry.result = errorResult({ error })
      }

      completion.resolve(entry.result)

      return entry.result
    },
    closed({ ref }: { ref: SessionRef }) {
      for (const entry of entries.values()) {
        if (entry.result?.kind === 'opened' && entry.result.session.ref.id === ref.id && entry.result.session.ref.epoch === ref.epoch) {
          entry.result.session.phase = 'closed'
        }
      }
    },
    update({
      id,
      result,
    }: {
      id: string
      result: Result
    }) {
      const entry = entries.get(id)

      if (entry) {
        entry.result = structuredClone(result)
      }
    },
    lookup({ id }: { id: string }): Result {
      const entry = entries.get(id)

      if (entry?.result) {
        return structuredClone(entry.result)
      }

      if (entry) {
        return {
          kind: 'error',
          code: 'IN_FLIGHT',
          message: 'The native operation is still settling',
        }
      }

      if (!intact) {
        return {
          kind: 'error',
          code: 'UNKNOWN',
          message: 'An earlier host epoch may have received this request',
        }
      }

      return {
        kind: 'error',
        code: 'NOT_RECEIVED',
        message: 'This host has never admitted this request ID',
      }
    },
  }
}

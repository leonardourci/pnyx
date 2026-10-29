import { existsSync, readFileSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { privateDir, writeDurably } from '#store/storage.ts'
import { eventClass } from '#workers/native-session.ts'
import type { HostedEvent, HostedUsage } from '#workers/provider.ts'
import type { Fact, EventFrame, Summary, Snapshot } from './protocol.ts'
import { fail } from './protocol.ts'
import { readFact } from './validation.ts'

const VIEW_EVENTS = 256
const VIEW_BYTES = 1024 * 1024
const CRITICAL_BYTES = 8 * 1024 * 1024
const EMERGENCY_BYTES = 2 * 1024 * 1024
export type OutputLimits = {
  viewEvents: number
  viewBytes: number
  criticalBytes: number
  emergencyBytes: number
}
const DEFAULT_LIMITS: OutputLimits = {
  viewEvents: VIEW_EVENTS,
  viewBytes: VIEW_BYTES,
  criticalBytes: CRITICAL_BYTES,
  emergencyBytes: EMERGENCY_BYTES,
}

export function replaceFile({
  path,
  text,
}: {
  path: string
  text: string
}) {
  const stage = `${path}.next`
  writeDurably({
    path: stage,
    data: text,
    flag: 'w',
  })
  renameSync(
    stage,
    path,
  )
  const fd = openSync(
    join(
      path,
      '..',
    ),
    'r',
  )

  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function output({
  directory,
  session,
  limits = DEFAULT_LIMITS,
}: {
  directory: string
  session: Summary
  limits?: OutputLimits
}) {
  privateDir({ dir: directory })
  const path = join(
    directory,
    'outbox.jsonl',
  )
  const descriptor = join(
    directory,
    'session.json',
  )
  let sequence = 0, acknowledged = 0, durableBytes = 0, emergencyBytes = 0
  let retention: Snapshot['retention'] = 'healthy'
  let facts: Fact[] = []
  const raw: EventFrame[] = []
  let rawBytes = 0
  const text = new Map<string, string>()
  const tools = new Set<string>(), thinking = new Set<string>()
  let activity: Snapshot['activity']
  let usage: Snapshot['usage']
  const listeners = new Set<({ frame }: { frame: EventFrame }) => void>()

  if (existsSync(path)) {
    try {
      const saved = readFileSync(
        path,
        'utf8',
      )
      const lines = saved.split('\n').filter(Boolean)
      let previous = 0

      for (const [
        index,
        line,
      ] of lines.entries()) {
        const row = JSON.parse(line)

        if (row.kind === 'checkpoint' && index === 0 && Number.isSafeInteger(row.acknowledged)
          && row.acknowledged >= 0 && Number.isSafeInteger(row.through)
          && row.through >= row.acknowledged) {
          acknowledged = row.acknowledged
          sequence = row.through
          previous = acknowledged
        } else {
          const fact = readFact({
            value: row,
            session: session.ref,
          })

          if (fact.seq <= previous) {
            fail({
              code: 'RECOVERY_REQUIRED',
              message: 'Native outbox facts are not ordered',
            })
          }

          facts.push(fact)
          previous = fact.seq
          sequence = Math.max(
            sequence,
            fact.seq,
          )
        }
      }

      durableBytes = Buffer.byteLength(saved)
    } catch {
      fail({
        code: 'RECOVERY_REQUIRED',
        message: 'The native outbox is unreadable; preserve it for reconciliation',
      })
    }
  } else {
    replaceFile({
      path: descriptor,
      text: JSON.stringify(session),
    })
    writeDurably({
      path,
      data: '',
      flag: 'w',
    })
  }

  const persist = () => {
    const checkpoint = JSON.stringify({
      kind: 'checkpoint',
      through: sequence,
      acknowledged,
    })
    const lines = facts.map(fact => JSON.stringify(fact))
    const saved = `${[
      checkpoint,
      ...lines,
    ].join('\n')}\n`
    replaceFile({
      path,
      text: saved,
    })
    durableBytes = Buffer.byteLength(saved)
    emergencyBytes = 0
    retention = durableBytes < limits.criticalBytes ? 'healthy' : 'degraded'
  }

  return {
    summary: session,
    pending: () => structuredClone(facts),
    through: () => sequence,
    retention: () => retention,
    canAdmit: () => retention === 'healthy' && durableBytes < limits.criticalBytes,
    save() {
      replaceFile({
        path: descriptor,
        text: JSON.stringify(session),
      })
    },
    publish({ event }: { event: HostedEvent }) {
      const frame: EventFrame = {
        type: 'event',
        ref: session.ref,
        seq: ++sequence,
        at: new Date().toISOString(),
        event: structuredClone(event),
      }

      if (eventClass({ event }) === 'critical') {
        // The classifier is type constrained; critical entries have object event variants.
        const fact: Fact = {
          ref: frame.ref,
          seq: frame.seq,
          at: frame.at,
          event: event as Fact['event'],
        }
        const line = `${JSON.stringify(fact)}\n`
        const bytes = Buffer.byteLength(line)
        facts.push(structuredClone(fact))

        try {
          if (retention !== 'healthy' || durableBytes + bytes > limits.criticalBytes) {
            fail({
              code: 'RETENTION_PRESSURE',
              message: 'The critical outbox reached its reserved capacity',
            })
          }

          writeDurably({
            path,
            data: line,
            flag: 'a',
          })
          durableBytes += bytes
        } catch {
          emergencyBytes += bytes
          retention = emergencyBytes >= limits.emergencyBytes ? 'exhausted' : 'degraded'
        }
      } else {
        raw.push(frame)
        rawBytes += Buffer.byteLength(JSON.stringify(frame))

        while (raw.length > limits.viewEvents || rawBytes > limits.viewBytes) {
          const expired = raw.shift()!
          rawBytes -= Buffer.byteLength(JSON.stringify(expired))
        }
      }

      if (typeof event === 'string') {
        activity = event

        if (event === 'working') {
          text.clear()
        }
      } else if (event.type === 'text') {
        const previous = event.append ? text.get(event.id) ?? '' : ''
        const updated = Buffer.from(previous + event.text)
        text.set(
          event.id,
          updated.subarray(-limits.viewBytes).toString('utf8'),
        )
        let bytes = [...text.values()].reduce(
          (
            sum,
            value,
          ) => sum + Buffer.byteLength(value),
          0,
        )

        while (text.size > limits.viewEvents || bytes > limits.viewBytes) {
          const oldest = text.keys().next().value!
          bytes -= Buffer.byteLength(text.get(oldest)!)
          text.delete(oldest)
        }
      } else if (event.type === 'usage') {
        const update: Partial<HostedUsage> = { ...event }
        delete update.type
        usage = {
          ...usage,
          ...update,
        }
      } else if (event.type === 'tool' || event.type === 'thinking') {
        const running = event.type === 'tool' ? tools : thinking

        if (event.running) {
          if (running.size < limits.viewEvents) {
            running.add(event.id)
          }
        } else {
          running.delete(event.id)
        }
      }

      for (const listener of listeners) {
        listener({ frame })
      }

      return frame
    },
    acknowledge({
      through,
      delivered,
    }: {
      through: number
      delivered: Set<number>
    }) {
      if (through === acknowledged) {
        return
      }

      const target = facts.find(fact => fact.seq === through)
      const prefix = facts.filter(fact => fact.seq <= through)
      const ordered = through > acknowledged && prefix.every(fact => delivered.has(fact.seq))

      if (!target || !ordered) {
        fail({
          code: 'INVALID_ACK',
          message: 'Acknowledge only a delivered contiguous prefix of critical facts',
        })
      }

      const before = facts
      const previous = acknowledged
      facts = facts.filter(fact => fact.seq > through)
      acknowledged = through

      try {
        persist()
      } catch (error) {
        facts = before
        acknowledged = previous
        retention = 'degraded'
        throw error
      }
    },
    baseline({ native }: { native?: Snapshot['native'] }): Snapshot {
      return structuredClone({
        session,
        native,
        text: [...text].map(([
          id,
          value,
        ]) => ({
          id,
          text: value,
        })),
        tools: [...tools],
        thinking: [...thinking],
        activity,
        usage,
        retention,
      })
    },
    expired({ after }: { after: number }) {
      const earliest = raw[0]?.seq ?? sequence + 1

      return after < earliest - 1 && after < sequence
    },
    subscribe({ listener }: { listener({ frame }: { frame: EventFrame }): void }) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
  }
}

export type Output = ReturnType<typeof output>

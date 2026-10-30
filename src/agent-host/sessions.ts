import { HydraError } from '#store/errors.ts'
import { deferred } from './deferred.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { privateDir } from '#store/storage.ts'
import { eventClass, nativeIdle } from '#workers/native-session.ts'
import type { HostedEvent, HostedInput, HostedSession, PermissionDecision, Provider } from '#workers/provider.ts'
import { output, replaceFile, type Output, type OutputLimits } from './output.ts'
import { requestLedger, fingerprint } from './ledger.ts'
import { serial } from './serial.ts'
import { verifiedBootChange } from './boot.ts'
import { endGroup, nativeGroup } from './groups.ts'
import { PROTOCOL, CAPABILITIES, fail } from './protocol.ts'
import type { AnswerReceipt, Grant, Maintenance, Mutation, Operation, PendingPermission, ProviderId, Result, Scope, SessionRef, Summary, ToClient, ToHost } from './protocol.ts'

const CONTROL_TIMEOUT_MS = 30000
const MAX_SESSIONS = 64
const MAX_GROUPS = 64
const MAX_INPUTS = 9000
const MAX_QUEUED_INPUT_BYTES = 16 * 1024 * 1024
export type Peer = {
  id: string
  send({ frame }: { frame: ToClient }): boolean
}
type Controller = {
  revision: number
  generation?: string
  peer?: string
  queue: ReturnType<typeof serial>
  delivered: Set<number>
}
type Session = {
  output: Output
  control: Controller
  native?: HostedSession
  context: string
  uncertain: Set<string>
  abort: AbortController
  operations: number
  incoming: HostedInput[]
  incomingBytes: number
  changed: ReturnType<typeof deferred<void>>
  pending: Map<string, PendingPermission>
  inputs: Map<string, string>
  answers: Map<string, {
    requestId: string
    receipt: AnswerReceipt
    submitted: ReturnType<typeof deferred<void>>
  }>
  finished: ReturnType<typeof deferred<void>>
}
const controller = (): Controller => ({
  revision: 0,
  queue: serial(),
  delivered: new Set(),
})

export async function hostSessions({
  directory,
  providers,
  build,
  limits,
  controlTimeout = CONTROL_TIMEOUT_MS,
  boot,
}: {
  directory: string
  providers: Record<ProviderId, Provider>
  build: string
  limits?: OutputLimits
  controlTimeout?: number
  boot?: string
}) {
  const instance = randomUUID()
  const sessions = new Map<string, Session>()
  const hostControl = controller()
  const answerIds = new Map<string, {
    session: string
    permission: string
  }>()
  const root = join(
    directory,
    'sessions',
  )
  privateDir({ dir: root })
  const ledgerPath = join(
    directory,
    'ledger.json',
  )
  const previous = existsSync(ledgerPath) ? JSON.parse(readFileSync(
    ledgerPath,
    'utf8',
  )) as {
    instance: string
    clean?: boolean
    predecessor?: string
  } : undefined
  const intact = !previous
  const predecessor = previous?.clean ? previous.instance : previous?.predecessor
  let stopped = false
  let queries = 0
  replaceFile({
    path: ledgerPath,
    text: JSON.stringify({
      instance,
      predecessor,
    }),
  })
  const recoveredSessions = new Set<string>()
  let uncertainOpening = false

  const make = ({ summary }: { summary: Summary }): Session => ({
    output: output({
      directory: join(
        root,
        summary.ref.id,
      ),
      session: summary,
      limits,
    }),
    control: controller(),
    context: '',
    uncertain: new Set(),
    abort: new AbortController(),
    operations: 0,
    incoming: [],
    incomingBytes: 0,
    changed: deferred<void>(),
    pending: new Map(),
    inputs: new Map(),
    answers: new Map(),
    finished: deferred<void>(),
  })

  const finishRecovery = ({ entry }: { entry: Session }) => {
    const summary = entry.output.summary

    if (!summary.recovery || entry.output.pending().length > 0
      || entry.output.retention() !== 'healthy') {
      return
    }

    summary.phase = 'closed'
    entry.output.save()
    recoveredSessions.delete(summary.ref.id)
  }

  for (const folder of readdirSync(
    root,
    { withFileTypes: true },
  )) {
    if (!folder.isDirectory()) {
      fail({
        code: 'RECOVERY_REQUIRED',
        message: 'Unrecognized native session storage',
      })
    }

    let summary: Summary

    try {
      summary = JSON.parse(readFileSync(
        join(
          root,
          folder.name,
          'session.json',
        ),
        'utf8',
      ))

      if (summary.ref.id !== folder.name || !summary.ref.epoch || ![
        'claude-code',
        'codex',
      ].includes(summary.provider)) {
        fail({
          code: 'RECOVERY_REQUIRED',
          message: 'Unrecognized native session descriptor',
        })
      }
    } catch {
      fail({
        code: 'RECOVERY_REQUIRED',
        message: 'A native session descriptor needs reconciliation',
      })
    }

    delete summary.recovery

    if (verifiedBootChange({
      before: summary.boot,
      after: boot,
    })) {
      summary.recovery = 'boot_changed'
    } else {
      const groups = Array.isArray(summary.groups) ? summary.groups : []
      await Promise.all(groups.map(group => endGroup({
        group,
        lastAliveAt: summary.lastAliveAt,
      })))
      summary.recovery = 'host_lost'
    }

    const entry = make({ summary })

    if (predecessor && [
      'closed',
      'failed',
    ].includes(summary.phase) && entry.output.pending().length === 0) {
      rmSync(
        join(
          root,
          folder.name,
        ),
        { recursive: true },
      )
      continue
    }

    summary.controllerRevision = 0

    if (summary.recovery || ![
      'closed',
      'failed',
    ].includes(summary.phase)) {
      summary.phase = 'recovery_required'
    }

    entry.finished.resolve()
    sessions.set(
      summary.ref.id,
      entry,
    )
    recoveredSessions.add(summary.ref.id)
    finishRecovery({ entry })
  }

  const ledger = requestLedger({ intact })

  const find = ({ ref }: { ref: SessionRef }): Session => {
    const entry = sessions.get(ref.id)

    if (!entry || entry.output.summary.ref.epoch !== ref.epoch) {
      return fail({
        code: 'EPOCH_MISMATCH',
        message: 'The native session incarnation does not match',
      })
    }

    return entry
  }

  const controlFor = ({ scope }: { scope: Scope }) => scope.kind === 'host' ? hostControl : find({ ref: scope.ref }).control

  const authorize = ({
    control,
    token,
    peer,
  }: {
    control: Controller
    token: string
    peer: Peer
  }) => {
    if (!control.generation || control.generation !== token || control.peer !== peer.id) {
      fail({
        code: 'STALE_CONTROLLER',
        message: 'Attach to the current controller before changing native state',
      })
    }
  }

  const requireReady = () => {
    if (stopped) {
      fail({
        code: 'HOST_STOPPED',
        message: 'The native host is stopping at an idle boundary',
      })
    }
  }

  const admission = () => {
    requireReady()
    const ownershipUnknown = recoveredSessions.size > 0 || uncertainOpening || [...sessions.values()].some(entry => entry.output.summary.phase === 'recovery_required')

    if (ownershipUnknown) {
      fail({
        code: 'RECOVERY_REQUIRED',
        message: 'Old native ownership must be reconciled before new admissions',
      })
    }

    if ([...sessions.values()].some(entry => !entry.output.canAdmit())) {
      fail({
        code: 'RETENTION_PRESSURE',
        message: 'Reconcile critical output before admitting more native work',
      })
    }
  }

  const publish = ({
    entry,
    event,
  }: {
    entry: Session
    event: HostedEvent
  }) => {
    if (typeof event === 'object' && event.type === 'answer') {
      const answer = entry.answers.get(event.receipt.permission)

      if (answer) {
        answer.receipt.phase = event.receipt.phase
        event = {
          type: 'answer',
          receipt: {
            ...answer.receipt,
            phase: event.receipt.phase,
          },
        }
        ledger.update({
          id: answer.requestId,
          result: {
            kind: 'answer',
            receipt: answer.receipt,
          },
        })

        if (event.receipt.phase !== 'received') {
          answer.submitted.resolve()
        }
      }
    }

    if (typeof event === 'object' && event.type === 'input' && event.receipt.phase === 'queued') {
      return
    }

    const idleClose = stopped && typeof event === 'object' && event.type === 'ended' && event.reason === 'closed'

    if (!idleClose) {
      entry.output.publish({ event })
    }

    if (typeof event === 'object' && event.type === 'ended') {
      if (entry.output.summary.phase !== 'recovery_required') {
        entry.output.summary.phase = event.reason === 'failed' ? 'failed' : 'closed'
      }

      entry.output.save()
      ledger.closed({ ref: entry.output.summary.ref })
      entry.finished.resolve()

      for (const answer of entry.answers.values()) {
        answer.submitted.resolve()
      }
    }
  }

  const start = ({ entry }: { entry: Session }) => {
    const native = entry.native!

    const input = async function* () {
      while (!entry.abort.signal.aborted) {
        const message = entry.incoming.shift()

        if (message) {
          entry.incomingBytes -= Buffer.byteLength(JSON.stringify(message))
          yield message
          continue
        }

        await entry.changed.promise
        entry.changed = deferred<void>()
      }
    }

    const pump = async () => {
      try {
        const stream = native.run({
          observe: ({ event }) => {
            try {
              publish({
                entry,
                event,
              })
            } catch {
              entry.output.summary.phase = 'recovery_required'
              uncertainOpening = true

              if (typeof event === 'object' && event.type === 'ended') {
                entry.finished.resolve()
              }

              return 'Native output persistence failed; ownership requires recovery'
            }

            if (entry.output.retention() === 'exhausted') {
              entry.output.summary.phase = 'recovery_required'
              uncertainOpening = true

              try {
                entry.output.save()
              } catch {
                // A disk failure cannot erase the in-memory recovery marker or retained facts.
              }

              return 'Native output retention exhausted; reconcile the retained facts before recovery'
            }
          },
          input: input(),
          permission: ({ ...request }) => new Promise<PermissionDecision>(resolve => {
            const {
              signal,
              ...pending
            } = request

            const decide = ({ decision }: { decision: PermissionDecision }) => {
              signal.removeEventListener(
                'abort',
                abort,
              )
              entry.pending.delete(request.id)
              resolve(decision)
            }

            const abort = () => decide({
              decision: {
                behavior: 'deny',
                message: 'The native request ended',
              },
            })
            entry.pending.set(
              request.id,
              {
                request: pending,
                decide,
              },
            )
            signal.addEventListener(
              'abort',
              abort,
              { once: true },
            )

            if (signal.aborted) {
              abort()
            }
          }),
        })
        // The host owns the synchronous sink; it must not depend on a bounded viewer queue.
        await stream[Symbol.asyncIterator]().return?.()
        await entry.finished.promise
      } catch {
        publish({
          entry,
          event: {
            type: 'ended',
            reason: 'failed',
            error: 'The native event stream failed',
          },
        })
      } finally {
        entry.finished.resolve()
      }
    }

    // This owner survives every viewer; failures are retained as critical lifecycle facts.
    pump().catch(() => {
      entry.output.summary.phase = 'recovery_required'
      uncertainOpening = true
      entry.finished.resolve()
    })
  }

  const awaitNative = async <T>({
    entry,
    action,
  }: {
    entry: Session
    action(): Promise<T>
  }): Promise<T> => {
    const id = randomUUID()
    const settled = (async () => {
      try {
        return await action()
      } finally {
        entry.uncertain.delete(id)
      }
    })()
    let timeout: NodeJS.Timeout | undefined

    try {
      return await Promise.race([
        settled,
        new Promise<never>((
          resolve,
          reject,
        ) => {
          timeout = setTimeout(
            () => {
              entry.uncertain.add(id)
              reject(new HydraError({
                code: 'CONTROL_UNKNOWN',
                message: 'The native action is still unsettled; do not retry it',
              }))
            },
            controlTimeout,
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  const mutate = async ({
    entry,
    operation,
    id,
  }: {
    entry: Session
    operation: Mutation
    id: string
  }): Promise<Result> => {
    if (entry.uncertain.size) {
      fail({
        code: 'CONTROL_UNCERTAIN',
        message: 'Reconcile the earlier native action before another mutation',
      })
    }

    const native = entry.native

    if (!native) {
      return fail({
        code: 'RECOVERY_REQUIRED',
        message: 'This descriptor has no live native continuation',
      })
    }

    if (entry.output.summary.phase !== 'live' && operation.kind !== 'close') {
      fail({
        code: 'SESSION_UNAVAILABLE',
        message: 'This native session cannot accept new work or controls',
      })
    }

    if (![
      'answer',
      'interrupt',
    ].includes(operation.kind)) {
      requireReady()
    }

    if (operation.kind === 'input') {
      admission()
      const inputHash = fingerprint({ value: operation.input })
      const previous = entry.inputs.get(operation.input.id)

      if (previous && previous !== inputHash) {
        fail({
          code: 'CONFLICTING_INPUT',
          message: 'The input ID names a different text or image manifest',
        })
      }

      if (!previous) {
        const bytes = Buffer.byteLength(JSON.stringify(operation.input))

        const full = entry.inputs.size >= MAX_INPUTS
          || entry.incomingBytes + bytes > MAX_QUEUED_INPUT_BYTES

        if (full) {
          fail({
            code: 'INPUT_LIMIT',
            message: 'The live native input identity or queue limit was reached',
          })
        }

        entry.inputs.set(
          operation.input.id,
          inputHash,
        )
        entry.incoming.push(structuredClone(operation.input))
        entry.incomingBytes += bytes
        entry.changed.resolve()
      }

      return {
        kind: 'input',
        inputId: operation.input.id,
        phase: 'queued',
      }
    }

    if (operation.kind === 'answer') {
      if (!entry.output.canAdmit()) {
        fail({
          code: 'RETENTION_PRESSURE',
          message: 'Acknowledge retained critical output before delivering an answer',
        })
      }

      const binding = answerIds.get(operation.answerId)

      const differentSession = binding && binding.session !== entry.output.summary.ref.id
      const differentPermission = binding && binding.permission !== operation.permission

      if (differentSession || differentPermission) {
        fail({
          code: 'CONFLICTING_ANSWER',
          message: 'This answer ID names a different native continuation',
        })
      }

      const previous = entry.answers.get(operation.permission)

      if (previous) {
        if (previous.receipt.answerId !== operation.answerId) {
          fail({
            code: 'ALREADY_ANSWERED',
            message: 'The native request already has an answer delivery',
          })
        }

        return {
          kind: 'answer',
          receipt: structuredClone(previous.receipt),
        }
      }

      const pending = entry.pending.get(operation.permission)

      if (!pending) {
        fail({
          code: 'NOT_PENDING',
          message: 'The native permission continuation is no longer pending',
        })
      }

      const answer = {
        requestId: id,
        receipt: {
          answerId: operation.answerId,
          permission: operation.permission,
          phase: 'received' as AnswerReceipt['phase'],
        },
        submitted: deferred<void>(),
      }
      entry.answers.set(
        operation.permission,
        answer,
      )
      answerIds.set(
        operation.answerId,
        {
          session: entry.output.summary.ref.id,
          permission: operation.permission,
        },
      )
      entry.output.publish({
        event: {
          type: 'answer',
          receipt: {
            ...answer.receipt,
            phase: 'received',
          },
        },
      })
      pending.decide({ decision: operation.decision })
      let timer: NodeJS.Timeout | undefined

      try {
        await Promise.race([
          answer.submitted.promise,
          new Promise<void>(resolve => {
            timer = setTimeout(
              () => {
                answer.receipt.phase = 'unknown'
                entry.output.publish({
                  event: {
                    type: 'answer',
                    receipt: structuredClone(answer.receipt),
                  },
                })
                resolve()
              },
              controlTimeout,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }

      return {
        kind: 'answer',
        receipt: structuredClone(answer.receipt),
      }
    }

    if (operation.kind === 'interrupt') {
      const turn = native.snapshot().work.runningTurns[0]

      if (turn !== operation.expectedTurn) {
        fail({
          code: 'STALE_TURN',
          message: 'The interrupt target is no longer the running turn',
        })
      }

      await awaitNative({
        entry,
        action: () => native.interrupt(),
      })
    } else if (operation.kind === 'set') {
      await awaitNative({
        entry,
        action: () => native.set({
          setting: operation.setting,
          value: operation.value,
        }),
      })
    } else if (operation.kind === 'context') {
      entry.context = operation.text
    } else if (operation.kind === 'close') {
      const pendingInput = entry.incoming.length > 0

      const idle = nativeIdle({ work: native.snapshot().work })

      if (operation.expectedIdle && (pendingInput || !idle)) {
        fail({
          code: 'NATIVE_BUSY',
          message: 'Queued, background or unknown native work still blocks close',
        })
      }

      entry.abort.abort()
      entry.changed.resolve()

      for (const pending of entry.pending.values()) {
        pending.decide({
          decision: {
            behavior: 'deny',
            message: 'The native session was explicitly closed',
          },
        })
      }

      native.close()
      await awaitNative({
        entry,
        action: () => entry.finished.promise,
      })
    }

    return { kind: 'ok' }
  }

  const maintenance = (): Maintenance => {
    const blockers: Maintenance['blockers'] = []

    if (queries || uncertainOpening || recoveredSessions.size > 0) {
      blockers.push({ reasons: ['Native queries or uncertain ownership remain'] })
    }

    for (const entry of sessions.values()) {
      const reasons: string[] = []
      const summary = entry.output.summary
      const terminal = summary.phase === 'closed' || summary.phase === 'failed'

      if (entry.operations || entry.uncertain.size) {
        reasons.push('Native controls are still settling')
      }

      if (entry.incoming.length) {
        reasons.push('Admitted inputs remain queued')
      }

      if (entry.pending.size) {
        reasons.push('Native permission answers remain pending')
      }

      const work = entry.native?.snapshot().work
      const unresolvedTerminal = terminal && work && (work.unsettledInputs.length > 0 || work.runningTools.length > 0 || work.pendingControls.length > 0 || work.background.knowledge !== 'known' || work.background.tasks.length > 0)

      if (unresolvedTerminal) {
        reasons.push('An ended native session still has unresolved inputs, controls or background ownership')
      }

      if (!terminal && (!entry.native || !nativeIdle({ work: entry.native.snapshot().work }))) {
        reasons.push('Native turns, inputs, tools, queue or background work are active or unknown')
      }

      if (entry.output.pending().length) {
        reasons.push('Critical facts await application acknowledgement')
      }

      if (entry.output.retention() !== 'healthy') {
        reasons.push('Critical retention needs reconciliation')
      }

      if (summary.phase === 'recovery_required') {
        reasons.push('Native ownership requires recovery')
      }

      if (reasons.length) {
        blockers.push({
          ref: summary.ref,
          reasons,
        })
      }
    }

    return {
      mode: stopped ? 'stopped' : 'ready',
      blockers,
    }
  }

  const shutdown = async (): Promise<Result> => {
    if (maintenance().blockers.length) {
      return {
        kind: 'maintenance',
        status: maintenance(),
      }
    }

    stopped = true

    for (const entry of sessions.values()) {
      if (entry.output.summary.phase !== 'live') {
        continue
      }

      entry.abort.abort()
      entry.changed.resolve()
      await awaitNative({
        entry,
        action: async () => {
          entry.native!.close(); await entry.finished.promise
        },
      })
    }

    for (const entry of sessions.values()) {
      await entry.output.compact()
    }

    const status = maintenance()

    if (status.blockers.length) {
      return {
        kind: 'maintenance',
        status,
      }
    }

    replaceFile({
      path: ledgerPath,
      text: JSON.stringify({
        instance,
        clean: true,
      }),
    })
    stopped = true

    return { kind: 'shutdown' }
  }

  return {
    ready(): Extract<ToClient, { type: 'ready' }> {
      return {
        type: 'ready',
        protocol: PROTOCOL,
        instance,
        build,
        capabilities: CAPABILITIES,
        hostControllerRevision: hostControl.revision,
        maintenance: maintenance(),
        predecessor,
        sessions: [...sessions.values()].map(entry => structuredClone(entry.output.summary)),
        ledger: intact ? 'intact' : 'recovery_required',
      }
    },
    async call({
      peer,
      id,
      operation,
    }: {
      peer: Peer
      id: string
      operation: Operation
    }): Promise<Result> {
      if (operation.kind === 'status') {
        return {
          kind: 'maintenance',
          status: maintenance(),
        }
      }

      if (operation.kind === 'catalog') {
        requireReady()
        queries++

        try {
          const provider = providers[operation.provider]
          const models = await provider.models({
            cwd: operation.cwd,
            env: operation.environment,
          })

          return {
            kind: 'catalog',
            models: await provider.defaults({
              cwd: operation.cwd,
              env: operation.environment,
              models,
            }),
          }
        } finally {
          queries--
        }
      }

      if (operation.kind === 'commands') {
        requireReady()
        queries++

        try {
          const native = find({ ref: operation.ref }).native

          return {
            kind: 'commands',
            commands: await native?.commands?.() ?? [],
          }
        } finally {
          queries--
        }
      }

      let scope: Scope

      if (operation.kind === 'attach') {
        scope = operation.scope
      } else if (operation.kind === 'open' || operation.kind === 'shutdown') {
        scope = { kind: 'host' }
      } else {
        scope = {
          kind: 'session',
          ref: operation.ref,
        }
      }

      const control = controlFor({ scope })

      if (operation.kind !== 'attach') {
        authorize({
          control,
          token: operation.controller,
          peer,
        })
      }

      const target = scope.kind === 'session' && operation.kind !== 'attach' ? find({ ref: scope.ref }) : undefined

      if (target) {
        target.operations++
      }

      try {
        return await ledger.call({
          id,
          operation,
          run: () => control.queue.run({
            action: async () => {
              if (operation.kind !== 'attach') {
                authorize({
                  control,
                  token: operation.controller,
                  peer,

                })
              }

              if (operation.kind === 'attach') {
                if (scope.kind === 'session') {
                  // Failed persistence remains explicit in the baseline and must permit reconciliation.
                  await Promise.allSettled([find({ ref: scope.ref }).output.flush()])
                }

                if (control.revision !== operation.expectedRevision) {
                  return fail({
                    code: 'STALE_REVISION',
                    message: 'Another controller attached before this barrier',
                  })
                }

                control.revision++
                control.generation = randomUUID()
                control.peer = peer.id
                control.delivered.clear()

                if (scope.kind === 'session') {
                  find({ ref: scope.ref }).output.summary.controllerRevision = control.revision
                }

                const grant: Grant = {
                  scope,
                  revision: control.revision,
                  generation: control.generation,
                }

                return {
                  kind: 'attached',
                  control: grant,
                }
              }

              if (operation.kind === 'shutdown') {
                return shutdown()
              }

              if (operation.kind !== 'open') {
                return mutate({
                  entry: find({ ref: operation.ref }),
                  operation,
                  id,
                })
              }

              admission()

              if (sessions.size >= MAX_SESSIONS) {
                return fail({
                  code: 'SESSION_LIMIT',
                  message: 'The native host reached its session limit',
                })
              }

              const entry = make({
                summary: {
                  ref: {
                    id: randomUUID(),
                    epoch: randomUUID(),
                  },
                  provider: operation.options.provider,
                  phase: 'opening',
                  boot,
                  controllerRevision: 0,
                },
              })
              sessions.set(
                entry.output.summary.ref.id,
                entry,
              )
              const options = operation.options
              entry.context = options.context ?? ''
              const nativeOptions: Parameters<Provider['open']>[0] = {
                cwd: options.cwd,
                settings: options.settings,
                env: options.environment,
                signal: entry.abort.signal,
                instructions: options.instructions,
                outputSchema: options.outputSchema,
                allow: options.allow,
                context: () => entry.context,
                ownProcess({ pid }) {
                  const group = nativeGroup({ pid })
                  const summary = entry.output.summary
                  const groups = summary.groups ?? []
  
                  const recorded = groups.some(known => known.id === group.id
                    && known.start === group.start)
  
                  if (recorded) {
                    return
                  }
  
                  if (groups.length >= MAX_GROUPS) {
                    fail({
                      code: 'OWNERSHIP_LIMIT',
                      message: 'The native session reached its process-group limit',
                    })
                  }
  
                  summary.groups = [
                    ...groups,
                    group,
                  ]
                  entry.output.save()
                },
              }

              if (options.resume) {
                nativeOptions.agent = {
                  provider: options.provider,
                  sessionId: options.resume.nativeId,
                  transcriptPath: options.resume.path,
                  resume: true,
                }
              }

              try {
                await awaitNative({
                  entry,
                  action: async () => {
                    entry.native = await providers[options.provider].open(nativeOptions)
                    entry.output.summary.nativeId = entry.native.id
                    entry.output.summary.path = entry.native.path

                    if (entry.output.summary.phase === 'opening') {
                      entry.output.summary.phase = 'live'
                    }

                    entry.output.save()
                    start({ entry })
                  },
                })
              } catch {
                uncertainOpening = true
                entry.output.summary.phase = 'recovery_required'
                entry.output.save()

                return fail({
                  code: 'OPEN_UNKNOWN',
                  message: 'Native open failed; reconcile ownership before another admission',
                })
              }

              return {
                kind: 'opened',
                session: structuredClone(entry.output.summary),
              }
            },
          }),
        })
      } finally {
        if (target) {
          target.operations--
        }
      }
    },
    result({ id }: { id: string }) {
      return ledger.lookup({ id })
    },
    async acknowledge({
      peer,
      frame,
    }: {
      peer: Peer
      frame: Extract<ToHost, { type: 'ack' }>
    }): Promise<Result> {
      const entry = find({ ref: frame.ref })

      const accepted = await entry.control.queue.run({
        action: async () => {
          authorize({
            control: entry.control,
            token: frame.controller,
            peer,
          })
          const persisted = entry.output.acknowledge({
            through: frame.appliedFactsThrough,
            delivered: entry.control.delivered,
          })

          for (const sequence of entry.control.delivered) {
            if (sequence <= frame.appliedFactsThrough) {
              entry.control.delivered.delete(sequence)
            }
          }

          return { persisted }
        },
      })
      await accepted.persisted

      if (entry.output.summary.recovery && entry.output.pending().length === 0) {
        await entry.output.compact()
        finishRecovery({ entry })
      }

      return {
        kind: 'ok',
        session: structuredClone(entry.output.summary),
      }
    },
    watch({
      peer,
      ref,
      after,
    }: {
      peer: Peer
      ref: SessionRef
      after?: number
    }) {
      const entry = find({ ref })
      let ready = false, cancelled = false

      if (after !== undefined && (after < 0 || after > entry.output.through())) {
        fail({
          code: 'INVALID_CURSOR',
          message: 'The watch cursor is outside this session epoch',
        })
      }

      const delivered = ({ seq }: { seq: number }) => {
        if (entry.control.peer === peer.id) {
          entry.control.delivered.add(seq)
        }
      }

      const unsubscribe = entry.output.subscribe({
        listener: ({ frame }) => {
          if (!ready) {
            return
          }

          if (peer.send({ frame }) && eventClass({ event: frame.event }) === 'critical') {
            delivered({ seq: frame.seq })
          }
        },
      })

      if (after !== undefined && entry.output.expired({ after })) {
        peer.send({
          frame: {
            type: 'resync',
            ref,
            reason: 'cursor_expired',
          },
        })
      }

      const baseline = () => {
        if (cancelled) {
          return
        }

        const pendingFacts = entry.output.pending({ persisted: entry.output.retention() === 'healthy' })
        const current = entry.native?.snapshot()
        let native: Parameters<Output['baseline']>[0]['native']

        if (current) {
        // Terminal outcomes are replayed as original critical facts, never duplicated in the view.
          native = {
            work: current.work,
            permissions: current.permissions,
            answers: [...entry.answers.values()].map(answer => structuredClone(answer.receipt)),
          }
        }

        const snapshot = entry.output.baseline({
          admittedInputIds: [...entry.inputs.keys()],
          native,
        })

        const accepted = peer.send({
          frame: {
            type: 'snapshot',
            ref,
            viewThrough: entry.output.through(),
            pendingFacts,
            snapshot,
          },
        })

        if (accepted) {
          for (const fact of pendingFacts) {
            delivered({ seq: fact.seq })
          }
        }

        ready = true
      }

      entry.output.flush().then(
        baseline,
        baseline,
      )

      return () => {
        cancelled = true; unsubscribe()
      }
    },
    detach({ peer }: { peer: Peer }) {
      for (const entry of sessions.values()) {
        if (entry.control.peer === peer.id) {
          entry.control.delivered.clear()
        }
      }
    },
    // Host shutdown closes native sessions; a client disconnect never calls this.
    async close() {
      const errors: unknown[] = []

      for (const entry of sessions.values()) {
        try {
          entry.abort.abort()
          entry.changed.resolve()
          entry.native?.close()
        } catch (error) {
          errors.push(error)
        } finally {
          entry.finished.resolve()
        }
      }

      for (const entry of sessions.values()) {
        try {
          await entry.output.flush()
        } catch (error) {
          errors.push(error)
        }
      }

      if (errors.length) {
        fail({
          code: 'SHUTDOWN_FAILED',
          message: 'Some native sessions failed to close; ownership requires recovery',
        })
      }
    },
  }
}

export type HostSessions = Awaited<ReturnType<typeof hostSessions>>

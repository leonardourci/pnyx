import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { ApplyError, type ApplyIssue } from '#app/apply/schema.ts'
import { asRecord } from '#app/command-validation.ts'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { settingsNotice } from '#hydra/settings-notice.ts'
import { HydraError } from '#store/errors.ts'
import { withRegistryLock } from '#store/storage.ts'
import { storedOffers } from './model-catalog.ts'
import type { DispatchProposal } from './model.ts'
import { canonical, checkDispatch, mergePatch, outOfDate, patchChanges, patchOf, type DispatchChange, type DispatchDocument, type DispatchIssue } from './dispatch-check.ts'
import { commitChange, loginFolder, lockedDocument, readChanges, savedDocument, type Account, type ChangeEntry } from './dispatch-config.ts'
import { raisesPermission, workerMode } from './permission-level.ts'
import { hydraCandidate } from '#hydra/agent-choice.ts'
import { hydraActor } from '#app/request-context.ts'
import { loadHydra } from '#app/store.ts'

type Fields = Record<string, unknown>

export interface DispatchEnvelope {
  version: 1
  expected?: { revision: number }
  patch: Fields
}

export const DISPATCH_HELP_LINE = ['Run `pnyx-axi rule schema` for every field and allowed value']

const ENVELOPE_FIELDS = [
  'version',
  'expected',
  'patch',
]

const issue = ({
  path,
  reason,
}: {
  path: string
  reason: string
}): ApplyIssue => ({
  operation: null,
  path,
  code: 'VALIDATION_ERROR',
  reason,
})

export function parseEnvelope({ value: raw }: { value: unknown }): DispatchEnvelope {
  const value = asRecord({ value: raw })

  if (!value) {
    throw new ApplyError({
      errors: [
        issue({
          path: '',
          reason: 'the document must be an object with version, expected and patch',
        }),
      ],
      help: DISPATCH_HELP_LINE,
    })
  }

  const errors = Object.keys(value).filter(key => !ENVELOPE_FIELDS.includes(key))
    .map(key => issue({
      path: `/${key}`,
      reason: 'unknown field; the document takes version, expected and patch',
    }))

  if (value.version !== 1) {
    errors.push(issue({
      path: '/version',
      reason: 'version must be 1',
    }))
  }

  const expected = asRecord({ value: value.expected })
  const revision = expected?.revision

  if (value.expected !== undefined && (!expected || Object.keys(expected).some(key => key !== 'revision')
    || !Number.isInteger(revision) || (revision as number) < 0)) {
    errors.push(issue({
      path: '/expected',
      reason: 'expected takes only revision, a non-negative integer from `rule show`',
    }))
  }

  if (!asRecord({ value: value.patch })) {
    errors.push(issue({
      path: '/patch',
      reason: 'patch must be an object naming only what changes; null removes a key',
    }))
  }

  if (errors.length) {
    throw new ApplyError({
      errors,
      help: DISPATCH_HELP_LINE,
    })
  }

  return value as unknown as DispatchEnvelope
}

const revisionOf = ({ entries }: { entries: ChangeEntry[] }) => entries
  .filter(entry => !entry.unchanged).length

export const dispatchRevision = () => revisionOf({ entries: readChanges() })

// A save may keep an error the saved document already had, so an old or merged document can be fixed one patch at a time.
function newErrors({
  before,
  after,
}: {
  before: DispatchDocument
  after: DispatchDocument
}): DispatchIssue[] {
  const known = new Set(checkDispatch({ document: before }).map(found => `${found.path} ${found.problem}`))

  return dispatchIssues({ document: after }).filter(found => found.level === 'error'
    && !known.has(`${found.path} ${found.problem}`))
}

// Model and login-folder warnings need the catalog and the disk, so only the CLI and server add them.
export function dispatchIssues({ document }: { document: DispatchDocument }) {
  return checkDispatch({
    document,
    catalog: storedOffers(),
    exists: ({ folder }) => existsSync(loginFolder({ account: { folder } as Account })),
  })
}

function proposalToken({
  hydraId,
  proposal,
}: {
  hydraId: string
  proposal: DispatchProposal
}): string {
  return createHash('sha256').update(canonical({
    value: {
      hydraId,
      ...proposal,
    },
  }))
    .digest('hex')
    .slice(
      0,
      24,
    )
}

// --if-revision names the dispatch revision, so the Hydra event that records a proposal never checks it.
function eventMeta({ meta }: { meta: Meta }): Meta {
  const event = structuredClone(meta)
  delete event.ifRevision

  return event
}

function propose({
  hydraId,
  meta,
  changes,
  summary,
}: {
  hydraId: string
  meta: Meta
  changes: DispatchChange[]
  summary: string
}): Output {
  const proposal: DispatchProposal = {
    token: '',
    kind: 'dispatch',
    shared: true,
    before: JSON.stringify(changes),
    value: JSON.stringify(patchOf({ changes })),
    summary,
  }
  proposal.token = proposalToken({
    hydraId,
    proposal,
  })
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        meta: eventMeta({ meta }),
        cardId: HYDRA_CARD,
        change: {
          type: 'hydra.dispatch-proposed',
          data: proposal,
        },
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }
    },
  })

  return {
    confirmation: 'needed',
    token: proposal.token,
    action: summary,
    changes,
    help: ['The owner can Confirm or Dismiss this proposal in Hydra’s chat'],
  }
}

function raisesCandidatePermission({
  hydraId,
  before,
  after,
}: {
  hydraId: string
  before: DispatchDocument
  after: DispatchDocument
}): boolean {
  const state = loadHydra({ hydraId }).state
  const previousHydra = hydraCandidate({
    state: {},
    dispatch: before,
  })
  const nextHydra = hydraCandidate({
    state: {},
    dispatch: after,
  })

  if (raisesPermission({
    beforeHarness: previousHydra.harness,
    harness: nextHydra.harness,
    before: previousHydra.mode,
    after: nextHydra.mode,
  })) {
    return true
  }

  const lists = [
    {
      previous: before.default,
      next: after.default,
    },
    ...Object.entries(after.rules).map(([
      name,
      rule,
    ]) => ({
      previous: before.rules[name]?.candidates ?? [],
      next: rule.candidates,
    })),
  ]

  return lists.some(({
    previous,
    next,
  }) => next.some(candidate => {
    const prior = previous.find(item => {
      return item.harness === candidate.harness && item.account === candidate.account
    })

    return raisesPermission({
      harness: candidate.harness,
      before: workerMode({
        state,
        harness: candidate.harness,
        mode: prior?.mode,
      }),
      after: workerMode({
        state,
        harness: candidate.harness,
        mode: candidate.mode,
      }),
    })
  }))
}

function dispatchNotice({
  hydraId,
  entry,
  meta,
}: {
  hydraId: string
  entry: ChangeEntry
  meta: Meta
}): void {
  if (!entry.changes?.length) {
    return
  }

  const changes = entry.changes.map(change => `${change.path} to ${JSON.stringify(change.after ?? null)}`)
  settingsNotice({
    hydraId,
    meta,
    changeId: `dispatch:${entry.id}`,
    text: `Changed heads dispatch: ${changes.join('; ')}`,
  })
}

// One patch, checked whole: every rule, account and order change goes through here.
export function applyDispatch({
  hydraId,
  envelope,
  meta,
  check = false,
  proposeIt = false,
  summary,
}: {
  hydraId: string
  envelope: DispatchEnvelope
  meta: Meta
  check?: boolean
  proposeIt?: boolean
  summary: string
}): Output {
  return withRegistryLock({
    fn: () => {
      const document = lockedDocument()
      const entries = readChanges()
      const revision = revisionOf({ entries })
      const digest = createHash('sha256').update(canonical({
        value: {
          envelope,
          actor: meta.actor,
          propose: proposeIt,
        },
      }))
        .digest('hex')
      const seen = meta.id === undefined ? undefined : entries.find(entry => entry.id === meta.id)

      if (seen) {
        if (seen.digest !== digest) {
          throw new HydraError({
            message: `event id ${meta.id} was already used with different contents or actor`,
            code: 'IDEMPOTENCY_CONFLICT',
          })
        }

        dispatchNotice({
          hydraId,
          entry: seen,
          meta,
        })

        return {
          ...seen.receipt,
          duplicate: true,
        }
      }

      const expected = envelope.expected?.revision ?? meta.ifRevision

      if (expected !== undefined && expected !== revision) {
        throw new HydraError({
          message: `heads dispatch is at revision ${revision}, not ${expected}; run rule show and patch again`,
          code: 'REVISION_CONFLICT',
        })
      }

      const after = mergePatch({
        target: document,
        patch: envelope.patch,
      }) as DispatchDocument
      const issues = dispatchIssues({ document: after })
      const errors = newErrors({
        before: document,
        after,
      })

      if (errors.length) {
        throw new ApplyError({
          errors: errors.map(found => issue({
            path: found.path,
            reason: found.problem,
          })),
          help: DISPATCH_HELP_LINE,
        })
      }

      const changes = patchChanges({
        document,
        patch: envelope.patch,
      })
      const remaining = issues.map(found => `${found.level} ${found.path}: ${found.problem}`)

      if (!changes.length) {
        const unchanged: Output = {
          event: 'none: unchanged',
          revision,
        }

        // A retry of this id must answer the same, even after a later change makes the patch apply.
        if (meta.id !== undefined && !check) {
          commitChange({
            entry: {
              v: 1,
              id: meta.id,
              at: meta.at,
              actor: meta.actor,
              digest,
              receipt: unchanged,
              unchanged: true,
            },
          })
        }

        return unchanged
      }

      if (check) {
        return {
          applied: false,
          check: true,
          revision,
          changes,
          issues: remaining,
        }
      }

      if (proposeIt) {
        return propose({
          hydraId,
          meta,
          changes,
          summary,
        })
      }

      if (hydraActor({ actor: meta.actor }) && raisesCandidatePermission({
        hydraId,
        before: document,
        after,
      })) {
        throw new HydraError({
          message: 'Only the owner can raise a candidate’s permission level',
          code: 'OWNER_ONLY',
          help: ['Repeat with --propose'],
        })
      }

      const receipt: Output = {
        applied: true,
        revision: revision + 1,
        changes,
        issues: remaining,
      }
      const entry: ChangeEntry = {
        v: 1,
        id: meta.id ?? randomUUID(),
        at: meta.at,
        actor: meta.actor,
        digest,
        changes,
        receipt,
        document: after,
      }

      if (meta.reason) {
        entry.reason = meta.reason
      }

      commitChange({ entry })
      dispatchNotice({
        hydraId,
        entry,
        meta,
      })

      return receipt
    },
  })
}

export interface ProposalStatus {
  token: string
  summary: string
  changes: DispatchChange[]
  // Set, with its reason, once the proposal can only be dismissed.
  outOfDate: boolean
  reason?: string
}

// Proposals from before dispatch became one patchable document carry whole files, so they can only be dismissed.
function proposalProblem({
  document,
  proposal,
}: {
  document: DispatchDocument
  proposal: DispatchProposal
}): string | undefined {
  if (proposal.kind !== 'dispatch' || outOfDate({
    document,
    changes: JSON.parse(proposal.before) as DispatchChange[],
  })) {
    return 'This proposal is out of date: heads dispatch changed since Hydra proposed it'
  }

  const errors = newErrors({
    before: document,
    after: mergePatch({
      target: document,
      patch: JSON.parse(proposal.value),
    }) as DispatchDocument,
  })

  return errors.length ? `This proposal no longer checks: ${errors.map(found => `${found.path} ${found.problem}`).join('; ')}` : undefined
}

export function proposalStatus({ state }: { state: HydraState }): ProposalStatus[] {
  const document = savedDocument()

  return (state.dispatchProposals ?? []).filter(proposal => proposal.kind !== 'command')
    .map(proposal => {
      const reason = proposalProblem({
        document,
        proposal,
      })
      const status: ProposalStatus = {
        token: proposal.token,
        summary: proposal.summary,
        changes: proposal.kind === 'dispatch' ? JSON.parse(proposal.before) as DispatchChange[] : [],
        outOfDate: reason !== undefined,
      }

      if (reason) {
        status.reason = reason
      }

      return status
    })
}

function saveProposal({
  proposal,
  id,
  changes,
  meta,
}: {
  proposal: DispatchProposal
  id: string
  changes: DispatchChange[]
  meta: Meta
}): void {
  const document = lockedDocument()
  const problem = proposalProblem({
    document,
    proposal,
  })

  if (problem) {
    throw new HydraError({
      message: problem,
      code: 'CONFLICT',
      help: ['Dismiss it and ask Hydra to propose the change again'],
    })
  }

  commitChange({
    entry: {
      v: 1,
      id,
      at: meta.at,
      actor: meta.actor,
      reason: proposal.summary,
      changes,
      document: mergePatch({
        target: document,
        patch: JSON.parse(proposal.value),
      }) as DispatchDocument,
    },
  })
}

export function resolveProposal({
  hydraId,
  action,
  token,
  confirm,
  meta,
}: {
  hydraId: string
  action: 'confirm' | 'dismiss'
  token: string
  confirm?: string
  meta: Meta
}): Output {
  if (hydraActor({ actor: meta.actor })) {
    throw new HydraError({
      message: 'Only the owner can confirm or dismiss a dispatch proposal',
      code: 'OWNER_ONLY',
    })
  }

  return withRegistryLock({
    fn: () => {
      const state = withWriter({
        hydraId,
        fn: ({ writer }) => writer.state,
      })
      const proposal = state.dispatchProposals?.find(p => p.token === token)

      if (!proposal) {
        return { event: 'none: proposal already resolved or missing' }
      }

      if (proposal.kind === 'command') {
        throw new HydraError({
          message: 'Answer this question with approval confirm|dismiss',
          code: 'VALIDATION_ERROR',
        })
      }

      const changes = proposal.kind === 'dispatch' ? JSON.parse(proposal.before) as DispatchChange[] : []

      if (action === 'confirm') {
        if (confirm !== proposal.token) {
          return {
            confirmation: 'needed',
            token,
            action: proposal.summary,
            changes,
          }
        }

        const id = `proposal-${token}`

        // A confirm whose save landed before recording the resolution failed only records it on retry.
        if (!readChanges().some(entry => entry.id === id)) {
          saveProposal({
            proposal,
            id,
            changes,
            meta,
          })
        }
      }

      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const decision = hydraEvent({
            state: writer.state,
            meta: eventMeta({ meta }),
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.dispatch-resolved',
              data: {
                token,
                action: action === 'confirm' ? 'confirmed' : 'dismissed',
              },
            },
          })

          if ('event' in decision) {
            writer.append({ event: decision.event })
          }
        },
      })

      return {
        proposal: token,
        state: action === 'confirm' ? 'confirmed' : 'dismissed',
      }
    },
  })
}

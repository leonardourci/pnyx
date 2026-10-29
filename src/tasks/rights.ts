import { createHash } from 'node:crypto'
import { HydraError } from '#store/errors.ts'
import type { Card } from './model.ts'
import type { HydraEvent } from '#app/model.ts'
import type { RightsEvent, RightsScope, TaskRights } from './rights-model.ts'

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH = /^(?![.-])(?!.*(?:\.\.|@\{|[\x00-\x20~^:?*\[\\]))(?!.*(?:\/\.|\/\/|\.lock(?:\/|$)))[^/]+(?:\/[^/]+)*$/

export function rightsScope({ value }: { value: unknown }): RightsScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HydraError({
      code: 'INVALID_RIGHTS',
      message: 'Rights must name an exact task scope',
    })
  }

  const scope = value as Record<string, unknown>

  if (![
    'read-only',
    'local-build',
    'ship',
  ].includes(String(scope.level))
    || typeof scope.repository !== 'string' || !REPOSITORY.test(scope.repository)
    || typeof scope.baseRepository !== 'string' || !REPOSITORY.test(scope.baseRepository)
    || typeof scope.branch !== 'string' || !BRANCH.test(scope.branch) || scope.branch.endsWith('.') || scope.branch.endsWith('/')
    || typeof scope.baseBranch !== 'string' || !BRANCH.test(scope.baseBranch) || scope.baseBranch.endsWith('.') || scope.baseBranch.endsWith('/')
    || !Array.isArray(scope.channels)) {
    throw new HydraError({
      code: 'INVALID_RIGHTS',
      message: 'Name a level, canonical head/base repositories and refs, and outward channels',
    })
  }

  const channels = scope.channels.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HydraError({
        code: 'INVALID_RIGHTS',
        message: 'An outward right must name a fixed operation and destination',
      })
    }

    const right = value as Record<string, unknown>

    if (right.operation === 'github.comment.create' && typeof right.repository === 'string' && REPOSITORY.test(right.repository)
      && Number.isSafeInteger(right.subject) && Number(right.subject) > 0) {
      return {
        operation: 'github.comment.create' as const,
        repository: right.repository.toLowerCase(),
        subject: Number(right.subject),
      }
    }

    if (right.operation === 'slack.message.create' && typeof right.workspace === 'string' && /^T[A-Z0-9]+$/.test(right.workspace)
      && typeof right.channel === 'string' && /^[CG][A-Z0-9]+$/.test(right.channel)) {
      return {
        operation: 'slack.message.create' as const,
        workspace: right.workspace,
        channel: right.channel,
      }
    }

    throw new HydraError({
      code: 'INVALID_RIGHTS',
      message: 'Use stable repository/subject or Slack workspace/channel IDs',
    })
  })

  return {
    level: scope.level as RightsScope['level'],
    repository: scope.repository.toLowerCase(),
    branch: scope.branch,
    baseRepository: scope.baseRepository.toLowerCase(),
    baseBranch: scope.baseBranch,
    channels,
  }
}

export const rightsDigest = ({ scope }: { scope: RightsScope }) =>
  createHash('sha256').update(JSON.stringify(rightsScope({ value: scope })))
    .digest('hex')

export function applyRights({
  current,
  event,
}: {
  current?: TaskRights
  event: RightsEvent
}): TaskRights | undefined {
  if (event.type === 'task.rights-requested') {
    if (event.data.revision !== (current?.revision ?? 0) + 1) {
      return current
    }

    return {
      effective: current?.effective,
      revision: event.data.revision,
      requested: {
        id: event.data.request,
        scope: structuredClone(event.data.scope),
        reason: event.data.reason,
      },
    }
  }

  if (!current) {
    return current
  }

  if (event.type === 'task.rights-granted') {
    if (event.data.revision !== current.revision || event.data.request !== current.requested.id
      || rightsDigest({ scope: event.data.scope }) !== rightsDigest({ scope: current.requested.scope }) || current.revoked) {
      return current
    }

    if (current.granted?.request === event.data.request) {
      return current
    }

    return {
      ...current,
      granted: {
        id: event.data.grant,
        request: event.data.request,
        scope: structuredClone(event.data.scope),
        at: event.at,
      },
    }
  }

  if (event.type === 'task.rights-revoked') {
    if (event.data.revision !== current.revision || current.granted?.id !== event.data.grant) {
      return current
    }

    return {
      ...current,
      revoked: {
        at: event.at,
        reason: event.data.reason,
      },
    }
  }

  if (event.type === 'task.native-policy' && event.data.revision === current.revision && event.data.grant === current.granted?.id) {
    return {
      ...current,
      effective: structuredClone(event.data),
    }
  }

  return current
}

export function requireTaskRights({ card }: { card: Card }) {
  const rights = card.rights

  if (!rights) {
    return
  }

  if (!rights.granted || rights.granted.request !== rights.requested.id || rights.revoked) {
    throw new HydraError({
      code: 'RIGHTS_PENDING',
      message: 'The owner must confirm this exact rights request before launch',
    })
  }

  return rights.granted
}

export function rightsEvent({ event }: { event: HydraEvent }): RightsEvent | undefined {
  if (event.type === 'task.rights-requested' || event.type === 'task.rights-granted'
    || event.type === 'task.rights-revoked' || event.type === 'task.native-policy') {
    return event
  }
}

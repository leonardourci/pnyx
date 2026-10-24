import { githubApi, pullRequestDetails, pullRequestRef } from './pull-request.ts'

interface RequiredCheck {
  context: string
  app?: number
}

export interface MergeEvidence {
  head: string
  problems: string[]
}

export type MergeOutcome = {
  outcome: 'merged'
  head: string
  commit: string
} | {
  outcome: 'queued' | 'unknown'
  detail: string
}

const PAGE_SIZE = 100
const GREEN_CONCLUSIONS = [
  'success',
  'neutral',
  'skipped',
]

function object({ value }: { value: unknown }): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected a GitHub object')
  }

  return value as Record<string, unknown>
}

function list({ value }: { value: unknown }): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('expected a GitHub list')
  }

  return value
}

async function pages({
  path,
  key,
}: {
  path: string
  key?: string
}): Promise<unknown[]> {
  const result: unknown[] = []

  for (let page = 1; ; page++) {
    const value = await githubApi({ args: [`${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`] })
    const items = list({ value: key ? object({ value })[key] : value })
    result.push(...items)

    if (items.length < PAGE_SIZE) {
      return result
    }
  }
}

function requiredCheck({
  context,
  app,
}: {
  context: unknown
  app: unknown
}): RequiredCheck {
  if (typeof context !== 'string' || !context || (app !== null && app !== undefined
    && (typeof app !== 'number' || !Number.isInteger(app) || app < -1 || app === 0))) {
    throw new Error('required check identity is unreadable')
  }

  return {
    context,
    app: typeof app === 'number' && app > 0 ? app : undefined,
  }
}

async function readBranchRequirements({
  repo,
  base,
  required,
}: {
  repo: string
  base: string
  required: RequiredCheck[]
}): Promise<void> {
  const rules = await pages({ path: `/repos/${repo}/rules/branches/${encodeURIComponent(base)}` })

  for (const value of rules) {
    const rule = object({ value })

    if (typeof rule.type !== 'string') {
      throw new Error('branch rule has no type')
    }

    if (rule.type !== 'required_status_checks') {
      continue
    }

    const checks = list({ value: object({ value: rule.parameters }).required_status_checks })

    for (const value of checks) {
      const check = object({ value })
      required.push(requiredCheck({
        context: check.context,
        app: check.integration_id,
      }))
    }
  }
}

async function readClassicRequirements({
  repo,
  base,
  required,
}: {
  repo: string
  base: string
  required: RequiredCheck[]
}): Promise<void> {
  const [
    owner,
    name,
  ] = repo.split('/')
  const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { ref(qualifiedName:${JSON.stringify(`refs/heads/${base}`)}) { branchProtectionRule { requiresStatusChecks requiredStatusChecks { context app { databaseId } } } } } }`
  const response = object({
    value: await githubApi({
      args: [
        'POST',
        'graphql',
        '--field',
        `query=${query}`,
      ],
    }),
  })

  if (response.errors) {
    throw new Error('GraphQL returned errors')
  }

  const repository = object({ value: object({ value: response.data }).repository })
  const ref = object({ value: repository.ref })

  if (ref.branchProtectionRule !== null) {
    const rule = object({ value: ref.branchProtectionRule })

    if (typeof rule.requiresStatusChecks !== 'boolean') {
      throw new Error('classic rule is unreadable')
    }

    const checks = list({ value: rule.requiredStatusChecks })

    if (rule.requiresStatusChecks) {
      for (const value of checks) {
        const check = object({ value })
        let app: number | null = null

        if (check.app !== null) {
          const identity = object({ value: check.app }).databaseId

          if (typeof identity !== 'number' || !Number.isInteger(identity) || identity <= 0) {
            throw new Error('required producer identity is unreadable')
          }

          app = identity
        }

        required.push(requiredCheck({
          context: check.context,
          app,
        }))
      }
    }
  }
}

async function readCheckRuns({
  repo,
  head,
  reported,
  problems,
}: {
  repo: string
  head: string
  reported: RequiredCheck[]
  problems: string[]
}): Promise<void> {
  const runs = await pages({
    path: `/repos/${repo}/commits/${head}/check-runs?filter=latest`,
    key: 'check_runs',
  })

  for (const value of runs) {
    const run = object({ value })
    const app = object({ value: run.app }).id

    if (typeof run.name !== 'string' || run.head_sha !== head || typeof app !== 'number'
      || typeof run.status !== 'string') {
      throw new Error('check run identity is unreadable')
    }

    if (run.status !== 'completed') {
      problems.push(`check still running: ${run.name}`)
    } else if (!GREEN_CONCLUSIONS.includes(String(run.conclusion))) {
      problems.push(`check is not green: ${run.name}`)
    }

    reported.push({
      context: run.name,
      app,
    })
  }
}

async function readCommitStatuses({
  repo,
  head,
  reported,
  problems,
}: {
  repo: string
  head: string
  reported: RequiredCheck[]
  problems: string[]
}): Promise<void> {
  const statuses = await pages({ path: `/repos/${repo}/commits/${head}/statuses` })
  const seen = new Set<string>()

  for (const value of statuses) {
    const status = object({ value })

    if (typeof status.context !== 'string' || typeof status.state !== 'string') {
      throw new Error('status is unreadable')
    }

    if (seen.has(status.context)) {
      continue
    }

    seen.add(status.context)

    if (status.state !== 'success') {
      problems.push(`commit status is not green: ${status.context}`)
    }

    reported.push({ context: status.context })
  }
}

export async function pullRequestMergeEvidence({ url }: { url: string }): Promise<MergeEvidence> {
  const pr = pullRequestRef({ url })

  if (!pr) {
    throw new Error('not a GitHub pull request')
  }

  const details = await pullRequestDetails({ url })
  const problems: string[] = []

  if (!details.open || details.merged) {
    problems.push('the pull request is no longer open')
  }

  if (details.draft) {
    problems.push('the pull request is still a draft')
  }

  const required: RequiredCheck[] = []

  try {
    await readBranchRequirements({
      repo: pr.repo,
      base: details.base,
      required,
    })
  } catch (error) {
    problems.push(`branch rules unreadable: ${(error as Error).message}`)
  }

  try {
    await readClassicRequirements({
      repo: pr.repo,
      base: details.base,
      required,
    })
  } catch (error) {
    problems.push(`classic protection unreadable: ${(error as Error).message}`)
  }

  const reported: {
    context: string
    app?: number
  }[] = []

  try {
    await readCheckRuns({
      repo: pr.repo,
      head: details.head,
      reported,
      problems,
    })
  } catch (error) {
    problems.push(`check producers unreadable: ${(error as Error).message}`)
  }

  try {
    await readCommitStatuses({
      repo: pr.repo,
      head: details.head,
      reported,
      problems,
    })
  } catch (error) {
    problems.push(`commit statuses unreadable: ${(error as Error).message}`)
  }

  for (const check of required) {
    const present = reported.some(actual => actual.context === check.context
      && (check.app === undefined || actual.app === check.app))

    if (!present) {
      problems.push(`missing required check: ${check.context}${check.app === undefined ? '' : ` (app ${check.app})`}`)
    }
  }

  return {
    head: details.head,
    problems,
  }
}

export async function pullRequestMergeOutcome({ url }: { url: string }): Promise<MergeOutcome> {
  try {
    const details = await pullRequestDetails({ url })

    if (details.merged && details.merge) {
      return {
        outcome: 'merged',
        head: details.head,
        commit: details.merge,
      }
    }

    const pr = pullRequestRef({ url })!
    const [
      owner,
      name,
    ] = pr.repo.split('/')
    const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { pullRequest(number:${pr.number}) { isInMergeQueue } } }`
    const response = object({
      value: await githubApi({
        args: [
          'POST',
          'graphql',
          '--field',
          `query=${query}`,
        ],
      }),
    })

    if (response.errors) {
      throw new Error('GraphQL returned errors')
    }

    const repository = object({ value: object({ value: response.data }).repository })
    const request = object({ value: repository.pullRequest })

    if (typeof request.isInMergeQueue !== 'boolean') {
      throw new Error('merge queue is unreadable')
    }

    return request.isInMergeQueue ? {
      outcome: 'queued',
      detail: 'GitHub confirmed the pull request is in the merge queue',
    }
      : {
        outcome: 'unknown',
        detail: 'GitHub has not confirmed a merge or a queue entry',
      }
  } catch (error) {
    return {
      outcome: 'unknown',
      detail: `merge confirmation unreadable: ${(error as Error).message}`,
    }
  }
}

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FakePullRequest {
  number: number
  state?: 'open' | 'merged' | 'closed'
  draft?: boolean
  checks?: string
  comments?: number
  head?: string
  branch?: string
  merge?: string
  base?: string
  required?: {
    context: string
    app?: number | null
  }[]
  legacy?: {
    context: string
    app?: number | null
  }[]
  runs?: {
    name: string
    app: number
    conclusion: string | null
    status?: string
  }[]
  statuses?: {
    context: string
    state: string
  }[]
  unreadable?: 'rules' | 'legacy' | 'legacy-app' | 'runs' | 'statuses'
  mergeBehavior?: 'merged' | 'queued' | 'open' | 'readback-failed' | 'rejected'
  pushBeforeMerge?: string
}

export function scriptPullRequest({
  repo,
  hydraId,
  ...input
}: FakePullRequest & {
  repo: string
  hydraId: string
}): string {
  const file = join(
    repo,
    String(input.number),
  )
  const pullRequest = {
    state: 'open',
    draft: false,
    checks: '0 passed, 0 failed',
    comments: 0,
    head: 'a'.repeat(40),
    merge: 'b'.repeat(40),
    base: 'main',
    branch: 'feature',
    required: [],
    legacy: [],
    runs: [],
    statuses: [],
    mergeBehavior: 'merged',
    ...input,
  }
  mkdirSync(
    repo,
    { recursive: true },
  )
  writeFileSync(
    `${file}.next`,
    JSON.stringify(pullRequest),
  )
  renameSync(
    `${file}.next`,
    file,
  )

  return `https://github.com/o/${hydraId}/pull/${input.number}`
}

// Node built-ins only: the workflow runs this without installing anything.
const PREFIX = '<!-- pnyx-checks:v1 '
const SUFFIX = ' -->'
const HINT = 'Complete the three review checklists, tick the PR boxes, and run `pnpm verify` on the clean, pushed PR head.'
export const REVIEW_CHECKLISTS = [
  'review-code',
  'audit-tests',
  'deslop',
] as const
const MAX_DOCS_COMMITS = 20
// GitHub's commit endpoint lists at most 300 files, so a list that long may be cut short.
const COMMIT_FILES_PAGE = 300

export class MarkerError extends Error {}

export function reviewBlockers({ body }: { body: string }): string[] {
  const lines: string[] = []
  let fence: string | undefined

  for (const line of body.replaceAll(
    /<!--[\s\S]*?(?:-->|$)/g,
    '',
  ).split('\n')) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]

    if (delimiter) {
      if (!fence) {
        fence = delimiter
      } else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) {
        fence = undefined
      }

      continue
    }

    if (!fence) {
      lines.push(line)
    }
  }

  return REVIEW_CHECKLISTS.filter(name => {
    const boxes = lines.flatMap(line => {
      const match = new RegExp('^[-*] \\[([ xX])\\] Ran `' + name + '`\\s*$').exec(line)

      return match ? [match[1]] : []
    })

    return boxes.length !== 1 || boxes[0]?.toLowerCase() !== 'x'
  }).map(name => `complete ${name} and tick its PR checkbox`)
}

export interface Marker {
  head_sha: string
  head_tree: string
  finished_at: string
}

export interface Commit {
  tree: string
  parents: string[]
  // null when GitHub cut the list short, which never counts as docs-only.
  files: string[] | null
}

export interface PullRequest {
  number: number
  body: string
}

// The response of GitHub's commits/{sha} endpoint.
export interface GitHubCommit {
  commit: { tree: { sha: string } }
  parents: { sha: string }[]
  files: {
    filename: string
    previous_filename?: string
  }[]
}

function isMarkerLine({ line }: { line: string }): boolean {
  return line.startsWith(PREFIX) && line.trimEnd().endsWith(SUFFIX)
}

// Markdown no build or test reads: shipped skills and test fixtures count as code.
export function isDocs({ file }: { file: string }): boolean {
  return file.endsWith('.md') && !file.startsWith('skills/') && !file.startsWith('test/')
}

export function commitFacts({ found }: { found: GitHubCommit }): Commit {
  // A rename counts by both paths, so moving code into a .md file is not docs-only.
  const files = found.files.flatMap(file => file.previous_filename ? [
    file.filename,
    file.previous_filename,
  ] : [file.filename])

  return {
    tree: found.commit.tree.sha,
    parents: found.parents.map(parent => parent.sha),
    files: found.files.length < COMMIT_FILES_PAGE ? files : null,
  }
}

export function withMarker({
  body,
  marker,
}: {
  body: string
  marker: Marker
}): string {
  const kept = body.split('\n').filter(line => !isMarkerLine({ line }))
    .join('\n')
    .trim()

  return [
    kept,
    `${PREFIX}${JSON.stringify(marker)}${SUFFIX}`,
  ].filter(Boolean).join('\n\n')
}

export function parseMarker({ body }: { body: string }): Marker {
  const lines = body.split('\n').filter(line => isMarkerLine({ line }))

  if (lines.length === 0) {
    throw new MarkerError(`No checks marker in the PR body. ${HINT}`)
  }

  if (lines.length > 1) {
    throw new MarkerError(`The PR body has ${lines.length} checks markers, expected one. ${HINT}`)
  }

  const payload = lines[0]!.trimEnd().slice(
    PREFIX.length,
    -SUFFIX.length,
  )
  let value: Partial<Record<keyof Marker, unknown>> | null

  try {
    value = JSON.parse(payload)
  } catch {
    value = null
  }

  const headSha = value?.head_sha
  const headTree = value?.head_tree
  const finishedAt = value?.finished_at

  if (typeof headSha !== 'string' || typeof headTree !== 'string' || typeof finishedAt !== 'string') {
    throw new MarkerError(`The checks marker needs head_sha, head_tree and finished_at. ${HINT}`)
  }

  return {
    head_sha: headSha,
    head_tree: headTree,
    finished_at: finishedAt,
  }
}

function testedTree({ body }: { body: string }): string | undefined {
  try {
    return parseMarker({ body }).head_tree
  } catch (error) {
    if (error instanceof MarkerError) {
      return undefined
    }

    throw error
  }
}

// Why `pnpm verify` may not write the marker; empty when it may.
export function markerBlockers({
  failedSteps,
  changedPaths,
  headSha,
  headAfter,
  pullRequestHead,
  pullRequestBody,
}: {
  failedSteps: number
  changedPaths: number
  headSha: string
  headAfter: string
  pullRequestHead: string | undefined
  pullRequestBody: string
}): string[] {
  const blockers = reviewBlockers({ body: pullRequestBody })

  if (failedSteps > 0) {
    blockers.push(`${failedSteps} step(s) failed`)
  }

  if (changedPaths > 0) {
    blockers.push('the tree has uncommitted changes')
  }

  if (headAfter !== headSha) {
    blockers.push('HEAD moved during the run')
  }

  if (pullRequestHead === undefined) {
    blockers.push('no open PR for this branch')
  } else if (pullRequestHead !== headSha) {
    blockers.push(`HEAD ${headSha} is not the PR head ${pullRequestHead}, push first`)
  }

  return blockers
}

// Passes when the marker names the head. Otherwise it walks back from the head while
// each commit changed only docs, and passes at the first commit whose tree a marker
// tested: this PR's own (a docs commit or a same-code rebase after the run) or another
// PR's linked to that commit (the same code already checked elsewhere).
export async function checkPullRequest({
  body,
  headSha,
  commit,
  pullRequestsFor,
}: {
  body: string
  headSha: string
  commit({ sha }: { sha: string }): Promise<Commit>
  pullRequestsFor({ sha }: { sha: string }): Promise<PullRequest[]>
}): Promise<string> {
  const reviews = reviewBlockers({ body })

  if (reviews.length) {
    throw new MarkerError(`Review checklists incomplete: ${reviews.join('; ')}. ${HINT}`)
  }

  let own: Marker | undefined
  let ownError: MarkerError | undefined

  try {
    own = parseMarker({ body })
  } catch (error) {
    if (!(error instanceof MarkerError)) {
      throw error
    }

    ownError = error
  }

  if (own?.head_sha === headSha) {
    return `Checks passed for ${headSha}.`
  }

  let sha = headSha

  for (let step = 0; step <= MAX_DOCS_COMMITS; step++) {
    const [
      walked,
      linked,
    ] = await Promise.all([
      commit({ sha }),
      pullRequestsFor({ sha }),
    ])
    const docsNote = sha === headSha ? '' : `, and only docs changed after ${sha}`

    if (own?.head_tree === walked.tree) {
      return `Checks passed for ${headSha}: the run on ${own.head_sha} tested the same code${docsNote}.`
    }

    const other = linked.find(pr => testedTree({ body: pr.body }) === walked.tree)

    if (other) {
      return `Checks passed for ${headSha}: PR #${other.number}'s run tested the same code${docsNote}.`
    }

    if (walked.parents.length === 0 || !walked.files?.every(file => isDocs({ file }))) {
      break
    }

    sha = walked.parents[0]!
  }

  throw ownError ?? new MarkerError(`The checks marker is for ${own?.head_sha}, but the PR head is ${headSha} and its code changed since. ${HINT}`)
}

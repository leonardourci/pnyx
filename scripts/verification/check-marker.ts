// The "pnpm verify" check:
// GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo PR_NUMBER=<n> node scripts/verification/check-marker.ts
import {
  checkPullRequest,
  commitFacts,
  type GitHubCommit,
  MarkerError,
  type PullRequest,
} from './marker.ts'

async function github<T>({ endpoint }: { endpoint: string }): Promise<T> {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`,
    {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
      },
    },
  )

  if (!response.ok) {
    throw new MarkerError(`Could not read ${endpoint} from the GitHub API (HTTP ${response.status}), failing closed.`)
  }

  return await response.json() as T
}

async function pullRequestsFor({ sha }: { sha: string }): Promise<PullRequest[]> {
  const found = await github<{
    number: number
    body: string | null
  }[]>({ endpoint: `commits/${sha}/pulls` })

  return found.map(pr => ({
    number: pr.number,
    body: pr.body ?? '',
  }))
}

try {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY || !process.env.PR_NUMBER) {
    throw new MarkerError('Set GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER.')
  }

  const pr = await github<{
    body: string | null
    head: { sha: string }
    changed_files: number
  }>({ endpoint: `pulls/${process.env.PR_NUMBER}` })

  const files: string[] = []
  let count = 0

  // GitHub caps this endpoint at 3,000 files; incomplete scope requires every review.
  if (pr.changed_files <= 3000) {
    for (let page = 1; page <= Math.ceil(pr.changed_files / 100); page++) {
      const found = await github<GitHubCommit['files']>({
        endpoint: `pulls/${process.env.PR_NUMBER}/files?per_page=100&page=${page}`,
      })
      count += found.length
      files.push(...found.flatMap(file => file.previous_filename
        ? [
          file.filename,
          file.previous_filename,
        ] : [file.filename]))
    }
  }

  console.log(await checkPullRequest({
    files: count === pr.changed_files ? files : null,
    body: pr.body ?? '',
    headSha: pr.head.sha,
    commit: async ({ sha }) => commitFacts({ found: await github<GitHubCommit>({ endpoint: `commits/${sha}` }) }),
    pullRequestsFor,
  }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

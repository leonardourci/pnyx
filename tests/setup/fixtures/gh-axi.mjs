#!/usr/bin/env node
// gh-axi for tests: reads each pull request from $OTHRYS_FAKE_GITHUB/<owner>/<repo>/<n>.json and logs every call.
// A pull request file may set head, branch, checks, draft, title, comments and mergeBehavior ('merged' by default, or 'queued').
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, watch, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const root = process.env.OTHRYS_FAKE_GITHUB
appendFileSync(
  join(
    root,
    'calls.jsonl',
  ),
  `${JSON.stringify(args)}\n`,
)

if (args.includes('-f') || args.includes('--method')) {
  console.log('error: unsupported gh-axi option\ncode: USAGE')
  process.exit(2)
}

const notFound = ({ number }) => {
  console.log(`error: "Item #${number} does not exist in this repository"\ncode: NOT_FOUND`)
  process.exit(1)
}

const payload = ({ value }) => console.log(`payload: ${JSON.stringify(JSON.stringify(value))}`)
const read = ({ file }) => JSON.parse(readFileSync(
  file,
  'utf8',
))
const HEAD = 'a'.repeat(40)
const MERGE = 'b'.repeat(40)
const DISCOVERY_GATE_BOUND_MS = 20_000

if (args[0] === 'api') {
  const query = args.find(arg => arg.startsWith('query=')) ?? ''
  const route = args.find(arg => arg.startsWith('/'))
  const pulls = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/merge)?$/.exec(route ?? '')
  const repository = /owner:\s*"([^"]+)",name:\s*"([^"]+)"/.exec(query)
  const routeRepo = route?.match(/^\/repos\/([^/]+\/[^/]+)/)?.[1]
  const queryOwner = args.find(arg => arg.startsWith('owner='))?.slice(6)
  const queryName = args.find(arg => arg.startsWith('repo='))?.slice(5)
  const queryRepo = repository ? `${repository[1]}/${repository[2]}` : queryOwner && queryName ? `${queryOwner}/${queryName}` : undefined
  const repo = routeRepo ?? queryRepo
  const evidenceFile = repo ? join(
    root,
    repo,
    'evidence.json',
  ) : undefined
  const evidence = evidenceFile && existsSync(evidenceFile) ? read({ file: evidenceFile }) : {}
  const queued = /pullRequest\(number:(\d+)\)/.exec(query)

  if (pulls) {
    const file = join(
      root,
      pulls[1],
      `${pulls[2]}.json`,
    )

    if (!existsSync(file)) {
      notFound({ number: pulls[2] })
    }

    const pr = read({ file })
    const head = pr.head ?? HEAD

    if (pulls[3]) {
      const sha = args.find(arg => arg.startsWith('sha='))?.slice(4)

      if (sha !== head) {
        console.log('error: HTTP 409: Head branch was modified')
        process.exit(1)
      }

      if (pr.mergeBehavior === 'rejected') {
        console.log('error: HTTP 405: Pull request cannot be merged')
        process.exit(1)
      }

      pr.merges = (pr.merges ?? 0) + 1

      if (pr.mergeBehavior === 'queued') {
        pr.queued = true
      } else {
        pr.state = 'merged'
      }

      writeFileSync(
        file,
        JSON.stringify(pr),
      )
      payload({
        value: {
          merged: pr.state === 'merged',
          sha: pr.state === 'merged' ? MERGE : null,
        },
      })
    } else {
      const merged = pr.state === 'merged'
      payload({
        value: {
          head: {
            sha: head,
            ref: pr.branch ?? 'feature',
          },
          base: { ref: 'main' },
          merged,
          merge_commit_sha: merged ? MERGE : null,
          state: pr.state === 'open' ? 'open' : 'closed',
          draft: Boolean(pr.draft),
        },
      })
    }
  } else if (args.includes('graphql') && queued) {
    const [repo] = [...readdirRepos()]
    const file = join(
      root,
      repo,
      `${queued[1]}.json`,
    )
    const isInMergeQueue = Boolean(read({ file }).queued)
    payload({ value: { data: { repository: { pullRequest: { isInMergeQueue } } } } })
  } else if (args.includes('graphql') && !query.includes('pullRequests(')) {
    const branchProtectionRule = evidence.classicRule ?? null
    payload({ value: { data: { repository: { ref: { branchProtectionRule } } } } })
  } else if (route?.includes('/rules/branches/')) {
    if (evidence.rulesError) {
      console.log(evidence.rulesError)
      process.exit(1)
    }

    payload({ value: evidence.rules ?? [] })
  } else if (route?.includes('/check-runs')) {
    payload({ value: { check_runs: evidence.checkRuns ?? [] } })
  } else if (route?.includes('/statuses')) {
    payload({ value: [] })
  } else if (route?.match(/^\/repos\/[^/]+\/[^/]+\/pulls$/) || (args.includes('graphql') && query.includes('pullRequests('))) {
    const graphql = args.includes('graphql')
    const head = args.find(arg => arg.startsWith('head='))?.slice(5)
    const owner = head?.split(':')[0]
    const branch = graphql ? args.find(arg => arg.startsWith('branch='))?.slice(7) : head?.split(':').slice(1)
      .join(':')
    const discoveryPayload = ({ value }) => payload({
      value: graphql ? { data: { repository: { pullRequests: { nodes: value } } } } : value,
    })
    const gate = join(
      root,
      'discovery-gate.json',
    )

    if (existsSync(gate) && read({ file: gate }).branch === branch) {
      await new Promise((
        resolve,
        reject,
      ) => {
        const timer = setTimeout(
          () => {
            watcher.close()
            unlinkSync(`${gate}.ready`)
            reject(new Error('discovery gate was not released'))
          },
          DISCOVERY_GATE_BOUND_MS,
        )
        const watcher = watch(
          gate,
          () => {
            if (!existsSync(gate)) {
              watcher.close()
              clearTimeout(timer)
              unlinkSync(`${gate}.ready`)
              resolve()
            }
          },
        )
        writeFileSync(
          `${gate}.ready`,
          branch,
        )
      })
    }

    const folder = join(
      root,
      repo,
    )
    const malformed = join(
      root,
      'malformed-discovery',
    )

    if (existsSync(malformed) && read({ file: malformed }).branch === branch) {
      writeFileSync(
        `${malformed}.read`,
        branch,
      )
      discoveryPayload({ value: [null] })
      process.exit(0)
    }

    const requests = existsSync(folder) ? readdirSync(folder).filter(name => /^\d+\.json$/.test(name))
      .filter(name => read({
        file: join(
          folder,
          name,
        ),
      }).branch === branch && (!owner || (read({
        file: join(
          folder,
          name,
        ),
      }).sourceOwner ?? repo.split('/')[0]) === owner))
      .map(name => {
        const url = `https://github.com/${repo}/pull/${name.slice(
          0,
          -5,
        )}`

        return graphql ? { url } : { html_url: url }
      }) : []
    discoveryPayload({ value: requests })
  } else {
    console.log('error: unsupported fake GitHub request\ncode: NOT_FOUND')
    process.exit(1)
  }
} else {
  const repo = args[args.indexOf('--repo') + 1]
  const number = args[2]
  const file = join(
    root,
    repo ?? '',
    `${number}.json`,
  )

  if (!repo || !existsSync(file) || !(args[0] === 'pr' && args[1] === 'view')) {
    notFound({ number })
  }

  const pr = read({ file })
  console.log(`pull_request:
  number: ${number}
  title: ${JSON.stringify(pr.title ?? `Pull request ${number}`)}
  state: ${pr.state}
  draft: ${pr.draft ? 'yes' : 'no'}
  checks: ${JSON.stringify(pr.checks ?? '0 passed, 0 failed')}
  comment_count: ${pr.comments ?? 0}
  review_count: 0`)
}

// The one repository folder the test wrote pull requests into, for a call that names only a number.
function readdirRepos() {
  const repos = []

  for (const owner of readdirSync(
    root,
    { withFileTypes: true },
  ).filter(entry => entry.isDirectory())) {
    for (const repo of readdirSync(
      join(
        root,
        owner.name,
      ),
      { withFileTypes: true },
    ).filter(entry => entry.isDirectory())) {
      repos.push(`${owner.name}/${repo.name}`)
    }
  }

  return repos
}

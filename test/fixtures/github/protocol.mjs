import { appendFileSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const root = process.env.PNYX_FAKE_GITHUB
const flag = ({ name }) => args[args.indexOf(name) + 1]

const fail = ({ message }) => {
  console.error(message)
  process.exit(1)
}

const save = ({
  file,
  pr,
}) => {
  writeFileSync(
    `${file}.next`,
    JSON.stringify(pr),
  )
  renameSync(
    `${file}.next`,
    file,
  )
}

const emitPayload = ({ value }) => console.log(`payload: ${JSON.stringify(JSON.stringify(value))}`)
let repo
let number
let path

if (args[0] === 'pr') {
  repo = flag({ name: '--repo' })
  number = args[2]
} else if (args[0] === 'api') {
  path = args.find(arg => arg.startsWith('/repos/'))

  if (path) {
    const parts = path.split('/')
    repo = `${parts[2]}/${parts[3]}`

    if (parts[4] === 'pulls') {
      number = parts[5]
    }
  } else {
    const query = args.find(arg => arg.startsWith('query='))?.slice(6) ?? ''
    repo = `${/owner:"([^"]+)"/.exec(query)?.[1]}/${/name:"([^"]+)"/.exec(query)?.[1]}`
    number = /pullRequest\(number:(\d+)\)/.exec(query)?.[1]
  }
}

if (!repo) {
  fail({ message: 'unknown fake GitHub request' })
}

const directory = join(
  root,
  repo,
)

if (!number) {
  number = readdirSync(directory).find(name => /^\d+$/.test(name))
}

const file = join(
  directory,
  number,
)
const page = Number(new URL(
  path ?? '/',
  'https://github.test',
).searchParams.get('page') ?? 1)
const pageItems = ({ items }) => items.slice(
  (page - 1) * 100,
  page * 100,
)
const pr = JSON.parse(readFileSync(
  file,
  'utf8',
))
appendFileSync(
  join(
    directory,
    'calls',
  ),
  `${JSON.stringify(args)}\n`,
)

if (pr.readbackFailed) {
  fail({ message: 'GitHub readback unavailable' })
}

if (args[0] === 'pr' && args[1] === 'view') {
  console.log(`pull_request:
  number: ${number}
  title: "Pull request ${number}"
  state: ${pr.state}
  draft: ${pr.draft ? 'yes' : 'no'}
  checks: ${JSON.stringify(pr.checks)}
  comment_count: ${pr.comments}
  review_count: 0`)
} else if (args.includes('PUT') || (args[0] === 'pr' && args[1] === 'merge')) {
  appendFileSync(
    `${file}.arguments`,
    `${JSON.stringify(args)}\n`,
  )
  const fields = args.filter(arg => arg.includes('=') && !arg.startsWith('/'))
  const sha = args[0] === 'pr' ? pr.head : fields.find(arg => arg.startsWith('sha='))?.slice(4)

  if (pr.pushBeforeMerge) {
    pr.head = pr.pushBeforeMerge
    save({
      file,
      pr,
    })
  }

  if (sha !== pr.head) {
    fail({ message: 'Head branch was modified' })
  }

  if (!fields.includes('merge_method=merge') && !args.includes('--merge')) {
    fail({ message: 'merge method is required' })
  }

  if (pr.mergeBehavior === 'rejected') {
    fail({ message: 'Pull request is not mergeable' })
  }

  appendFileSync(
    `${file}.merges`,
    'accepted\n',
  )

  if (pr.mergeBehavior === 'merged') {
    pr.state = 'merged'
  }

  if (pr.mergeBehavior === 'queued') {
    pr.queued = true
  }

  if (pr.mergeBehavior === 'readback-failed') {
    pr.readbackFailed = true
  }

  save({
    file,
    pr,
  })
  emitPayload({
    value: {
      merged: pr.state === 'merged',
      sha: pr.state === 'merged' ? pr.merge : null,
    },
  })
} else if (path?.includes('/rules/branches/')) {
  if (pr.unreadable === 'rules') {
    fail({ message: 'branch rules unreadable' })
  }

  emitPayload({
    value: page > 1 ? [] : pr.required.length ? [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: pr.required.map(check => ({
            context: check.context,
            integration_id: check.app ?? null,
          })),
        },
      },
    ] : [],
  })
} else if (path?.includes('/check-runs')) {
  if (pr.unreadable === 'runs') {
    fail({ message: 'check producers unreadable' })
  }

  const head = path.split('/')[5]
  emitPayload({
    value: {
      check_runs: head === pr.head ? pageItems({ items: pr.runs }).map((
        run,
        index,
      ) => ({
        id: index + 1,
        name: run.name,
        head_sha: pr.head,
        app: { id: run.app },
        status: run.status ?? (run.conclusion ? 'completed' : 'in_progress'),
        conclusion: run.conclusion,
      })) : [],
    },
  })
} else if (path?.includes('/statuses')) {
  if (pr.unreadable === 'statuses') {
    fail({ message: 'commit statuses unreadable' })
  }

  emitPayload({ value: pageItems({ items: pr.statuses }) })
} else if (path?.includes('/pulls/')) {
  if (args.includes('.head.sha + " " + (.merge_commit_sha // "") + " " + (.merged|tostring)')) {
    console.log(`response:\n  body: "${pr.head} ${pr.merge} ${pr.state === 'merged'}"`)
  } else {
    emitPayload({
      value: {
        head: { sha: pr.head },
        base: { ref: pr.base },
        merged: pr.state === 'merged',
        merge_commit_sha: pr.state === 'merged' ? pr.merge : null,
        state: pr.state === 'open' ? 'open' : 'closed',
        draft: pr.draft,
      },
    })
  }
} else if (args.includes('graphql')) {
  if (!args.includes('POST')) {
    fail({ message: 'GraphQL queries require POST' })
  }

  const query = args.find(arg => arg.startsWith('query=')) ?? ''

  if (query.includes('branchProtectionRule')) {
    if (pr.unreadable === 'legacy') {
      fail({ message: 'classic protection unreadable' })
    }

    emitPayload({
      value: {
        data: {
          repository: {
            ref: {
              branchProtectionRule: {
                requiresStatusChecks: pr.legacy.length > 0,
                requiredStatusChecks: pr.legacy.map(check => ({
                  context: check.context,
                  app: check.app ? { databaseId: check.app } : null,
                })),
              },
            },
          },
        },
      },
    })
  } else {
    emitPayload({
      value: { data: { repository: { pullRequest: { isInMergeQueue: pr.queued ?? false } } } },
    })
  }
} else {
  fail({ message: 'unsupported fake GitHub request' })
}

// Runs the test workflow's steps in Docker on the Ubuntu release GitHub's runners use, limited to a
// public runner's size, so a failure GitHub would hit shows up locally first.
// Usage: node scripts/github-run.ts [--cpus=4] [--memory=16g] [step...]
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const IMAGE = 'pnyx-github-run:ubuntu-24.04'
// GitHub's runners are x86_64 Ubuntu 24.04 with Node from setup-node and Google Chrome installed.
const DOCKERFILE = `FROM --platform=linux/amd64 ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git gnupg netcat-openbsd procps xz-utils \\
  && curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \\
  && apt-get install -y --no-install-recommends /tmp/chrome.deb && rm /tmp/chrome.deb \\
  && curl -fsSL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 \\
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1001 runner
USER runner
`
const STEPS: Record<string, string> = {
  lint: 'pnpm run lint',
  build: 'pnpm run build',
  unit: 'node scripts/test.ts unit',
  scenarios: 'node scripts/test.ts scenarios',
}

const args = process.argv.slice(2)
const option = ({
  name,
  fallback,
}: {
  name: string
  fallback: string
}) =>
  args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const steps = args.filter(arg => !arg.startsWith('--'))
const unknown = steps.filter(step => !STEPS[step])

if (unknown.length) {
  console.error(`github-run: unknown steps ${unknown.join(', ')}; use ${Object.keys(STEPS).join(', ')}`)
  process.exit(1)
}

const build = spawnSync(
  'docker',
  [
    'build',
    '--platform=linux/amd64',
    '--tag',
    IMAGE,
    '-',
  ],
  {
    input: DOCKERFILE,
    stdio: [
      'pipe',
      'inherit',
      'inherit',
    ],
  },
)

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

// The working tree as git sees it, uncommitted changes included, without node_modules or builds.
const files = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ],
  { encoding: 'utf8' },
).split('\0')
  .filter(path => path && existsSync(path))
// Every step runs even after one fails, so one run reports all failures.
const commands = (steps.length ? steps : Object.keys(STEPS)).map(step =>
  `{ echo "github-run: ${step}"; ${STEPS[step]} || { echo "github-run: ${step} failed"; failed=1; }; }`)
const run = spawn(
  'docker',
  [
    'run',
    '--rm',
    '-i',
    '--platform=linux/amd64',
    `--cpus=${option({
      name: 'cpus',
      fallback: '4',
    })}`,
    `--memory=${option({
      name: 'memory',
      fallback: '16g',
    })}`,
    '--shm-size=2g',
    // Chrome's sandbox needs the namespaces Docker's default seccomp profile denies; a runner VM has them.
    '--security-opt=seccomp=unconfined',
    IMAGE,
    'bash',
    '-euo',
    'pipefail',
    '-c',
    [
      'mkdir -p ~/work && cd ~/work && tar -xf -',
      'mkdir -p ~/.local/bin && corepack enable --install-directory ~/.local/bin && export PATH=~/.local/bin:$PATH',
      'pnpm install --frozen-lockfile',
      'nproc && free -g',
      'failed=0',
      ...commands,
      'exit $failed',
    ].join(' && '),
  ],
  {
    stdio: [
      'pipe',
      'inherit',
      'inherit',
    ],
  },
)
const tar = spawn(
  'tar',
  [
    '--null',
    '--no-xattrs',
    '-T',
    '-',
    '-cf',
    '-',
  ],
  {
    // Keeps macOS tar from adding resource-fork entries.
    env: {
      ...process.env,
      COPYFILE_DISABLE: '1',
    },
    stdio: [
      'pipe',
      run.stdin,
      'inherit',
    ],
  },
)
tar.stdin.end(files.join('\0'))
run.on(
  'exit',
  code => {
    process.exitCode = code ?? 1
  },
)

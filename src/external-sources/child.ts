import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ExternalSource, SourceOutcome } from './model.ts'

export interface ChildResult {
  outcome: SourceOutcome
  stdout: string
  stderr: string
  detail: string
}

// This entry owns the process group so loss of the server's IPC channel also stops the source.
let child: ChildProcess | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let stopping = false

function decodeOutput({
  bytes,
  limit,
}: {
  bytes: Buffer
  limit: number
}): string {
  const decoded = Buffer.from(bytes.toString('utf8'))

  return new TextDecoder().decode(
    decoded.subarray(
      0,
      limit,
    ),
    { stream: true },
  )
}

function killSource() {
  if (child?.pid) {
    try {
      process.kill(
        -child.pid,
        'SIGKILL',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  }
}

process.once(
  'disconnect',
  () => {
    stopping = true
    killSource()
    clearTimeout(timer)
  },
)
process.once(
  'message',
  (source: ExternalSource) => {
    if (stopping) {
      return
    }

    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let outcome: SourceOutcome | undefined
    let detail = ''
    let finished = false

    const finish = ({ result }: { result: ChildResult }) => {
      if (finished) {
        return
      }

      finished = true
      clearTimeout(timer)
      killSource()

      if (process.connected) {
        process.send?.(
          result,
          () => process.disconnect(),
        )
      }
    }

    try {
      const digest = createHash('sha256').update(readFileSync(source.command.executable))
        .digest('hex')

      if (digest !== source.command.digest) {
        throw new Error('Registered executable changed; register a new source after checking it')
      }

      child = spawn(
        source.command.executable,
        source.lavish?.reply && !source.lavish.reply.accepted
          ? [
            'reply',
            source.lavish.page,
            '--agent-reply',
            source.lavish.reply.text,
          ]
          : source.command.argv,
        {
          cwd: source.command.cwd,
          shell: false,
          detached: true,
          stdio: [
            'ignore',
            'pipe',
            'pipe',
          ],
        },
      )
    } catch (error) {
      finish({
        result: {
          outcome: 'failed',
          stdout: '',
          stderr: '',
          detail: (error as Error).message,
        },
      })

      return
    }

    const capture = ({
      chunk,
      stream,
    }: {
      chunk: Buffer
      stream: 'stdout' | 'stderr'
    }) => {
      const remaining = Math.max(
        0,
        source.maxBytes - stdout.length - stderr.length,
      )
      const captured = chunk.subarray(
        0,
        remaining,
      )

      if (stream === 'stdout') {
        stdout = Buffer.concat([
          stdout,
          captured,
        ])
      } else {
        stderr = Buffer.concat([
          stderr,
          captured,
        ])
      }

      if (chunk.length > remaining) {
        outcome = 'overflow'
        detail = `Source exceeded its ${source.maxBytes}-byte output limit`
        killSource()
      }
    }

    child.stdout?.on(
      'data',
      (chunk: Buffer) => capture({
        chunk,
        stream: 'stdout',
      }),
    )
    child.stderr?.on(
      'data',
      (chunk: Buffer) => capture({
        chunk,
        stream: 'stderr',
      }),
    )
    child.once(
      'error',
      error => {
        outcome = 'failed'
        detail = error.message
      },
    )
    child.once(
      'exit',
      () => killSource(),
    )
    child.once(
      'close',
      (
        code,
        signal,
      ) => {
        if (stopping) {
          return
        }

        const capturedStdout = decodeOutput({
          bytes: stdout,
          limit: source.maxBytes,
        })
        const remaining = source.maxBytes - Buffer.byteLength(capturedStdout)
        const capturedStderr = decodeOutput({
          bytes: stderr,
          limit: remaining,
        })
        finish({
          result: {
            outcome: outcome ?? (code === 0 ? 'completed' : 'failed'),
            stdout: capturedStdout,
            stderr: capturedStderr,
            detail: detail || `Child exited with code ${code}, signal ${signal ?? 'none'}`,
          },
        })
      },
    )
    timer = setTimeout(
      () => {
        outcome = 'expired'
        detail = 'Source reached its timeout or registration expiry'
        killSource()
      },
      Math.min(
        source.timeoutMs,
        Math.max(
          1,
          Date.parse(source.expiresAt) - Date.now(),
        ),
      ),
    )
  },
)

import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { privateDir, writeDurably } from '#store/storage.ts'
import { fail } from './protocol.ts'
import { kernelBootIdentity, verifiedBootChange } from './boot.ts'

const SOCKET_PATH_BYTES = 100
const PROBE_MS = 5000

export function processStart({ pid }: { pid: number }): string | undefined {
  try {
    return execFileSync(
      '/bin/ps',
      [
        '-o',
        'lstart=',
        '-p',
        String(pid),
      ],
      { encoding: 'utf8' },
    ).trim() || undefined
  } catch {
    return undefined
  }
}

const alive = ({ pid }: { pid: number }) => {
  try {
    process.kill(
      pid,
      0,
    )

    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }

    return true
  }
}

export function claimHost({
  directory,
  installation,
  bootIdentity = kernelBootIdentity,
}: {
  directory: string
  installation: string
  bootIdentity?(): string | undefined
}) {
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    fail({
      code: 'INVALID_DIRECTORY',
      message: 'Use a private canonical native host directory',
    })
  }

  privateDir({ dir: directory })

  if (realpathSync(directory) !== directory) {
    fail({
      code: 'INVALID_DIRECTORY',
      message: 'Use a canonical native host directory',
    })
  }

  const socket = join(
    directory,
    'host.sock',
  )

  if (Buffer.byteLength(socket) > SOCKET_PATH_BYTES) {
    fail({
      code: 'SOCKET_PATH',
      message: 'Use a shorter private runtime directory for the local socket',
    })
  }

  const lock = join(
    directory,
    'owner.json',
  )
  const reclaim = join(
    directory,
    'reclaim',
  )
  const installationPath = join(
    directory,
    'installation',
  )

  if (existsSync(installationPath) && readFileSync(
    installationPath,
    'utf8',
  ) !== installation) {
    fail({
      code: 'INSTALLATION_MISMATCH',
      message: 'The runtime directory belongs to another installation',
    })
  }

  const start = processStart({ pid: process.pid })

  if (!start) {
    fail({
      code: 'RECOVERY_REQUIRED',
      message: 'The host could not establish its process-start identity',
    })
  }

  const boot = bootIdentity()
  const record = JSON.stringify({
    boot,
    instance: randomUUID(),
    pid: process.pid,
    start,
    installation,
  })
  let fd: number

  try {
    fd = openSync(
      lock,
      'wx',
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }

    let previous: {
      pid: number
      start: string
      installation: string
      boot?: string
    }
    let saved: string

    try {
      saved = readFileSync(
        lock,
        'utf8',
      ); previous = JSON.parse(saved)
    } catch {
      return fail({
        code: 'STARTING',
        message: 'A host claim is incomplete; preserve it until its owner is established',
      })
    }

    if (previous.installation !== installation) {
      return fail({
        code: 'INSTALLATION_MISMATCH',
        message: 'The runtime directory belongs to another installation',
      })
    }

    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.start !== 'string') {
      return fail({
        code: 'RECOVERY_REQUIRED',
        message: 'The old host identity is not verifiable',
      })
    }

    const rebooted = verifiedBootChange({
      before: previous.boot,
      after: boot,
    })

    if (!rebooted && alive({ pid: previous.pid })) {
      return fail({
        code: 'ALREADY_RUNNING',
        message: 'A live process still holds the native host claim',
      })
    }

    try {
      mkdirSync(
        reclaim,
        { mode: 0o700 },
      )
    } catch {
      return fail({
        code: 'STARTING',
        message: 'Another starter is reconciling the native host claim',
      })
    }

    try {
      if (readFileSync(
        lock,
        'utf8',
      ) !== saved || !rebooted && alive({ pid: previous.pid })) {
        return fail({
          code: 'STARTING',
          message: 'Native host ownership changed during discovery',
        })
      }

      rmSync(lock)
      fd = openSync(
        lock,
        'wx',
        0o600,
      )
    } finally {
      rmSync(
        reclaim,
        { recursive: true },
      )
    }
  }

  writeFileSync(
    fd,
    record,
  )
  fsyncSync(fd)
  const inode = fstatSync(fd).ino
  closeSync(fd)
  let socketInode: number | undefined

  const release = () => {
    const ours = existsSync(lock) && lstatSync(lock).ino === inode && readFileSync(
      lock,
      'utf8',
    ) === record

    if (!ours) {
      return
    }

    rmSync(lock)

    if (socketInode && existsSync(socket) && lstatSync(socket).ino === socketInode) {
      rmSync(socket)
    }
  }

  try {
    if (!existsSync(installationPath)) {
      writeDurably({
        path: installationPath,
        data: installation,
        flag: 'w',
      })
    }

    const tokenPath = join(
      directory,
      'token',
    )

    if (existsSync(tokenPath) && !lstatSync(tokenPath).isFile()) {
      fail({
        code: 'AUTH_FILE',
        message: 'The native host token must be a private regular file',
      })
    }

    if (!existsSync(tokenPath)) {
      writeDurably({
        path: tokenPath,
        data: randomBytes(32).toString('hex'),
        flag: 'w',
      })
    }

    chmodSync(
      tokenPath,
      0o600,
    )
    const token = readFileSync(
      tokenPath,
      'utf8',
    )

    return {
      socket,
      token,
      boot,
      release,
      bound() {
        socketInode = lstatSync(socket).ino
      },
      async prepareSocket() {
        if (!existsSync(socket)) {
          return
        }

        const before = lstatSync(socket)

        if (!before.isSocket()) {
          return fail({
            code: 'SOCKET_PATH',
            message: 'The socket path contains an unrelated file',
          })
        }

        const status = await new Promise<string>(resolve => {
          const probe = createConnection(socket)
          const timeout = setTimeout(
            () => {
              probe.destroy(); resolve('UNKNOWN')
            },
            PROBE_MS,
          )
          probe.once(
            'connect',
            () => {
              // Drain peer output so probing cannot reset an unrelated service.
              probe.end(); probe.resume()
            },
          )
          probe.once(
            'close',
            () => {
              clearTimeout(timeout); resolve('LIVE')
            },
          )
          probe.once(
            'error',
            error => {
              clearTimeout(timeout); probe.destroy(); resolve((error as NodeJS.ErrnoException).code ?? 'UNKNOWN')
            },
          )
        })

        if (![
          'ECONNREFUSED',
          'ENOENT',
        ].includes(status)) {
          return fail({
            code: 'SOCKET_IN_USE',
            message: 'The existing native socket is live or its ownership is unknown',
          })
        }

        if (existsSync(socket)) {
          if (lstatSync(socket).ino !== before.ino) {
            return fail({
              code: 'SOCKET_IN_USE',
              message: 'The socket path changed during discovery',
            })
          }

          rmSync(socket)
        }
      },
    }
  } catch (error) {
    release(); throw error
  }
}

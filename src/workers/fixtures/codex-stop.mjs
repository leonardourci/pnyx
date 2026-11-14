import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const children = []
const threadId = 'synthetic-stop-thread'
const turnId = 'synthetic-stop-turn'
const foregroundCommand = 'echo started > started; sleep 120; echo completed > completed'
const actionCommand = 'echo started > started-action; sleep 120; echo completed > completed-action'

function send({ message }) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function launch({ command }) {
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      command,
    ],
    {
      stdio: 'ignore',
      detached: true,
    },
  )
  children.push(child)

  return child
}

const earlier = launch({ command: 'sleep 121' })

createInterface({ input: process.stdin }).on(
  'line',
  line => {
    const request = JSON.parse(line)

    if (request.id === undefined) {
      return
    }

    let result = {}

    if (request.method === 'config/read') {
      result = { config: {} }
    }

    if (request.method === 'thread/start') {
      result = { thread: { id: threadId } }
    }

    if (request.method === 'turn/start') {
      result = { turn: { id: turnId } }
    }

    send({
      message: {
        id: request.id,
        result,
      },
    })

    if (request.method === 'turn/start') {
      const background = launch({ command: 'sleep 122' })
      const foreground = launch({ command: foregroundCommand })
      const action = launch({ command: actionCommand })
      writeFileSync(
        'pids.json',
        JSON.stringify({
          earlier: earlier.pid,
          background: background.pid,
          foreground: foreground.pid,
          action: action.pid,
        }),
      )
      send({
        message: {
          method: 'item/started',
          params: {
            threadId,
            turnId,
            item: {
              id: 'background',
              type: 'commandExecution',
              command: 'sleep 122',
            },
          },
        },
      })
      send({
        message: {
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: {
              id: 'background',
              type: 'commandExecution',
              command: 'sleep 122',
              status: 'completed',
            },
          },
        },
      })
    }

    if (request.method === 'turn/interrupt') {
      send({
        message: {
          method: 'item/started',
          params: {
            threadId,
            turnId,
            item: {
              id: 'foreground',
              type: 'commandExecution',
              command: [
                '/bin/sh',
                '-c',
                foregroundCommand,
              ],
            },
          },
        },
      })
      send({
        message: {
          method: 'item/started',
          params: {
            threadId,
            turnId,
            item: {
              id: 'action',
              type: 'commandExecution',
              command: `/bin/sh -c '${actionCommand}'`,
              commandActions: [
                {
                  type: 'unknown',
                  command: actionCommand,
                },
              ],
            },
          },
        },
      })
      // The provider must clean up; this fake leaves its commands running after the interrupted result.
      send({
        message: {
          method: 'turn/completed',
          params: {
            threadId,
            turn: {
              id: turnId,
              status: 'interrupted',
              error: null,
            },
          },
        },
      })
    }
  },
)

process.on(
  'SIGTERM',
  () => {
    for (const child of children) {
      try {
        process.kill(
          -child.pid,
          'SIGKILL',
        )
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error
        }
      }
    }

    process.exit(0)
  },
)

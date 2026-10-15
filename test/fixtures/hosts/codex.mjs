import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

let turn = 0, threadId, waiting, held
const path = process.env.FAKE_CODEX_TRANSCRIPT
const send = ({ ...message }) => process.stdout.write(`${JSON.stringify(message)}\n`)

const finish = ({ id, text }) => {
  if (text === 'CRASH') {
    process.exit(9)
  }

  if (text === 'HOLD') {
    held = id

    return
  }

  const status = text === 'FAIL' ? 'failed' : 'completed'
  appendFileSync(path, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Codex: ${text}` }] } })}\n`)
  send({ method: 'turn/completed', params: { threadId, turn: { id, status, error: status === 'failed' ? { message: 'fixture failure' } : null } } })
}

process.on('SIGUSR1', () => finish({ id: held, text: 'released' }))
process.on('SIGUSR2', () => {
  send({ method: 'serverRequest/resolved', params: { threadId, requestId: 'approval' } })
  finish(waiting)
})

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  appendFileSync(process.env.FAKE_CODEX_LOG, `${line}\n`)
  const { id, method, params } = message

  if (method === 'initialize') {
    if (process.env.FAKE_CODEX_REFUSE === 'initialize') {
      return
    }

    const response = JSON.stringify({ id, result: {} })
    process.stdout.write(response.slice(0, 4))
    setImmediate(() => process.stdout.write(`${response.slice(4)}\n`))
  } else if (method === 'thread/start' || method === 'thread/resume') {
    if (process.env.FAKE_CODEX_REFUSE === method) {
      send({ id, error: { code: -32000, message: 'fixture refused thread' } })

      return
    }

    threadId = params.threadId ?? '0199f00d-1111-7000-8000-000000000001'
    send({ id, result: { thread: { id: threadId, path } } })
  } else if (method === 'turn/start') {
    const turnId = `turn-${++turn}`
    const text = params.input[0].text
    appendFileSync(path, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })}\n`)

    if (['DENY', 'ALLOW', 'FILE', 'CANCEL', 'PERMISSIONS_ALLOW', 'PERMISSIONS_DENY'].includes(text)) {
      waiting = { id: turnId, text }

      if (text === 'FILE') {
        send({ method: 'item/started', params: { threadId, turnId, item: { id: 'file-item', type: 'fileChange', changes: [{ path: 'allowed.txt', diff: '+approved', kind: { type: 'add' } }] } } })
      }

      send({ id: 'approval', method: text.startsWith('PERMISSIONS_') ? 'item/permissions/requestApproval' : text === 'FILE' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: text === 'FILE' ? 'file-item' : 'command-item', ...(text.startsWith('PERMISSIONS_') ? { permissions: { network: { enabled: true }, fileSystem: null }, reason: 'Network access for this turn' } : text === 'FILE' ? { reason: 'Write a file' } : { command: 'touch allowed.txt', cwd: process.cwd(), reason: 'Run a command' }) } })
    } else {
      // Completion can arrive before the response to turn/start.
      finish({ id: turnId, text })
    }

    send({ id, result: { turn: { id: turnId } } })
  } else if (id === 'approval') {
    if (waiting.text.startsWith('PERMISSIONS_')) {
      const expected = waiting.text === 'PERMISSIONS_ALLOW' ? { network: { enabled: true } } : {}

      if (message.result?.scope !== 'turn' || JSON.stringify(message.result?.permissions) !== JSON.stringify(expected)) {
        process.exit(8)
      }

      finish(waiting)

      return
    }

    const expected = ['ALLOW', 'FILE'].includes(waiting.text) ? 'accept' : 'decline'

    if (message.result?.decision !== expected) {
      process.exit(8)
    }

    finish(waiting)
  }
})

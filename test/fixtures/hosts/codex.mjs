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

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  appendFileSync(process.env.FAKE_CODEX_LOG, `${line}\n`)
  const { id, method, params } = message

  if (method === 'initialize') {
    if (process.env.FAKE_CODEX_REFUSE === 'initialize') { return }
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

    if (text === 'DENY') {
      waiting = { id: turnId, text }
      send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId } })
    } else {
      // Completion can arrive before the response to turn/start.
      finish({ id: turnId, text })
    }

    send({ id, result: { turn: { id: turnId } } })
  } else if (id === 'approval') {
    if (message.result?.decision !== 'decline') {
      process.exit(8)
    }

    finish(waiting)
  }
})

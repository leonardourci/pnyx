#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TIMEOUT_MS = 20_000
const [
  titan,
  name,
  ...args
] = process.argv.slice(2)
const home = process.env.OTHRYS_HOME

if (!home || !titan || !name) {
  throw new Error('A page command needs a scratch home, Titan and command')
}

const { port } = JSON.parse(readFileSync(
  join(
    home,
    'server.json',
  ),
  'utf8',
))
const token = readFileSync(
  join(
    home,
    'token',
  ),
  'utf8',
).trim()
const id = 'checkout-hook'
const socket = new WebSocket(`ws://127.0.0.1:${port}/titan/${titan}/ws?token=${token}`)
const result = await new Promise((
  resolve,
  reject,
) => {
  const timer = setTimeout(
    () => {
      socket.close()
      reject(new Error('Checkout hook command did not answer'))
    },
    TIMEOUT_MS,
  )
  socket.addEventListener(
    'open',
    () => socket.send(JSON.stringify({
      type: 'command',
      id,
      name,
      args,
    })),
  )
  socket.addEventListener(
    'error',
    () => {
      clearTimeout(timer)
      reject(new Error('Checkout hook could not connect'))
    },
  )
  socket.addEventListener(
    'message',
    event => {
      const answer = JSON.parse(event.data)

      if (answer.id !== id) {
        return
      }

      clearTimeout(timer)
      socket.close()

      if (answer.type === 'error') {
        reject(new Error(`${answer.code}: ${answer.error}`))
      } else {
        resolve(answer)
      }
    },
  )
})
console.log(JSON.stringify(result))

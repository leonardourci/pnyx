import type { HomeMessage, HomePage } from '#app/socket-state.ts'
import { applyPageChanges } from '#app/socket-state.ts'
import type { SocketCursor } from '#app/socket-history.ts'
import { openPage } from './page-socket.ts'
import { until } from './until.ts'

export async function openHomePage({
  port,
  titanId,
  previous,
  recordFrames = true,
}: {
  port: number
  titanId?: string
  recordFrames?: boolean
  previous?: {
    home: HomePage
    cursor: SocketCursor
  }
}) {
  const frames: HomeMessage[] = []
  let home = previous?.home
  let cursor = previous?.cursor
  let ready = false
  const page = await openPage({
    port,
    titanId,
    home: true,
    cursor,
    receive({ message }) {
      if (message.type === 'home.snapshot') {
        home = message.home
        cursor = message.cursor
      } else if (message.type === 'home.delta') {
        const follows = cursor?.epoch === message.cursor.epoch
          && cursor.seq + 1 === message.cursor.seq

        if (!home || !follows) {
          throw new Error('The home socket missed an ordered change')
        }

        home = applyPageChanges({
          before: home,
          changes: message.changes,
        })
        cursor = message.cursor
      } else if (message.type === 'home.ready') {
        if (!home || cursor?.seq !== message.cursor.seq || cursor.epoch !== message.cursor.epoch) {
          throw new Error('The home socket became ready before its state')
        }

        ready = true
      }

      const homeFrame = message.type === 'home.snapshot' || message.type === 'home.delta' || message.type === 'home.ready'

      if (recordFrames && homeFrame) {
        frames.push(message)
      }
    },
  })

  try {
    await until({
      what: 'the home socket snapshot and replay',
      check: () => ready,
    })
  } catch (error) {
    page.close()
    throw error
  }

  return {
    ...page,
    frames,
    read: () => ({
      home: home!,
      cursor: cursor!,
    }),
  }
}

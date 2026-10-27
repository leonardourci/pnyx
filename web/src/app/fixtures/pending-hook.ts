import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useHydra, type Command } from '../connection.ts'

interface Fixture {
  command?: Command
  unknownSeen: boolean
  mount(): void
  unmount(): void
}

const container = document.getElementById('root')!
let root: Root
const fixture: Fixture = {
  unknownSeen: false,
  mount: () => {
    root = createRoot(container)
    root.render(createElement(Probe))
  },
  unmount: () => root.unmount(),
}

function Probe() {
  const hydra = useHydra()
  fixture.command = hydra.command

  if (hydra.intents.some(intent => intent.stage === 'unknown')) {
    fixture.unknownSeen = true
  }

  return createElement(
    'output',
    { id: 'probe' },
    JSON.stringify({
      connected: hydra.connected,
      columns: hydra.state.config?.columns,
      intents: hydra.intents,
    }),
  )
}

Object.assign(
  window,
  { pendingFixture: fixture },
)
fixture.mount()

import type { TaskDeclaration } from './model.ts'

// A declared state as shown to people and Hydra: a paused wait names its end, a hold says it has none.
export function declaredState({ declaration }: { declaration: Pick<TaskDeclaration, 'state' | 'until' | 'hold' | 'wait'> }): string {
  if (declaration.wait) {
    return `${declaration.state} waiting for ${declaration.wait.task} (${declaration.wait.condition})`
  }

  if (declaration.until) {
    return `${declaration.state} until ${declaration.until}`
  }

  if (declaration.hold) {
    return `${declaration.state} on hold`
  }

  return declaration.state
}

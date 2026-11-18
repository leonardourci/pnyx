import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { useSortState } from '#web-shared/ui/sortable.tsx'
import { TASK_MODAL_CHANGED } from '#web-tasks/presentation.ts'

interface Target {
  task?: string
  column?: string
  hydra?: string
}

function targetOf({ target }: { target: EventTarget | null }): Target {
  if (!(target instanceof Element)) {
    return {}
  }

  const task = target.closest<HTMLElement>('[data-task]')
  const modal = target.closest<HTMLElement>('[data-task-modal]')
  const body = target.closest<HTMLElement>('main.shell')
  const workspace = body?.closest<HTMLElement>('[data-hydra-workspace]')

  return {
    task: task?.dataset.task ?? modal?.dataset.taskModal,
    column: target.closest<HTMLElement>('[data-column]')?.dataset.column,
    hydra: task?.dataset.taskHydra ?? modal?.dataset.taskHydra ?? workspace?.dataset.hydraWorkspace,
  }
}

function modalTarget(): Target {
  const task = new URLSearchParams(location.search).get('task')
  const hydra = location.pathname.match(/^\/hydra\/([^/]+)\/$/)?.[1]

  return task && hydra ? {
    task,
    hydra: decodeURIComponent(hydra),
  } : {}
}

const Context = createContext<{
  axis: RefObject<HTMLDivElement | null>
  width: number
  hydras: Set<string>
  tasks: Set<string>
  protectsColumn({
    hydra,
    id,
  }: {
    hydra: string
    id: string
  }): boolean
} | null>(null)

export function WorkspaceViewport({
  axis,
  children,
}: {
  axis: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const [
    width,
    setWidth,
  ] = useState(innerWidth)
  const [
    focused,
    setFocused,
  ] = useState<Target>({})
  const [
    pressed,
    setPressed,
  ] = useState<Target>({})
  const [
    composing,
    setComposing,
  ] = useState<Target>({})
  const [
    modal,
    setModal,
  ] = useState(modalTarget)
  const drag = useSortState()
  useEffect(
    () => {
      const focus = () => setFocused(targetOf({ target: document.activeElement }))
      const blur = () => queueMicrotask(focus)
      const down = (event: Event) => setPressed(targetOf({ target: event.target }))
      const up = () => setPressed({})
      const compose = (event: Event) => setComposing(targetOf({ target: event.target }))
      const end = () => setComposing({})
      const readModal = () => setModal(modalTarget())
      const resize = () => setWidth(innerWidth)
      const controller = new AbortController()
      const options = {
        capture: true,
        signal: controller.signal,
      }
      document.addEventListener(
        'focusin',
        focus,
        options,
      )
      document.addEventListener(
        'focusout',
        blur,
        options,
      )
      document.addEventListener(
        'pointerdown',
        down,
        options,
      )
      document.addEventListener(
        'pointerup',
        up,
        options,
      )
      document.addEventListener(
        'pointercancel',
        up,
        options,
      )
      document.addEventListener(
        'compositionstart',
        compose,
        options,
      )
      document.addEventListener(
        'compositionend',
        end,
        options,
      )
      addEventListener(
        'popstate',
        readModal,
        options,
      )
      addEventListener(
        TASK_MODAL_CHANGED,
        readModal,
        options,
      )
      addEventListener(
        'resize',
        resize,
        options,
      )
      focus()

      return () => controller.abort()
    },
    [],
  )
  const value = useMemo(
    () => {
      const targets = [
        focused,
        pressed,
        composing,
        modal,
      ]
      const hydras = new Set(targets.flatMap(target => target.hydra ? [target.hydra] : []))
      const tasks = new Set(targets.flatMap(target => target.task ? [target.task] : []))

      if (drag.active) {
        hydras.add(drag.active.hydra)

        if (drag.active.kind === 'task') {
          tasks.add(drag.active.id)
        }
      }

      return {
        axis,
        width,
        hydras,
        tasks,
        protectsColumn: ({
          hydra,
          id,
        }: {
          hydra: string
          id: string
        }) => targets.some(target =>
          target.hydra === hydra && target.column === id)
        || (drag.active?.hydra === hydra && (drag.active.column === id
          || (drag.active.kind === 'project' && drag.active.id === id))),
      }
    },
    [
      axis,
      width,
      focused,
      pressed,
      composing,
      modal,
      drag.active,
    ],
  )

  return <Context value={value}>{children}</Context>
}

export function useWorkspaceViewport() {
  const value = useContext(Context)

  if (!value) {
    throw new Error('WorkspaceViewport is required')
  }

  return value
}

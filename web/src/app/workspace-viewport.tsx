import { kept, useKept } from '#web-shared/stable.ts'
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
  tasks: Map<string, Set<string>>
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
      const focus = () => setFocused(current => kept({
        previous: current,
        next: targetOf({ target: document.activeElement }),
      }))
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
  const dragged: Target = drag.active ? {
    hydra: drag.active.hydra,
    task: drag.active.kind === 'task' ? drag.active.id : undefined,
    column: drag.active.kind === 'project' ? drag.active.id : drag.active.column,
  } : {}
  const targets = useKept({
    value: [
      ...new Map([
        focused,
        pressed,
        composing,
        modal,
        dragged,
      ].filter(target => !!target.hydra).map(target => [
        JSON.stringify([
          target.hydra,
          target.column,
          target.task,
        ]),
        {
          hydra: target.hydra,
          column: target.column,
          task: target.task,
        },
      ] as const)).entries(),
    ].sort((
      [a],
      [b],
    ) => a.localeCompare(b))
      .map(([
        , target,
      ]) => target),
  })
  const value = useMemo(
    () => {
      const hydras = new Set(targets.flatMap(target => target.hydra ? [target.hydra] : []))
      const tasks = new Map<string, Set<string>>()

      const retainTask = ({
        hydra,
        task,
      }: Target) => {
        if (!hydra || !task) {
          return
        }

        const retained = tasks.get(hydra) ?? new Set<string>()
        retained.add(task)
        tasks.set(
          hydra,
          retained,
        )
      }

      targets.forEach(retainTask)

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
        }) => targets.some(target => target.hydra === hydra && target.column === id),
      }
    },
    [
      axis,
      width,
      targets,
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

import { HydraError } from '#store/errors.ts'

export interface WorkspaceLayout {
  collapsed: boolean
  chatCollapsed: boolean
  foldedProjects: string[]
  projectOrder: string[]
  projectWidths: Record<string, number>
}

export const DEFAULT_WORKSPACE: WorkspaceLayout = {
  collapsed: false,
  chatCollapsed: false,
  foldedProjects: [],
  projectOrder: [],
  projectWidths: {},
}
export const DEFAULT_PROJECT_WIDTH = 560
export const DEFAULT_OPEN_CARD_HEIGHT = 520
export const PROJECT_MIN_WIDTH = 280
export const OPEN_CARD_MIN_WIDTH = 560
export const OPEN_CARD_MIN_HEIGHT = 440

export function workspaceLayout({ input }: { input?: Partial<WorkspaceLayout> }): WorkspaceLayout {
  return {
    collapsed: input?.collapsed ?? false,
    chatCollapsed: input?.chatCollapsed ?? false,
    foldedProjects: [...(input?.foldedProjects ?? [])],
    projectOrder: [...(input?.projectOrder ?? [])],
    projectWidths: { ...input?.projectWidths },
  }
}

export function patchWorkspace({
  current,
  input,
}: {
  current: WorkspaceLayout
  input: unknown
}): WorkspaceLayout {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HydraError({
      message: 'workspace must be an object',
      code: 'VALIDATION_ERROR',
    })
  }

  const next = workspaceLayout({ input: current })

  for (const [
    key,
    value,
  ] of Object.entries(input)) {
    if (key === 'collapsed' || key === 'chatCollapsed') {
      if (typeof value !== 'boolean') {
        throw new HydraError({
          message: `${key} must be boolean`,
          code: 'VALIDATION_ERROR',
        })
      }

      next[key] = value
    } else if (key === 'foldedProjects' || key === 'projectOrder') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
        throw new HydraError({
          message: `${key} must be project ids`,
          code: 'VALIDATION_ERROR',
        })
      }

      next[key] = [...new Set(value as string[])]
    } else if (key === 'projectWidths') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new HydraError({
          message: `${key} must be widths by id`,
          code: 'VALIDATION_ERROR',
        })
      }

      for (const [
        id,
        width,
      ] of Object.entries(value)) {
        if ([
          '__proto__',
          'prototype',
          'constructor',
        ].includes(id)) {
          throw new HydraError({
            message: 'Invalid layout id',
            code: 'VALIDATION_ERROR',
          })
        }

        const minimum = PROJECT_MIN_WIDTH

        if (typeof width !== 'number' || !Number.isSafeInteger(width) || width < minimum) {
          throw new HydraError({
            message: `${key} widths must be integers of at least ${minimum}`,
            code: 'VALIDATION_ERROR',
          })
        }

        next[key][id] = width
      }
    } else {
      throw new HydraError({
        message: `Unknown workspace setting: ${key}`,
        code: 'VALIDATION_ERROR',
      })
    }
  }

  return next
}

import { useSyncExternalStore } from 'react'
import { MotionGlobalConfig } from 'motion/react'

export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
export type MotionMode = 'normal' | 'off'
export const MOTION_MODE: MotionMode = 'normal'
// Node-side callers have no CSSOM; the browser reads the theme tokens below.
export const MOTION_DURATIONS = {
  instant: 0,
  fast: 120,
  base: 180,
  slow: 320,
  ambient: 1600,
} as const
const FALLBACK_EASING = [
  0.2,
  0.8,
  0.2,
  1,
] as const
const motionMedia = typeof window === 'undefined' ? undefined : window.matchMedia(REDUCED_MOTION)
const cssEasing = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--ease-ui')
const coordinates = cssEasing.match(/cubic-bezier\(([^)]+)\)/)?.[1]?.split(',').map(Number)
export const MOTION_EASING = coordinates?.length === 4 && coordinates.every(Number.isFinite)
  ? [
    coordinates[0]!,
    coordinates[1]!,
    coordinates[2]!,
    coordinates[3]!,
  ] as const
  : FALLBACK_EASING
export const MOTION_CSS_EASING = `cubic-bezier(${MOTION_EASING.join(', ')})`

function readDurations() {
  const styles = typeof document === 'undefined' ? undefined : getComputedStyle(document.documentElement)

  return Object.fromEntries(Object.entries(MOTION_DURATIONS).map(([
    speed,
    fallback,
  ]) => {
    const css = styles?.getPropertyValue(`--transition-duration-${speed}`).trim() ?? ''
    const value = parseFloat(css)

    return [
      speed,
      Number.isFinite(value) ? value * (css.endsWith('ms') ? 1 : 1000) : fallback,
    ]
  })) as Record<keyof typeof MOTION_DURATIONS, number>
}

let durations = readDurations()

export function motionDuration({
  speed = 'base',
  mode = MOTION_MODE,
  reducedMotion = motionMedia?.matches ?? false,
}: {
  speed?: keyof typeof MOTION_DURATIONS
  mode?: MotionMode
  reducedMotion?: boolean
} = {}) {
  const runtimeOff = typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off'

  const runtimeReduced = motionMedia?.matches ?? false

  if (mode === 'off' || runtimeOff || reducedMotion || runtimeReduced) {
    return 0
  }

  return durations[speed]
}

function motionPreference() {
  return `${document.documentElement.dataset.motion ?? MOTION_MODE}:${motionMedia?.matches ?? false}`
}

// eslint-disable-next-line pnyx/object-params -- React owns the subscription callback signature.
function subscribeMotion(changed: () => void) {
  const update = () => {
    durations = readDurations()
    MotionGlobalConfig.skipAnimations = motionDuration() === 0
    changed()
  }

  const observer = new MutationObserver(update)
  observer.observe(
    document.documentElement,
    {
      attributes: true,
      attributeFilter: ['data-motion'],
    },
  )
  const media = motionMedia!
  media.addEventListener(
    'change',
    update,
  )
  update()

  return () => {
    observer.disconnect()
    media.removeEventListener(
      'change',
      update,
    )
  }
}

export function useMotionDuration() {
  useSyncExternalStore(
    subscribeMotion,
    motionPreference,
  )

  return motionDuration()
}

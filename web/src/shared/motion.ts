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

export function motionDuration({
  speed = 'base',
  mode = MOTION_MODE,
  reducedMotion = typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION).matches,
}: {
  speed?: keyof typeof MOTION_DURATIONS
  mode?: MotionMode
  reducedMotion?: boolean
} = {}) {
  const runtimeOff = typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off'

  const runtimeReduced = typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION).matches

  if (mode === 'off' || runtimeOff || reducedMotion || runtimeReduced) {
    return 0
  }

  const css = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(`--transition-duration-${speed}`)
    .trim()
  const value = parseFloat(css)

  return Number.isFinite(value) ? value * (css.endsWith('ms') ? 1 : 1000) : MOTION_DURATIONS[speed]
}

function motionPreference() {
  return `${document.documentElement.dataset.motion ?? MOTION_MODE}:${window.matchMedia(REDUCED_MOTION).matches}`
}

// eslint-disable-next-line pnyx/object-params -- React owns the subscription callback signature.
function subscribeMotion(changed: () => void) {
  const update = () => {
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
  const media = window.matchMedia(REDUCED_MOTION)
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

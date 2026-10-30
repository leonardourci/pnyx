// At the field's start ⌫ marks the last badge and removes it on a second press; ← → move the mark.
export interface BadgeKey {
  marked?: number
  remove?: number
  handled: boolean
}

export function badgeKey({
  key,
  marked,
  count,
  atStart,
}: {
  key: string
  marked?: number
  count: number
  atStart: boolean
}): BadgeKey {
  if (!count || !atStart) {
    return { handled: false }
  }

  if (key === 'Backspace') {
    return marked === undefined ? {
      marked: count - 1,
      handled: true,
    } : {
      remove: marked,
      handled: true,
    }
  }

  if (key === 'Delete' && marked !== undefined) {
    return {
      remove: marked,
      handled: true,
    }
  }

  if (key === 'ArrowLeft') {
    return {
      marked: marked === undefined ? count - 1 : Math.max(
        0,
        marked - 1,
      ),
      handled: true,
    }
  }

  if (key === 'ArrowRight' && marked !== undefined) {
    return {
      marked: marked + 1 < count ? marked + 1 : undefined,
      handled: true,
    }
  }

  return { handled: false }
}

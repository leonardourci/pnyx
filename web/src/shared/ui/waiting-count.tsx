export function WaitingCount({ count }: { count: number }) {
  if (count <= 0) {
    return null
  }

  return <span className="waiting-count inline-grid h-4.75 min-w-4.75 shrink-0 place-items-center rounded-full bg-gold-fill px-1 text-count whitespace-nowrap text-gold-ink writing-horizontal" aria-label={`${count} waiting for you`}>{count}</span>
}

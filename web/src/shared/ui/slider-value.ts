// What a typed number box commits: a whole number within the limits that differs from the current value.
export function sliderValue({
  text,
  value,
  min,
  max,
}: {
  text: string
  value: number
  min: number
  max: number
}): number | undefined {
  const next = Number(text.trim())

  return text.trim() !== '' && Number.isInteger(next) && next >= min && next <= max && next !== value
    ? next : undefined
}

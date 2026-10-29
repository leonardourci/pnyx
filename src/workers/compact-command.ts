export const compactCommand = ({ text }: { text: string }) => /^\/compact(?:\s|$)/.test(text.trim())

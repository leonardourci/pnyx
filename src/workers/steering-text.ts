export const STEERING_NOTICE = 'Othrys steering inbox has pending instruction IDs '
const NOTICE = /^Othrys steering inbox has pending instruction IDs /
const MESSAGES = /^New instructions for task \S+, in order \(Othrys inbox IDs /

export const steeringText = ({ text }: { text: string }) =>
  NOTICE.test(text) || MESSAGES.test(text)

import { FORM_FIELD_TYPES, type FormField, type Question } from './model.ts'

export const MAX_OPTIONS = 8

const record = ({ value }: { value: unknown }): Record<string, unknown> => {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>
  }

  return {}
}

const str = ({ value }: { value: unknown }) => typeof value === 'string' && value.trim() !== '' ? value : undefined

// One question without text or options leaves the whole prompt to the terminal.
export function questions({ value }: { value: unknown }): Question[] | undefined {
  const found = (Array.isArray(value) ? value : []).flatMap((item): Question[] => {
    const q = record({ value: item })
    const question = str({ value: q.question })
    const options = (Array.isArray(q.options) ? q.options : []).flatMap(o => {
      const option = record({ value: o })
      const label = str({ value: option.label })
      const description = str({ value: option.description })

      if (!label) {
        return []
      }

      const result: {
        label: string
        description?: string
      } = { label }

      if (description) {
        result.description = description
      }

      return [result]
    })
    const header = str({ value: q.header })

    if (!question || !options.length) {
      return []
    }

    const result: Question = {
      question,
      options,
    }

    if (header) {
      result.header = header
    }

    if (q.multiSelect === true) {
      result.multiSelect = true
    }

    return [result]
  })

  return Array.isArray(value) && found.length && found.length === value.length ? found : undefined
}

// Defaults, formats, titled choices and limits change the prompt, so those forms stay in the terminal.
const FIELD_KEYS = [
  'type',
  'title',
  'description',
  'enum',
]

// Preserve prompt order; URL elicitation and unsupported fields leave the whole form to the terminal.
export function form({ payload }: { payload: Record<string, unknown> }): FormField[] | undefined {
  const schema = record({ value: payload.requested_schema })
  const properties = Object.entries(record({ value: schema.properties }))
  const required = Array.isArray(schema.required) ? schema.required : []
  const fields = properties.flatMap(([
    name,
    property,
  ]): FormField[] => {
    const p = record({ value: property })
    const type = FORM_FIELD_TYPES.find(t => t === p.type)
    const options = Array.isArray(p.enum) && p.enum.every(o => typeof o === 'string') ? p.enum : undefined
    const title = str({ value: p.title })

    if (!type
      || Object.keys(p).some(k => !FIELD_KEYS.includes(k))
      || (p.enum !== undefined && (!options || type !== 'string' || options.length > MAX_OPTIONS))) {
      return []
    }

    const field: FormField = {
      name,
      type,
    }

    if (title) {
      field.title = title
    }

    if (options) {
      field.options = options
    }

    if (required.includes(name)) {
      field.required = true
    }

    return [field]
  })

  return str({ value: payload.mode }) !== 'url' && fields.length && fields.length === properties.length ? fields : undefined
}

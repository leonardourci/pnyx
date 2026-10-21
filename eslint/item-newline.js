import stylistic from '@stylistic/eslint-plugin'

const properties = stylistic.rules['object-property-newline']
const args = stylistic.rules['function-call-argument-newline']

// @stylistic checks object literals and call arguments only; run the same checks on patterns and parameters.
export default {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    schema: [],
    docs: { description: 'Enforce one item per line in destructuring patterns and parameter lists' },
    messages: {
      ...properties.meta.messages,
      ...args.meta.messages,
    },
  },
  create(context) {
    const property = properties.create(context)
    const argument = args.create(context)
    // eslint-disable-next-line pnyx/object-params -- ESLint calls each visitor with the node.
    const params = node => argument.CallExpression({ arguments: node.params })

    return {
      ObjectPattern: property.ObjectExpression,
      FunctionDeclaration: params,
      FunctionExpression: params,
      ArrowFunctionExpression: params,
      TSDeclareFunction: params,
      TSEmptyBodyFunctionExpression: params,
      TSFunctionType: params,
      TSMethodSignature: params,
    }
  },
}

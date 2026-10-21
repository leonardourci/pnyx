import stylistic from '@stylistic/eslint-plugin'

const args = stylistic.rules['function-call-argument-newline']

export default {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    schema: [],
    docs: { description: 'Enforce one item per line in objects, patterns and parameter lists' },
    messages: {
      ...args.meta.messages,
      expectedAfter: "Expected newline after '{{delimiter}}'.",
      expectedBefore: "Expected newline before '{{delimiter}}'.",
    },
  },
  create(context) {
    const argument = args.create(context)
    const sourceCode = context.sourceCode

    const delimiters = ({
      open,
      close,
      required,
    }) => {
      if (!required) {
        return
      }

      if (open.loc.end.line === sourceCode.getTokenAfter(open).loc.start.line) {
        context.report({
          node: open,
          messageId: 'expectedAfter',
          data: { delimiter: open.value },
          // eslint-disable-next-line pnyx/object-params -- ESLint supplies its fixer.
          fix: fixer => fixer.insertTextAfter(
            open,
            '\n',
          ),
        })
      }

      if (sourceCode.getTokenBefore(close).loc.end.line === close.loc.start.line) {
        context.report({
          node: close,
          messageId: 'expectedBefore',
          data: { delimiter: close.value },
          // eslint-disable-next-line pnyx/object-params -- ESLint supplies its fixer.
          fix: fixer => fixer.insertTextBefore(
            close,
            '\n',
          ),
        })
      }
    }

    // eslint-disable-next-line pnyx/object-params -- ESLint calls each visitor with the node.
    const params = node => {
      argument.CallExpression({ arguments: node.params })

      if (node.params.length < 2) {
        return
      }

      const afterLast = sourceCode.getTokenAfter(node.params.at(-1))
      delimiters({
        open: sourceCode.getTokenBefore(node.params[0]),
        close: afterLast.value === ',' ? sourceCode.getTokenAfter(afterLast) : afterLast,
        required: true,
      })
    }

    return {
      // The argument fixer preserves comments between members that object-property-newline cannot fix.
      // eslint-disable-next-line pnyx/object-params -- ESLint calls each visitor with the node.
      'ObjectExpression, ObjectPattern, TSTypeLiteral, TSInterfaceBody': node => {
        const items = node.properties ?? node.members ?? node.body
        argument.CallExpression({ arguments: items })
        const open = sourceCode.getFirstToken(node)
        const close = node.typeAnnotation
          ? sourceCode.getTokenBefore(node.typeAnnotation) : sourceCode.getLastToken(node)
        const first = sourceCode.getTokenAfter(
          open,
          { includeComments: true },
        )
        const last = sourceCode.getTokenBefore(
          close,
          { includeComments: true },
        )
        delimiters({
          open,
          close,
          required: items.length > 1
            || (items.length > 0 && first.loc.start.line !== last.loc.end.line),
        })
      },
      // eslint-disable-next-line pnyx/object-params -- ESLint calls each visitor with the node.
      'ArrayExpression, ArrayPattern': node => {
        argument.CallExpression({ arguments: node.elements.filter(Boolean) })
      },
      FunctionDeclaration: params,
      FunctionExpression: params,
      ArrowFunctionExpression: params,
      TSDeclareFunction: params,
      TSEmptyBodyFunctionExpression: params,
      TSFunctionType: params,
      TSMethodSignature: params,
      TSCallSignatureDeclaration: params,
      TSConstructorType: params,
      TSConstructSignatureDeclaration: params,
    }
  },
}

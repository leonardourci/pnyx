// External callers own their callback and entry-point signatures.
const arrayCallbacks = new Set([
  'map',
  'flatMap',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'reduce',
  'reduceRight',
  'sort',
  'toSorted',
  'forEach',
  'from',
])
const playwrightCallbacks = [
  'evaluate',
  'routeWebSocket',
  'onMessage',
]
const externalCallbacks = new Set([
  'then',
  'catch',
  'finally',
  'replace',
  'replaceAll',
  'on',
  'once',
  'addListener',
  'addEventListener',
  'removeEventListener',
  'throws',
  'rejects',
  'after',
  'before',
  'afterEach',
  'beforeEach',
  // Zero's query builder
  'related',
  ...playwrightCallbacks,
])
const callbackCalls = new Set([
  'test',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'createServer',
  'createSocketServer',
  'execFile',
  'request',
  'watch',
])

const callName = ({ node }) => node.type === 'Identifier' ? node.name
  : node.type === 'MemberExpression' && !node.computed ? node.property.name : undefined

const owner = ({
  node,
  types,
}) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (types.includes(parent.type)) {
      return parent
    }
  }
}

const variableFor = ({
  node,
  name,
  sourceCode,
}) => {
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(name)

    if (variable) {
      return variable
    }
  }
}

const stateSetter = ({
  node,
  sourceCode,
}) => {
  if (node.type !== 'Identifier') {
    return false
  }

  const definition = variableFor({
    node,
    name: node.name,
    sourceCode,
  })?.defs[0]?.node

  return definition?.type === 'VariableDeclarator' && definition.id.type === 'ArrayPattern'
    && definition.id.elements[1]?.name === node.name
    && definition.init?.type === 'CallExpression'
    && [
      'useState',
      'useReducer',
    ].includes(callName({ node: definition.init.callee }))
}

const registeredCallback = ({
  node,
  sourceCode,
}) => {
  const declaration = node.parent.type === 'VariableDeclarator' ? node.parent : node
  const variables = sourceCode.getDeclaredVariables(declaration)
  const reads = variables.flatMap(variable =>
    variable.references.filter(reference => reference.isRead()))

  return reads.length > 0 && reads.every(reference => {
    const identifier = reference.identifier
    const call = identifier.parent

    return call.type === 'CallExpression' && call.callee.type === 'MemberExpression'
      && [
        'addEventListener',
        'removeEventListener',
        'on',
        'once',
      ].includes(callName({ node: call.callee }))
      && call.arguments[1] === identifier
  })
}

const nodeWatchAssignment = ({
  node,
  sourceCode,
}) => {
  let assigned = node

  while (assigned.parent.type === 'TSAsExpression') {
    assigned = assigned.parent
  }

  const assignment = assigned.parent

  if (assignment.type !== 'AssignmentExpression' || assignment.right !== assigned) {
    return false
  }

  const target = assignment.left

  if (target.type !== 'MemberExpression' || target.computed || target.property.name !== 'watch'
    || target.object.type !== 'Identifier') {
    return false
  }

  const binding = variableFor({
    node,
    name: target.object.name,
    sourceCode,
  })?.defs[0]?.node

  return [
    'ImportDefaultSpecifier',
    'ImportNamespaceSpecifier',
  ].includes(binding?.type) && binding.parent.source.value === 'node:fs'
}

const boundary = ({
  node,
  filename,
  sourceCode,
}) => {
  const parent = node.parent

  if (nodeWatchAssignment({
    node,
    sourceCode,
  })) {
    return true
  }

  if (registeredCallback({
    node,
    sourceCode,
  })) {
    return true // A named listener keeps its identity for removal.
  }

  if (filename.endsWith('/src/app/cli-support.ts') && parent.type === 'ReturnStatement'
    && owner({
      node,
      types: ['FunctionDeclaration'],
    })?.id?.name === 'guard') {
    return true
  }

  const commandAdapter = filename.endsWith('/src/routine-helper/commands.ts')
    || filename.endsWith('/src/workers/worker-scope.ts')

  if (commandAdapter && (parent.type === 'TSTypeAliasDeclaration' && parent.id.name === 'Command'
    || parent.type === 'ArrayExpression' && node.params[0]?.name === 'args')) {
    return true
  }

  if (parent.type === 'CallExpression' && parent.arguments.includes(node)) {
    const name = callName({ node: parent.callee })

    return callbackCalls.has(name) || (parent.callee.type === 'MemberExpression'
      && (arrayCallbacks.has(name) || externalCallbacks.has(name) || name === 'handleUpgrade'))
      || stateSetter({
        node: parent.callee,
        sourceCode,
      })
  }

  if (parent.type === 'NewExpression' && parent.arguments.includes(node)) {
    return [
      'Promise',
      'MutationObserver',
      'ResizeObserver',
      'IntersectionObserver',
    ].includes(callName({ node: parent.callee }))
  }

  if (parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression'
    && /^on[a-z]+$/.test(parent.left.property.name)) {
    return true // DOM and WebSocket event properties.
  }

  if (parent.type === 'JSXExpressionContainer' && parent.parent.type === 'JSXAttribute') {
    const attribute = parent.parent
    const element = attribute.parent.name

    return element.type === 'JSXIdentifier' && (/^[a-z]/.test(element.name)
      || [
        'Button',
        'Input',
        'Textarea',
      ].includes(element.name))
      && /^on[A-Z]/.test(attribute.name.name)
  }

  if (parent.type === 'Property') {
    if (filename.endsWith('/web/vite.config.ts') && parent.key.name === 'configure') {
      return true // Vite's proxy configuration hook.
    }

    if (filename.endsWith('/src/preferences/keyboard.ts') && parent.key.name === 'getModifierState') {
      return true // tinykeys consumes the KeyboardEvent method.
    }

    if (/\/eslint\/[^/]+\.js$/.test(filename) && (parent.key.name === 'create'
      || parent.key.value?.includes('FunctionDeclaration'))) {
      return true // ESLint calls rule factories and AST visitors.
    }
  }

  return false
}

export default {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { object: 'Use one destructured object parameter for named arguments.' },
  },
  create(context) {
    const check = ({ node }) => {
      if (!node.params.length || boundary({
        node,
        filename: context.filename,
        sourceCode: context.sourceCode,
      })) {
        return
      }

      const parameter = node.params[0].type === 'AssignmentPattern'
        ? node.params[0].left : node.params[0]

      if (node.params.length !== 1 || parameter.type !== 'ObjectPattern') {
        context.report({
          node,
          messageId: 'object',
        })
      }
    }

    return {
      'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSFunctionType, TSMethodSignature, TSCallSignatureDeclaration, TSDeclareFunction, TSConstructorType, TSConstructSignatureDeclaration, TSEmptyBodyFunctionExpression': node => check({ node }),
    }
  },
}

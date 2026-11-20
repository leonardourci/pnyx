import js from '@eslint/js'
import itemNewline from './eslint/item-newline.js'
import objectParams from './eslint/object-params.js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import tailwind from 'eslint-plugin-better-tailwindcss'

// A specifier into another folder: one that climbs with ../ or descends with ./<folder>/.
const OTHER_FOLDER = /^(\.\.\/|\.\/.*\/)/
const USE_ALIASES = 'Import a file in another folder through the package.json aliases: #<folder>/<file>.ts for src/, #web-<folder>/<file> for web/src/.'

const IMPORT_RESTRICTIONS = [
  {
    selector: `ImportExpression[source.value=${OTHER_FOLDER}]`,
    message: USE_ALIASES,
  },
  {
    selector: `TSImportType[argument.literal.value=${OTHER_FOLDER}]`,
    message: USE_ALIASES,
  },
]

const STYLED_WEB = ['web/**/*.{ts,tsx}']

// Chat rebuild removes this temporary styling exception and its scoped file list.
const CHAT_STYLES = [
  'web/src/hydra/**/*.{ts,tsx}',
  'web/src/tasks/worker-chat.tsx',
]

const FIXED_STYLE_VALUE = ':matches([value.type="Literal"], [value.type="UnaryExpression"][value.argument.type="Literal"], [value.type="TemplateLiteral"][value.expressions.length=0])'
const STYLE_RESTRICTIONS = [
  {
    selector: 'JSXAttribute[name.name="style"]:not([value.type="JSXExpressionContainer"]), JSXAttribute[name.name="style"] > JSXExpressionContainer > :not(CallExpression[callee.name="runtimeStyle"])',
    message: 'Use theme classes for fixed styles and runtimeStyle for measured geometry or owner-selected sizes.',
  },
  {
    selector: `CallExpression[callee.name="runtimeStyle"] > ObjectExpression > Property${FIXED_STYLE_VALUE}, CallExpression[callee.name="applyRuntimeStyle"] > ObjectExpression > Property:matches([computed=false][key.name="values"], [key.value="values"]) > ObjectExpression > Property${FIXED_STYLE_VALUE}`,
    message: 'Fixed values belong in the theme or a shared component; runtimeStyle accepts computed values only.',
  },
]

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist.next.*/**',
      'dist.old/**',
      '.vitest/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'src/**',
      'scripts/**',
      'eslint/**',
      'tests/**',
      '*.js',
      '*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: STYLED_WEB,
    ignores: CHAT_STYLES,
    plugins: { 'better-tailwindcss': tailwind },
    settings: {
      'better-tailwindcss': {
        entryPoint: './web/src/index.css',
        selectors: {
          extends: [
            {
              kind: 'callee',
              path: '^(?:.*\\.)?classList\\.(?:add|remove|toggle|replace|contains)$',
              match: [{ type: 'strings' }],
            },
            {
              kind: 'attribute',
              name: '^(?:class|.*ClassName)$',
            },
            {
              kind: 'variable',
              name: '^(?:.*CLASSES|.*_CLASS|.*_TONE|.*ClassName|.*Classes|QUESTION_HEADLINE|QUESTION_SOURCE|VARIANTS|SIZES|ROWS|BADGE_COLORS|DATE_EDITOR|SETTING_STACK|appearance|tone|border|selection|layout|fill|button|color|vertical|variant|tones|wrapping|size|position|classes|className)$',
              match: [
                { type: 'strings' },
                { type: 'objectValues' },
              ],
            },
          ],
        },
      },
    },
    rules: {
      'better-tailwindcss/enforce-consistent-class-order': 'error',
      'better-tailwindcss/no-restricted-classes': [
        'error',
        {
          selectors: {
            extends: [
              {
                kind: 'variable',
                name: '.*',
                match: [
                  { type: 'strings' },
                  { type: 'objectValues' },
                ],
              },
            ],
          },
          restrict: [
            {
              pattern: '(?:^|:)!?(?:[a-zA-Z0-9-]+-\\[.*\\]|\\[[a-zA-Z0-9_-]+:.+\\])(?:/[^:]+)?!?$',
              message: 'Use a theme token or a shared utility instead of an arbitrary value.',
            },
            {
              pattern: '/\\[(?:.*\\]!?|[^\\[\\]]*)$',
              message: 'Use a theme token or a shared utility instead of an arbitrary value.',
            },
            {
              pattern: '(?:^|:)!?(?:[a-zA-Z0-9-]+-\\[[^\\[\\]]*|\\[[a-zA-Z0-9_-]+:[^\\[\\]]*)$',
              message: 'Keep class names complete; computed values belong in runtimeStyle.',
            },
          ],
        },
      ],
    },
  },
  {
    plugins: {
      '@stylistic': stylistic,
      pnyx: {
        rules: {
          'object-params': objectParams,
          'item-newline': itemNewline,
        },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'pnyx/object-params': 'error',
      'curly': [
        'error',
        'all',
      ],

      // Formatting. Every rule here is auto-fixable except max-len: run `pnpm lint:fix`.
      '@stylistic/quotes': [
        'error',
        'single',
        { avoidEscape: true },
      ],
      '@stylistic/jsx-quotes': [
        'error',
        'prefer-double',
      ],
      '@stylistic/semi': [
        'error',
        'never',
      ],
      '@stylistic/member-delimiter-style': [
        'error',
        {
          multiline: { delimiter: 'none' },
          singleline: {
            delimiter: 'semi',
            requireLast: false,
          },
        },
      ],
      '@stylistic/comma-dangle': [
        'error',
        'always-multiline',
      ],
      '@stylistic/indent': [
        'error',
        2,
      ],
      '@stylistic/arrow-parens': [
        'error',
        'as-needed',
      ],
      '@stylistic/brace-style': [
        'error',
        '1tbs',
        { allowSingleLine: false },
      ],
      '@stylistic/max-len': [
        'error',
        {
          code: 100,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: true,
        },
      ],
      '@stylistic/newline-per-chained-call': [
        'error',
        { ignoreChainWithDepth: 2 },
      ],
      '@stylistic/no-multiple-empty-lines': [
        'error',
        {
          max: 1,
          maxEOF: 0,
          maxBOF: 0,
        },
      ],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/padded-blocks': [
        'error',
        'never',
      ],
      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],

      // Breathing room: a blank line before return and around multi-line blocks.
      '@stylistic/padding-line-between-statements': [
        'error',
        {
          blankLine: 'always',
          prev: '*',
          next: 'return',
        },
        {
          blankLine: 'always',
          prev: '*',
          next: 'multiline-block-like',
        },
        {
          blankLine: 'always',
          prev: 'multiline-block-like',
          next: '*',
        },
        {
          blankLine: 'always',
          prev: 'import',
          next: '*',
        },
        {
          blankLine: 'any',
          prev: 'import',
          next: 'import',
        },
        // Stacked case labels share one body, so keep them together.
        {
          blankLine: 'any',
          prev: '*',
          next: [
            'case',
            'default',
          ],
        },
      ],

      '@stylistic/object-curly-newline': [
        'error',
        {
          ObjectExpression: {
            multiline: true,
            minProperties: 2,
            consistent: true,
          },
          ObjectPattern: {
            multiline: true,
            minProperties: 2,
            consistent: true,
          },
          TSTypeLiteral: {
            multiline: true,
            minProperties: 2,
            consistent: true,
          },
          TSInterfaceBody: {
            multiline: true,
            minProperties: 2,
            consistent: true,
          },
          ImportDeclaration: {
            multiline: true,
            consistent: true,
          },
          ExportDeclaration: {
            multiline: true,
            consistent: true,
          },
        },
      ],
      '@stylistic/object-property-newline': 'error',
      '@stylistic/array-bracket-newline': [
        'error',
        {
          multiline: true,
          minItems: 2,
        },
      ],
      '@stylistic/array-element-newline': [
        'error',
        {
          multiline: true,
          minItems: 2,
        },
      ],
      '@stylistic/function-paren-newline': [
        'error',
        'multiline-arguments',
      ],
      '@stylistic/function-call-argument-newline': [
        'error',
        'always',
      ],
      'pnyx/item-newline': 'error',
    },
  },
  {
    // The app reads best with one JSX prop per line once an element spans lines.
    files: ['web/**/*.tsx'],
    rules: {
      '@stylistic/jsx-max-props-per-line': [
        'error',
        {
          maximum: {
            single: 3,
            multi: 1,
          },
        },
      ],
      '@stylistic/jsx-first-prop-new-line': [
        'error',
        'multiline',
      ],
      '@stylistic/jsx-closing-bracket-location': [
        'error',
        'line-aligned',
      ],
      '@stylistic/jsx-closing-tag-location': 'error',
      '@stylistic/jsx-wrap-multilines': [
        'error',
        {
          declaration: 'parens-new-line',
          assignment: 'parens-new-line',
          return: 'parens-new-line',
          arrow: 'parens-new-line',
          condition: 'parens-new-line',
          logical: 'parens-new-line',
          prop: 'parens-new-line',
        },
      ],
    },
  },
  {
    files: [
      'src/**',
      'web/src/**',
      'scripts/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: OTHER_FOLDER.source,
              message: USE_ALIASES,
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...IMPORT_RESTRICTIONS,
      ],
    },
  },
  {
    files: STYLED_WEB,
    ignores: CHAT_STYLES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...IMPORT_RESTRICTIONS,
        ...STYLE_RESTRICTIONS,
      ],
    },
  },
  {
    files: STYLED_WEB,
    ignores: [
      ...CHAT_STYLES,
      'web/src/shared/ui/runtime-style.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...IMPORT_RESTRICTIONS,
        ...STYLE_RESTRICTIONS,
        {
          selector: 'MemberExpression:matches([property.name="style"], [computed=true][property.value="style"])',
          message: 'Use classes for fixed values and applyRuntimeStyle for computed DOM geometry.',
        },
      ],
    },
  },
)

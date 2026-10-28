import js from '@eslint/js'
import itemNewline from './eslint/item-newline.js'
import objectParams from './eslint/object-params.js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// A specifier into another folder: one that climbs with ../ or descends with ./<folder>/.
const OTHER_FOLDER = /^(\.\.\/|\.\/.*\/)/
const USE_ALIASES = 'Import a file in another folder through the package.json aliases: #<folder>/<file>.ts for src/, #web-<folder>/<file> for web/src/.'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
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
      'e2e/**',
      '*.js',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/**'],
    languageOptions: { globals: globals.browser },
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
      'e2e/**',
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
        {
          selector: `ImportExpression[source.value=${OTHER_FOLDER}]`,
          message: USE_ALIASES,
        },
        {
          selector: `TSImportType[argument.literal.value=${OTHER_FOLDER}]`,
          message: USE_ALIASES,
        },
      ],
    },
  },
)

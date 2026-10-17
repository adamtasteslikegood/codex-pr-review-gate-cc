// Style checks only: no type-aware rules, so nothing here reads a tsconfig.
// codex-gate is frozen at 0.3.1 and is not linted.
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

export default [
  { ignores: ['codex-gate/**', '**/.claude-plugin/types/**', 'node_modules/**'] },
  {
    files: ['pr-lifecycle/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      // Long prompt text lives in string and template literals; the limit applies to code.
      '@stylistic/max-len': ['error', { code: 160, ignoreStrings: true, ignoreTemplateLiterals: true }],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/eol-last': 'error',
      '@stylistic/no-tabs': 'error',
    },
  },
]

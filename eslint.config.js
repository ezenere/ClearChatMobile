// ESLint (flat): config do Expo + Prettier por último (formatação fica com o Prettier).
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')
const prettier = require('eslint-config-prettier/flat')

module.exports = defineConfig([
  {
    ignores: ['node_modules/**', 'android/**', 'ios/**', '.expo/**', 'dist/**', 'src/vendor/**']
  },
  expoConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['scripts/**/*.{js,cjs,mjs}', '*.config.{js,mjs,mts}', 'metro.config.js'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly'
      }
    }
  },
  prettier
])

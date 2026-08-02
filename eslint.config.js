// https://docs.expo.dev/guides/using-eslint/
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = [
  ...expoConfig,
  {
    // functions/ is a separate Node project with its own eslint config
    // (functions/.eslintrc.js) and is intentionally out of scope here.
    ignores: ['dist/*', '.expo/*', 'functions/**'],
  },
  {
    files: ['**/__tests__/**/*.[jt]s?(x)', '**/*.test.[jt]s?(x)'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
];

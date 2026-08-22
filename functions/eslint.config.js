// Flat-config equivalent of functions/.eslintrc.js. functions/ is a
// separate Node/TypeScript project from the repository root (which has
// its own eslint.config.js and explicitly excludes functions/** - see
// the root config's ignores entry), so it needs its own flat config to
// lint independently instead of picking up the root config.
//
// Uses FlatCompat (@eslint/eslintrc) to translate the existing eslintrc-
// style `extends` entries (google, plugin:import/*,
// plugin:@typescript-eslint/recommended) into flat config without adding
// any new dependencies - both @eslint/eslintrc and @eslint/js already
// ship as transitive dependencies of eslint itself.
const { FlatCompat } = require("@eslint/eslintrc");
const js = require("@eslint/js");

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

module.exports = [
  {
    // lib/** and generated/** mirror the old ignorePatterns. .eslintrc.js
    // itself is excluded too: legacy ESLint ignores dotfiles by default,
    // but flat config does not, so without this it would newly get swept
    // into the lint run (and fail TS-project parsing, since it isn't
    // covered by tsconfig.json's "include": ["src"]). eslint.config.js is
    // config/tooling, not application source, so it's excluded from
    // self-linting the same way .eslintrc.js always was.
    ignores: ["lib/**", "generated/**", ".eslintrc.js", "eslint.config.js"],
  },
  ...compat.env({ es6: true, node: true }),
  js.configs.recommended,
  ...compat.extends(
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "google",
    "plugin:@typescript-eslint/recommended"
  ),
  {
    // Scoped to src/**, matching tsconfig.json's "include": ["src"] -
    // this keeps root-level config files (eslint.config.js, etc.) out of
    // the TS-project-aware parser, which requires every matched file to
    // actually be inside the referenced tsconfig's project.
    files: ["src/**/*.js", "src/**/*.ts"],
    languageOptions: {
      sourceType: "module",
      parser: require("@typescript-eslint/parser"),
      parserOptions: {
        project: ["tsconfig.json", "tsconfig.dev.json"],
      },
    },
    rules: {
      "quotes": ["error", "double"],
      "import/no-unresolved": 0,
      "indent": ["error", 2],
    },
  },
];

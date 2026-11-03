// ESLint flat config for the whole monorepo. Frontend apps extend it with React rules when they exist.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/src/generated/**',
      'infrastructure/backup/output/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
  },
  // TypeScript: type-aware rules. no-floating-promises and no-misused-promises matter here: a
  // forgotten await inside withTenant() would run a query outside its tenant transaction.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Prisma CLI configs sit outside each service's src/ tsconfig; lint them with the backend
          // base config (which brings in Node types).
          allowDefaultProject: ['smartconnect-backend/services/*/prisma.config.ts'],
          defaultProject: 'smartconnect-backend/tsconfig.base.json',
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Frontend (web app and its packages): React hooks rules, including the React Compiler checks, and
  // browser globals.
  {
    files: ['smartconnect-frontend/**/*.{ts,tsx,js}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: { ...globals.browser } },
  },
);

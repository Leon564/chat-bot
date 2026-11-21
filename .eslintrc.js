/**
 * ESLint mínimo: las reglas recomendadas de typescript-eslint, sin Prettier
 * (el repo mezcla estilos de comillas y finales de línea; reformatear todo
 * sólo para pasar el lint ensuciaría el historial). `npm run lint` tiene que
 * dar 0 para que sirva como chequeo en CI.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', tsconfigRootDir: __dirname, sourceType: 'module' },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended'],
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist/', 'node_modules/', 'coverage/'],
  rules: {
    // ~75 usos, casi todos en el pipeline de música (respuestas de ytsr,
    // yt-dlp y los hosts de subida sin tipos). Tiparlos es trabajo aparte.
    '@typescript-eslint/no-explicit-any': 'off',
    // `_algo` = no usado a propósito; `const { a, ...resto } = x` para sacar
    // un campo es idiomático aunque `a` no se use.
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
  },
};

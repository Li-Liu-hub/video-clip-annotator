/**
 * ESLint 配置。
 *
 * 这里管的不是代码风格，主要是**依赖方向**——
 * 分层规则写在 RULES.md 里，但只有变成 "error" 才真的拦得住。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'data/**', 'next-env.d.ts', 'scripts/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      // 未使用变量允许以 _ 开头，用于接口实现时的占位
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // 路由层：不得直连数据库
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/lib/db', '@/lib/db/**'],
              message: '路由层不得直接访问数据库，请通过 @/lib/services 或 @/lib/server',
            },
          ],
        },
      ],
    },
  },
  // 业务层：不得依赖请求上下文
  {
    files: ['src/lib/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next/headers', 'next/navigation', 'next/server'],
              message: 'service 层不得依赖请求上下文，请移到 lib/server',
            },
            {
              group: ['@/lib/server/**'],
              message: 'service 层不得反向依赖适配层',
            },
          ],
        },
      ],
    },
  },
  // 数据层：不得反向依赖上层
  {
    files: ['src/lib/db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/lib/services/**', '@/lib/server/**', 'next/*'],
              message: '数据层不得反向依赖上层',
            },
          ],
        },
      ],
    },
  },
);

/**
 * ESLint 配置。
 *
 * 这里管的不是代码风格，主要是**依赖方向**——
 * 分层规则写在 RULES.md 里，但只有变成 "error" 才真的拦得住。
 *
 * 下面每条非默认规则都注明了它防的是什么。没有注释的规则才是可疑的：
 * 下一个人分不清「刻意开的」与「顺手抄的」，就会照着 override 掉。
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
      // 禁 any：类型错了应该修类型，不是把它抹平。unknown + 类型守卫是唯一替代方案。
      '@typescript-eslint/no-explicit-any': 'error',
      // 禁 console：日志走审计表与错误响应；散落的 console.log 在服务端不可查，还会进构建产物。
      'no-console': 'error',
      // 未使用变量允许以 _ 开头，用于接口实现时的占位。
      // 没有这条时，实现一个用不到全部参数的接口只能加 disable —— 那比显式占位更难审。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // 路由层：不得直连数据库。
  // 否则租户谓词与事务边界会散落在 handler 里，而 handler 不可单测 —— 判断写在那里就无人验证。
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
  // 业务层：不得依赖请求上下文。
  // service 一旦 import next/headers 就只能跑在请求里，而本项目测试全部跑在 :memory: 上。
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
  // 数据层：不得反向依赖上层。
  // repo 只认 SQL 与行；import service 会绕开事务边界（RULES：事务只在 service 层）。
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

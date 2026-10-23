/** @type {import('jest').Config} */
const common = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@dv/shared$': '<rootDir>/packages/shared/src/index.ts',
    '^@dv/shared/(.*)$': '<rootDir>/packages/shared/src/$1',
  },
};

module.exports = {
  testTimeout: 60000,
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: [
        '<rootDir>/apps/*/test/**/*.spec.ts',
        '<rootDir>/packages/*/test/**/*.spec.ts',
        '<rootDir>/tests/*.spec.ts',
      ],
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.int-spec.ts'],
    },
  ],
};

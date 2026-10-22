import baseConfig from "./jest.config.js";

export default {
  ...baseConfig,
  testMatch: ["<rootDir>/dist/tests/integration/**/*.test.js"],
  testPathIgnorePatterns: ["/node_modules/"],
  testTimeout: 15000,
};

export default {
    testEnvironment: "node",
    testMatch: ["<rootDir>/dist/**/*.test.js"], // Test files ending in .test.js inside dist/. in the root directory
    transform: {},
    testPathIgnorePatterns: ["/node_modules/", "/tests/integration/", "/tests/e2e/"],
  };

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {}],
  },
  // Integration tests need live databases; they only run via npm run test:integration.
  testPathIgnorePatterns: process.env.INDIGODB_INTEGRATION
    ? ["/node_modules/"]
    : ["/node_modules/", "<rootDir>/tests/integration/"],
};

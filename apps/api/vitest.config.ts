import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Password checks are deliberately slow (scrypt), and CI runners are slower
    // than laptops; the 5 s default is too tight for the sign-in suites.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

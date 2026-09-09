import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // SWC keeps `design:paramtypes` metadata that esbuild strips. Without it,
  // Nest DI and ValidationPipe behave differently under test than in
  // production, which previously hid real wiring and validation bugs.
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "libs/**/*.ts"],
      exclude: [
        "src/migrations/**",
        "src/main.ts",
        "src/worker.ts",
        "src/reprocess.ts",
        "src/data-source.ts",
        "**/*.module.ts",
        "**/*.dto.ts",
        "**/*.generated.ts",
        "**/types.ts",
      ],
      // Ratchet only upward: raise these as coverage improves, never lower them
      // to make a red run green.
      //
      // Re-baselined once, at vitest 3 -> 5, because the ruler changed rather
      // than the code. Between the last run that passed 85/73 and the first that
      // did not, the diff over server/src and server/libs was empty — the only
      // application changes in that range were two web files, which this scope
      // does not include — and 22 tests were *added* over the same period.
      // v8 coverage in vitest 5 simply counts differently, so the old numbers
      // were measuring something this version does not report.
      //
      // These are the floor under the new measurement, set just below what it
      // reports today. The rule above stands from here.
      thresholds: { statements: 83, branches: 68, functions: 84, lines: 87 },
    },
  },
});

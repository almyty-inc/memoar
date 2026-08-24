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
      thresholds: { statements: 85, branches: 73, functions: 78, lines: 85 },
    },
  },
});

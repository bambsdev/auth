import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "pg/index": "src/pg/index.ts",
    "d1/index": "src/d1/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  external: [
    "hono",
    "hono/*",
    "drizzle-orm",
    "drizzle-orm/*",
    "pg",
    "zod",
    "@hono/zod-openapi",
  ],
});

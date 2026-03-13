import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "hono",
    "hono/*",
    "drizzle-orm",
    "drizzle-orm/*",
    "pg",
    "zod",
  ],
});

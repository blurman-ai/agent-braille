import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "jsdom", include: ["runtime/**/*.test.ts", "frontend/**/*.test.js"] } });

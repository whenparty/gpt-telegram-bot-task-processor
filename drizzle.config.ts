import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/index.ts",
  out: "./db/migrations",
  verbose: true,
  dbCredentials: {
    url: process.env.POSTGRES_URL,
  },
});

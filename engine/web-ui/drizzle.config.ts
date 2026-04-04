import type { Config } from "drizzle-kit";

export default {
  schema: "./src/lib/db-modules/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./local.db",
  },
  strict: true,
  verbose: true,
} satisfies Config;

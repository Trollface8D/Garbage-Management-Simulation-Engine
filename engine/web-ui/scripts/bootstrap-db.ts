import db, { bootstrapDatabase, databasePath } from "@/lib/db-modules/connection";

function main(): void {
  bootstrapDatabase();
  console.log(`[db:bootstrap] Drizzle migrations applied: ${databasePath}`);
  db.close();
}

main();

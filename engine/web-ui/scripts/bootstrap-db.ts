import db, { databasePath, runLegacyMigrationsOnce } from "../src/lib/db-modules/connection";

function main(): void {
  runLegacyMigrationsOnce();
  console.log(`[db:bootstrap] Legacy migration check complete: ${databasePath}`);
  db.close();
}

main();

import { drizzle } from "drizzle-orm/better-sqlite3";
import db from "@/lib/db-modules/connection";
import * as schema from "./schema";

export const drizzleDb = drizzle(db, { schema });

export default drizzleDb;

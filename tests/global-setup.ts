import "dotenv/config";
import { Client } from "pg";

/**
 * Recreates an empty `rebound_test` database before the test run, so tests
 * never touch development data and always start from the same state.
 * Migrations are applied by each test file (see helpers.ts).
 */
export default async function setup() {
  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: "postgres",
  });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS rebound_test WITH (FORCE)");
  await admin.query("CREATE DATABASE rebound_test");
  await admin.end();
}

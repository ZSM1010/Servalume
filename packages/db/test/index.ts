/**
 * Test-harness utilities shared across packages — notably apps/worker, which
 * needs the exact same migration set and Supabase-role emulation but applied
 * against a real (embedded) Postgres connection instead of PGlite, for tests
 * that depend on genuine multi-connection concurrency (pg-boss's SKIP LOCKED
 * job claiming). Not part of the production `@servalume/db` entry point —
 * only ever imported from test files.
 */
export * from "./applyMigrations.js";
export * from "./supabaseShim.js";

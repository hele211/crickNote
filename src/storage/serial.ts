import type Database from 'better-sqlite3';
import { getDatabase } from './database.js';

export function formatSerial(n: number): string {
  return n >= 1000 ? String(n) : String(n).padStart(3, '0');
}

/** Validate a prefix string. Throws if not 2–3 uppercase ASCII letters. */
export function validatePrefix(prefix: string): void {
  if (!/^[A-Z]{2,3}$/.test(prefix)) {
    throw new Error(`Prefix "${prefix}" has invalid format — must be 2–3 uppercase letters (A-Z), got "${prefix}"`);
  }
}

export function getNextSerial(scope: string, db?: Database.Database): string {
  const database = db ?? getDatabase();
  const row = database.prepare(
    'UPDATE serial_counters SET next_val = next_val + 1 WHERE scope = ? RETURNING next_val - 1 AS allocated'
  ).get(scope) as { allocated: number } | undefined;
  if (row === undefined) throw new Error(`Serial scope "${scope}" does not exist. Register it before allocating.`);
  return formatSerial(row.allocated);
}

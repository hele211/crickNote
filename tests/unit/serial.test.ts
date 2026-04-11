import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { getNextSerial, formatSerial, validatePrefix } from '../../src/storage/serial.js';

describe('formatSerial', () => {
  it('zero-pads 1-999 to 3 digits', () => {
    expect(formatSerial(1)).toBe('001');
    expect(formatSerial(42)).toBe('042');
    expect(formatSerial(999)).toBe('999');
  });
  it('uses natural string for >= 1000', () => {
    expect(formatSerial(1000)).toBe('1000');
  });
});

describe('validatePrefix', () => {
  it('accepts 2-letter uppercase prefix', () => { expect(() => validatePrefix('CM')).not.toThrow(); });
  it('accepts 3-letter uppercase prefix', () => { expect(() => validatePrefix('WBT')).not.toThrow(); });
  it('rejects lowercase', () => { expect(() => validatePrefix('cm')).toThrow('format'); });
  it('rejects 1-letter prefix', () => { expect(() => validatePrefix('C')).toThrow('format'); });
  it('rejects 4-letter prefix', () => { expect(() => validatePrefix('CELL')).toThrow('format'); });
  it('rejects prefix with digits', () => { expect(() => validatePrefix('C1')).toThrow('format'); });
});

describe('getNextSerial', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('returns 001 for first project serial', () => { expect(getNextSerial('project', db)).toBe('001'); });
  it('increments on each call', () => {
    expect(getNextSerial('project', db)).toBe('001');
    expect(getNextSerial('project', db)).toBe('002');
  });
  it('throws for unknown scope', () => {
    expect(() => getNextSerial('no-such-scope', db)).toThrow('does not exist');
  });
  it('is monotonic — gaps are acceptable (cancelled edits do not rollback)', () => {
    getNextSerial('project', db);
    expect(getNextSerial('project', db)).toBe('002');
  });
});

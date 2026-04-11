/**
 * Structured logger for CrickNote.
 *
 * Outputs JSON lines in production and human-readable lines in development.
 * Supports severity levels, component tags, and optional file output.
 *
 * Usage:
 *   import { logger } from '../utils/logger.js';
 *   logger.info('Server started', { port: 18789 });
 *   logger.error('Connection failed', { reason: 'timeout' });
 *
 *   // Create a child logger scoped to a component:
 *   const log = logger.child('ingestion');
 *   log.info('Indexed file', { path: 'Projects/foo.md' });
 *   // → {"ts":"...","level":"info","component":"ingestion","msg":"Indexed file","path":"Projects/foo.md"}
 */
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};
const RESET = '\x1b[0m';

export interface LoggerOptions {
  /** Minimum log level. Default: 'info'. Set via LOG_LEVEL env var. */
  level?: LogLevel;
  /** Output format. 'json' for structured, 'pretty' for human-readable. Default: auto-detect. */
  format?: 'json' | 'pretty';
  /** Optional file path to append logs to (in addition to stdout/stderr). */
  logFile?: string;
  /** Component name for scoping log lines. */
  component?: string;
}

export class Logger {
  private level: number;
  private format: 'json' | 'pretty';
  private component?: string;
  private logFile?: string;

  constructor(options: LoggerOptions = {}) {
    const envLevel = (process.env.LOG_LEVEL ?? '').toLowerCase() as LogLevel;
    const level = options.level ?? (LEVEL_ORDER[envLevel] !== undefined ? envLevel : 'info');
    this.level = LEVEL_ORDER[level];
    this.format = options.format ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');
    this.component = options.component;

    if (options.logFile) {
      fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
      this.logFile = options.logFile;
    }
  }

  /** Create a child logger with a component tag. Inherits level, format, and file output. */
  child(component: string): Logger {
    const child = new Logger();
    child.level = this.level;
    child.format = this.format;
    child.component = component;
    child.logFile = this.logFile;
    return child;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.level) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      ...(this.component ? { component: this.component } : {}),
      msg,
      ...data,
    };

    if (this.format === 'json') {
      const line = JSON.stringify(entry);
      if (level === 'error') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
      if (this.logFile) fs.appendFileSync(this.logFile, line + '\n');
    } else {
      const color = LEVEL_COLORS[level];
      const tag = this.component ? `[${this.component}] ` : '';
      const timestamp = entry.ts.slice(11, 23); // HH:MM:SS.mmm
      const extra = data && Object.keys(data).length > 0
        ? ' ' + Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
        : '';
      const line = `${color}${timestamp} ${level.toUpperCase().padEnd(5)}${RESET} ${tag}${msg}${extra}`;
      if (level === 'error') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
      // Always write JSON to file regardless of pretty console format
      if (this.logFile) fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    }
  }

  /** No-op kept for API compatibility (writes are synchronous). */
  close(): void {
    // Synchronous writes — nothing to flush.
  }
}

/** Singleton logger instance. */
export const logger = new Logger();

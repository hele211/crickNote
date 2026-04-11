import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../../src/utils/logger.js';

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('outputs JSON lines in json format', () => {
    const log = new Logger({ format: 'json', level: 'info' });
    log.info('test message', { key: 'value' });

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());

    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.key).toBe('value');
    expect(parsed.ts).toBeDefined();
  });

  it('outputs human-readable lines in pretty format', () => {
    const log = new Logger({ format: 'pretty', level: 'info' });
    log.info('server started', { port: 8080 });

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('INFO');
    expect(output).toContain('server started');
    expect(output).toContain('port=8080');
  });

  it('respects log level — filters out messages below threshold', () => {
    const log = new Logger({ format: 'json', level: 'warn' });
    log.debug('should be hidden');
    log.info('also hidden');
    log.warn('should appear');

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('should appear');
  });

  it('writes error level to stderr', () => {
    const log = new Logger({ format: 'json', level: 'info' });
    log.error('something broke', { code: 500 });

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stdoutSpy).not.toHaveBeenCalled();

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe('error');
    expect(parsed.msg).toBe('something broke');
    expect(parsed.code).toBe(500);
  });

  it('child logger includes the component tag', () => {
    const parent = new Logger({ format: 'json', level: 'info' });
    const child = parent.child('websocket');
    child.info('client connected');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.component).toBe('websocket');
    expect(parsed.msg).toBe('client connected');
  });

  it('child logger inherits level from parent', () => {
    const parent = new Logger({ format: 'json', level: 'warn' });
    const child = parent.child('ingestion');
    child.info('should be filtered');
    child.warn('should appear');

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('should appear');
  });

  it('writes to a log file when logFile is specified', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-log-'));
    const logFilePath = path.join(tmpDir, 'test.log');

    const log = new Logger({ format: 'json', level: 'info', logFile: logFilePath });
    log.info('file entry', { key: 'val' });
    log.close();

    const fileContent = fs.readFileSync(logFilePath, 'utf-8').trim();
    const parsed = JSON.parse(fileContent);
    expect(parsed.msg).toBe('file entry');
    expect(parsed.key).toBe('val');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs data without extra fields when none are provided', () => {
    const log = new Logger({ format: 'json', level: 'info' });
    log.info('plain message');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.msg).toBe('plain message');
    expect(Object.keys(parsed)).toEqual(['ts', 'level', 'msg']);
  });

  it('debug level includes all messages', () => {
    const log = new Logger({ format: 'json', level: 'debug' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    // debug + info + warn go to stdout, error goes to stderr
    expect(stdoutSpy).toHaveBeenCalledTimes(3);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultPath } from '../utils/paths.js';

export interface ChangelogArgs {
  vaultPath: string;
  /** Vault-relative path to the file that was written */
  targetPath: string;
  operation: string;
  description: string;
}

const CONTENT_FOLDER_PREFIXES = ['Projects/', 'Reading/', 'Knowledge/'];
// Knowledge/_Ops/ holds CrickNote operational artifacts (lint reports, update logs) — not research content.
const EXCLUDED_PREFIXES = ['Knowledge/_Ops/', 'Knowledge/Review-Queue/'];

/**
 * Synchronously append one line to the _changelog.md in the same folder as
 * targetPath. Skips silently when the target itself is _changelog.md or
 * _index.md, and when the path is outside the Projects/Reading/Knowledge trees.
 */
export function appendFolderChangelog(args: ChangelogArgs): void {
  const { vaultPath, targetPath, operation, description } = args;
  const normalized = targetPath.replace(/\\/g, '/');

  // Always validate vault boundary first — throws on path traversal.
  resolveVaultPath(vaultPath, normalized);

  const basename = normalized.split('/').pop() ?? '';
  if (basename === '_changelog.md') return;
  if (basename === '_index.md') return;

  const inContentFolder = CONTENT_FOLDER_PREFIXES.some(p => normalized.startsWith(p));
  if (!inContentFolder) return;
  const inExcludedFolder = EXCLUDED_PREFIXES.some(p => normalized.startsWith(p));
  if (inExcludedFolder) return;

  const segments = normalized.split('/');
  if (segments.length < 2) return;
  const folderRel = segments.slice(0, -1).join('/');
  const changelogRel = `${folderRel}/_changelog.md`;
  const changelogAbs = resolveVaultPath(vaultPath, changelogRel);

  const sanitizedOp = operation.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim();
  const sanitized = description.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const line = `${timestamp} | ${sanitizedOp} | ${sanitized}\n`;

  fs.mkdirSync(path.dirname(changelogAbs), { recursive: true });
  fs.appendFileSync(changelogAbs, line, 'utf-8');
}

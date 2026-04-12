import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { resolveVaultPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
const log = logger.child('auto-writer');

function isAutoWriteAllowed(rel: string): boolean {
  return (
    rel.startsWith('Knowledge/Review-Queue/') ||
    rel.startsWith('Knowledge/_Ops/Update-Logs/') ||
    rel.startsWith('Knowledge/_Ops/Lint-Reports/') ||
    /^Knowledge\/(Concepts|Entities|Methods)\/_index\.md$/.test(rel) ||
    /^Reading\/(Papers|Threads)\/.*-mapping(-\d{8}T\d{6})?\.md$/.test(rel) ||
    /^Projects\/P\d+-[^/]+\/.*-mapping(-\d{8}T\d{6})?\.md$/.test(rel)
  );
}

function isFencedSectionAllowed(rel: string): boolean {
  return (
    /^Projects\/P\d+-[^/]+\/_index\.md$/.test(rel) ||
    /^Projects\/P\d+-[^/]+\/[A-Z]+S\d+-[^/]+\.md$/.test(rel)
  );
}

function isFrontmatterFieldAllowed(rel: string, field: string): boolean {
  if ((rel.startsWith('Reading/Papers/') || rel.startsWith('Reading/Threads/')) && field === 'kb_status') return true;
  if (/^Knowledge\/(Concepts|Entities|Methods)\/(?!_index\.md)/.test(rel) && ['needs_review', 'review_flagged_at'].includes(field)) return true;
  return false;
}

function sha256(content: string): string { return crypto.createHash('sha256').update(content).digest('hex'); }

function writeFile(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, absPath);
}

function resolveChecked(filePath: string, vaultPath: string): { abs: string; rel: string } {
  const rel = path.relative(vaultPath, path.resolve(filePath)).replace(/\\/g, '/');
  const abs = resolveVaultPath(vaultPath, rel); // throws if outside vault
  return { abs, rel };
}

export function autoWrite(filePath: string, content: string, vaultPath: string): void {
  const { abs, rel } = resolveChecked(filePath, vaultPath);
  if (!isAutoWriteAllowed(rel)) throw new Error(`autoWrite not permitted for ${rel}`);
  writeFile(abs, content);
  log.info('autoWrite', { rel });
}

export function fencedSectionUpdate(filePath: string, sectionName: string, newContent: string, vaultPath: string): void {
  const { abs, rel } = resolveChecked(filePath, vaultPath);
  if (!isFencedSectionAllowed(rel)) throw new Error(`fencedSectionUpdate not permitted for ${rel}`);
  const open = `<!-- AUTO-GENERATED: ${sectionName} -->`;
  const close = `<!-- END AUTO-GENERATED: ${sectionName} -->`;

  function attempt(): boolean {
    const current = fs.readFileSync(abs, 'utf-8');
    const hashBefore = sha256(current);
    const openIdx = current.indexOf(open);
    if (openIdx === -1) throw new Error(`AUTO-GENERATED fence '${sectionName}' not found in ${rel}`);
    const closeIdx = current.indexOf(close, openIdx);
    if (closeIdx === -1) throw new Error(`END AUTO-GENERATED fence '${sectionName}' not found in ${rel}`);
    if (current.indexOf(open, openIdx + 1) !== -1) throw new Error(`Duplicate AUTO-GENERATED fence '${sectionName}' in ${rel}`);
    const updated = current.slice(0, openIdx + open.length) + '\n' + newContent + '\n' + current.slice(closeIdx);
    if (sha256(fs.readFileSync(abs, 'utf-8')) !== hashBefore) return false;
    writeFile(abs, updated);
    return true;
  }
  if (!attempt() && !attempt()) throw new Error(`Conflict persists after retry in ${rel}`);
}

export function frontmatterFieldUpdate(filePath: string, field: string, value: string | boolean | null, vaultPath: string): void {
  const { abs, rel } = resolveChecked(filePath, vaultPath);
  if (!isFrontmatterFieldAllowed(rel, field)) throw new Error(`frontmatterFieldUpdate not permitted: field '${field}' on ${rel}`);

  function attempt(): boolean {
    const current = fs.readFileSync(abs, 'utf-8');
    const hashBefore = sha256(current);
    const parsed = matter(current);
    parsed.data[field] = value;
    const updated = matter.stringify(parsed.content, parsed.data);
    if (sha256(fs.readFileSync(abs, 'utf-8')) !== hashBefore) return false;
    writeFile(abs, updated);
    return true;
  }
  if (!attempt() && !attempt()) throw new Error(`Conflict updating ${field} in ${rel}`);
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import type { ToolHandler } from './registry.js';
import { loadConfig, type CrickNoteConfig, type ZoteroConfig } from '../../config/config.js';
import { normalizeDoi, slugifyReadingTitle } from '../../knowledge/reading-note.js';
import { resolveVaultPath } from '../../utils/paths.js';

// ─── Config guard ────────────────────────────────────────────────────────────

function getZoteroConfig(config: CrickNoteConfig): ZoteroConfig | { error: string } {
  const z = config.zotero;
  if (!z?.enabled) {
    return { error: 'Zotero integration is not enabled. Set zotero.enabled: true in your CrickNote config.' };
  }
  return z;
}

// ─── PDF validation ──────────────────────────────────────────────────────────

export function validateZoteroAttachment(pdfPath: string, storageRoot: string): void {
  const realRoot = fs.realpathSync(storageRoot);

  const lstat = fs.lstatSync(pdfPath);
  if (lstat.isSymbolicLink()) throw new Error('symlink rejected — symlinks not allowed in Zotero storage');

  const realPdf = fs.realpathSync(pdfPath);

  if (realPdf !== realRoot && !realPdf.startsWith(realRoot + path.sep)) {
    throw new Error(`Path outside Zotero storage root: "${realPdf}"`);
  }

  const stat = fs.statSync(realPdf);
  if (!stat.isFile()) throw new Error('Not a regular file');
  if (!realPdf.toLowerCase().endsWith('.pdf')) throw new Error('Not a .pdf file — extension check failed');

  const fd = fs.openSync(realPdf, 'r');
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(fd, magic, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (magic.toString('ascii') !== '%PDF') throw new Error('Not a PDF (magic bytes check failed)');

  const MB = 1024 * 1024;
  if (stat.size > 100 * MB) throw new Error(`PDF exceeds 100 MB limit (${(stat.size / MB).toFixed(1)} MB)`);
}

// ─── JSON-RPC helper ─────────────────────────────────────────────────────────

function jsonRpc(port: number, method: string, params: unknown[], timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/better-bibtex/json-rpc', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { result?: unknown; error?: unknown };
            if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
            else resolve(parsed.result);
          } catch (e) { reject(e); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Zotero JSON-RPC timeout after ${timeoutMs}ms — is Zotero running?`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function apiReady(port: number): Promise<boolean> {
  try {
    await jsonRpc(port, 'api.ready', []);
    return true;
  } catch {
    return false;
  }
}

// ─── CSL normalization helpers ───────────────────────────────────────────────

function initials(given: string | undefined): string {
  if (!given || !given.trim()) return '';
  return given
    .split(/[\s-]+/)
    .map(part => part.charAt(0).toUpperCase())
    .join('');
}

interface CslAuthor { family?: string; given?: string; literal?: string }
interface CslItem {
  title?: string;
  author?: CslAuthor[];
  issued?: { 'date-parts'?: Array<Array<number | string>> };
  'container-title'?: string;
  DOI?: string;
  abstract?: string;
}

export interface ZoteroFetchResult {
  title: string;
  authors: string[];
  year: number;
  journal: string;
  doi?: string;
  abstract?: string;
  pdf_path?: string;
  citekey: string;
  zotero_key?: string;
  slug_prefix: string;
}

function parseCslYear(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isInteger(parsed)) return parsed;
    }
  }

  return null;
}

interface ZoteroSearchResult extends CslItem {
  itemKey?: string;
  libraryID?: number;
  id?: string;
  citekey?: string;
  'citation-key'?: string;
}

function searchResultCitekey(item: ZoteroSearchResult): string | undefined {
  if (typeof item.citekey === 'string' && item.citekey.trim()) return item.citekey;
  const citationKey = item['citation-key'];
  if (typeof citationKey === 'string' && citationKey.trim()) return citationKey;
  return undefined;
}

function searchResultKey(item: ZoteroSearchResult): { zoteroKey?: string; libraryId?: number } {
  if (typeof item.itemKey === 'string' && item.itemKey.trim()) {
    const libraryId = typeof item.libraryID === 'number' && item.libraryID > 1 ? item.libraryID : undefined;
    return { zoteroKey: libraryId ? `${libraryId}:${item.itemKey}` : item.itemKey, libraryId };
  }

  if (typeof item.id !== 'string' || !item.id.trim()) return {};

  try {
    const url = new URL(item.id);
    const parts = url.pathname.split('/').filter(Boolean);
    const itemsIdx = parts.indexOf('items');
    if (itemsIdx < 1 || itemsIdx === parts.length - 1) return {};
    const rawKey = parts[itemsIdx + 1];

    if (parts[0] === 'users') {
      return { zoteroKey: rawKey, libraryId: undefined };
    }

    if (parts[0] === 'groups') {
      const parsedLibraryId = Number.parseInt(parts[1] ?? '', 10);
      if (Number.isInteger(parsedLibraryId) && parsedLibraryId > 0) {
        return { zoteroKey: `${parsedLibraryId}:${rawKey}`, libraryId: parsedLibraryId };
      }
    }
  } catch {
    return {};
  }

  return {};
}

function normalizeCsl(
  item: CslItem,
  citekey: string,
  pdfPath: string | undefined,
  zoteroKey: string | undefined
): ZoteroFetchResult | { error: string } {
  if (!item.title?.trim()) return { error: 'Item has no title.' };

  const rawAuthors = item.author ?? [];
  const authors: string[] = rawAuthors.map(a => {
    if (a.family) {
      const i = initials(a.given);
      return i ? `${a.family} ${i}` : a.family;
    }
    if (a.literal) return a.literal;
    return '';
  }).filter(Boolean);
  if (authors.length === 0) return { error: 'Item has no author.' };

  const year = parseCslYear(item.issued?.['date-parts']?.[0]?.[0]);
  if (year === null) return { error: 'Item has no publication year.' };

  if (!item['container-title']?.trim()) return { error: 'Item has no journal/container title.' };

  const firstAuthor = rawAuthors[0];
  const slugBase = firstAuthor?.family ?? firstAuthor?.literal ?? 'unknown';
  const slug_prefix = slugifyReadingTitle(slugBase);

  return {
    title: item.title.trim(),
    authors,
    year,
    journal: item['container-title'].trim(),
    doi: item.DOI ? normalizeDoi(item.DOI) : undefined,
    abstract: item.abstract || undefined,
    pdf_path: pdfPath,
    citekey,
    zotero_key: zoteroKey,
    slug_prefix,
  };
}

// ─── PDF selection ────────────────────────────────────────────────────────────

interface BbtAttachment {
  id?: string;
  open?: string;
  path?: string;
  contentType?: string;
  filename?: string;
  parentItem?: string;
  size?: number;
}

interface PdfAttachmentCandidate {
  id: string;
  path: string;
  filename: string;
  size: number;
}

type PdfSelectionResult =
  | string
  | { error: string }
  | { status: 'needs_attachment_selection'; attachments: { id: string; filename: string; size: number }[] };

function looksLikePdfAttachment(attachment: BbtAttachment): boolean {
  if (attachment.contentType === 'application/pdf') return true;
  if (typeof attachment.filename === 'string' && attachment.filename.toLowerCase().endsWith('.pdf')) return true;
  if (typeof attachment.path === 'string' && attachment.path.toLowerCase().endsWith('.pdf')) return true;
  if (typeof attachment.open === 'string' && attachment.open.startsWith('zotero://open-pdf/')) return true;
  return false;
}

function normalizePdfAttachmentCandidates(attachments: BbtAttachment[]): PdfAttachmentCandidate[] {
  return attachments.flatMap((attachment) => {
    if (!attachment.path || !looksLikePdfAttachment(attachment)) return [];

    const id = attachment.id ?? attachment.open ?? attachment.path;
    const filename = attachment.filename ?? path.basename(attachment.path);
    let size = typeof attachment.size === 'number' ? attachment.size : 0;

    if (size === 0) {
      try {
        size = fs.statSync(attachment.path).size;
      } catch {
        size = 0;
      }
    }

    return [{ id, path: attachment.path, filename, size }];
  });
}

function selectPdf(attachments: BbtAttachment[], selectedId?: string): PdfSelectionResult {
  const pdfs = normalizePdfAttachmentCandidates(attachments);
  if (pdfs.length === 0) {
    return { error: 'No PDF attached and no abstract available. Cannot ingest without at least one readable source. Open Zotero, add an abstract or attach a PDF, then retry.' };
  }

  if (selectedId) {
    const chosen = pdfs.find(a => a.id === selectedId);
    if (!chosen) return { error: `Selected attachment ${selectedId} is not a valid PDF for this item.` };
    return chosen.path;
  }

  if (pdfs.length === 1) return pdfs[0].path;

  return {
    status: 'needs_attachment_selection',
    attachments: pdfs.map(a => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
    })),
  };
}

// ─── SHA-256 helpers ──────────────────────────────────────────────────────────

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ─── Marker type ──────────────────────────────────────────────────────────────

interface ZoteroBundleMarker {
  created_by: 'zotero_prepare_bundle';
  files: Record<string, string>;
}

function readMarker(markerPath: string): ZoteroBundleMarker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as ZoteroBundleMarker;
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string, files: Record<string, string>): void {
  const marker: ZoteroBundleMarker = { created_by: 'zotero_prepare_bundle', files };
  const tmpPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(marker, null, 2));
  fs.renameSync(tmpPath, markerPath);
}

function doiSearchParams(normalizedDoi: string): unknown[] {
  return [[['DOI', 'is', normalizedDoi]]];
}

// ─── zotero_fetch_item ────────────────────────────────────────────────────────

function zoteroFetchItem(vaultPath: string, cfg: () => CrickNoteConfig): ToolHandler {
  return {
    definition: {
      name: 'zotero_fetch_item',
      description: 'Fetch metadata and PDF path from Zotero via Better BibTeX JSON-RPC.',
      parameters: {
        type: 'object',
        properties: {
          citekey: { type: 'string', description: 'Zotero citekey (e.g., smith2026)' },
          doi: { type: 'string', description: 'DOI (normalized automatically)' },
          zotero_key: { type: 'string', description: 'Item key: bare (ABCD1234) for personal library or group-prefixed (12345:ABCD1234)' },
          selected_attachment_id: { type: 'string', description: 'Re-call with this to select a specific PDF attachment' },
        },
      },
    },
    execute: async (args) => {
      const config = cfg();
      const z = getZoteroConfig(config);
      if ('error' in z) return JSON.stringify(z);

      const port = (z as ZoteroConfig).api_port;
      const storageRoot = (z as ZoteroConfig).storage_root;
      const live = await apiReady(port);

      if (!live) {
        const bbtExportPath = (z as ZoteroConfig).bbt_export_path;
        if (bbtExportPath) {
          return zoteroFetchFallback(args as Record<string, unknown>, bbtExportPath);
        }
        return JSON.stringify({ error: 'Zotero is not running, or Better BibTeX is not installed. Please open Zotero and install the Better BibTeX plugin (https://retorque.re/zotero-better-bibtex/).' });
      }

      let citekey: string | undefined;
      let zoteroKey: string | undefined;
      let libraryId: number | undefined;

      if (args.citekey) {
        // Path A — citekey provided directly
        citekey = args.citekey as string;
      } else if (args.doi) {
        // Path B — DOI provided
        const normalized = normalizeDoi(args.doi as string);
        const items = await jsonRpc(port, 'item.search', doiSearchParams(normalized)) as ZoteroSearchResult[];
        if (!Array.isArray(items) || items.length === 0) {
          return JSON.stringify({ error: `No Zotero item found for DOI "${normalized}"` });
        }
        if (items.length > 1) {
          const topItems = items.slice(0, 3);
          const keys = topItems
            .map(item => searchResultKey(item).zoteroKey)
            .filter((key): key is string => typeof key === 'string' && key.length > 0);
          let keyMap: Record<string, string> = {};
          try { keyMap = await jsonRpc(port, 'item.citationkey', [keys]) as Record<string, string>; } catch { /* fall back to empty metadata */ }
          const candidates = await Promise.all(topItems.map(async (item) => {
            const { zoteroKey: zotero_key, libraryId: libId } = searchResultKey(item);
            const citekey = searchResultCitekey(item) ?? (zotero_key ? keyMap[zotero_key] : undefined);
            const title = item.title?.trim() ?? '';
            const year = parseCslYear(item.issued?.['date-parts']?.[0]?.[0]) ?? 0;
            const journal = item['container-title']?.trim() ?? '';
            if (title || year || journal) {
              return { zotero_key: zotero_key ?? '', title, year, journal };
            }
            if (!citekey) return { zotero_key: zotero_key ?? '', title: '', year: 0, journal: '' };
            try {
              const exportParams: unknown[] = [[citekey], 'Better CSL JSON'];
              if (libId) exportParams.push(libId);
              const exportRaw = await jsonRpc(port, 'item.export', exportParams) as string;
              const cslItems = JSON.parse(exportRaw) as CslItem[];
              const csl = cslItems?.[0];
              return {
                zotero_key,
                title: csl?.title?.trim() ?? '',
                year: csl?.issued?.['date-parts']?.[0]?.[0] ?? 0,
                journal: csl?.['container-title']?.trim() ?? '',
              };
            } catch {
              return { zotero_key, title: '', year: 0, journal: '' };
            }
          }));
          return JSON.stringify({ status: 'needs_item_selection', candidates });
        }
        const item = items[0];
        ({ zoteroKey, libraryId } = searchResultKey(item));
        citekey = searchResultCitekey(item);
        if (!citekey && zoteroKey) {
          const keyMap = await jsonRpc(port, 'item.citationkey', [[zoteroKey]]) as Record<string, string>;
          citekey = keyMap[zoteroKey];
        }
        if (!citekey) {
          return JSON.stringify({ error: zoteroKey ? `Could not resolve citekey for item "${zoteroKey}"` : `Could not resolve citekey for DOI "${normalized}"` });
        }
      } else if (args.zotero_key) {
        // Path C — item key provided
        const rawKey = args.zotero_key as string;
        zoteroKey = rawKey;
        const colonIdx = rawKey.indexOf(':');
        if (colonIdx > 0) {
          libraryId = parseInt(rawKey.slice(0, colonIdx), 10);
        }
        const keyMap = await jsonRpc(port, 'item.citationkey', [[rawKey]]) as Record<string, string>;
        citekey = keyMap[rawKey];
        if (!citekey) return JSON.stringify({ error: `Could not resolve citekey for item key "${rawKey}"` });
      } else {
        return JSON.stringify({ error: 'At least one of citekey, doi, or zotero_key is required.' });
      }

      // Fetch metadata via item.export
      const exportParams: unknown[] = [[citekey], 'Better CSL JSON'];
      if (libraryId) exportParams.push(libraryId);
      const exportRaw = await jsonRpc(port, 'item.export', exportParams) as string;

      let cslItems: CslItem[];
      try {
        cslItems = JSON.parse(exportRaw) as CslItem[];
      } catch {
        return JSON.stringify({ error: 'Failed to parse CSL JSON from Zotero item.export' });
      }
      if (!Array.isArray(cslItems) || cslItems.length === 0) {
        return JSON.stringify({ error: `No CSL data returned for citekey "${citekey}"` });
      }

      // Validate CSL fields early so title/author/year errors take priority
      const normalizedCsl = normalizeCsl(cslItems[0], citekey, undefined, zoteroKey);
      if ('error' in normalizedCsl) return JSON.stringify(normalizedCsl);

      // Fetch attachments
      const attParams: unknown[] = [citekey];
      if (libraryId) attParams.push(libraryId);
      const attachments = await jsonRpc(port, 'item.attachments', attParams) as BbtAttachment[];

      // PDF selection
      let pdfPath: string | undefined;
      const pdfResult = selectPdf(
        Array.isArray(attachments) ? attachments : [],
        args.selected_attachment_id as string | undefined
      );

      if (typeof pdfResult === 'string') {
        // Validate PDF attachment
        try {
          validateZoteroAttachment(pdfResult, storageRoot);
          pdfPath = pdfResult;
        } catch (e) {
          return JSON.stringify({ error: (e as Error).message });
        }
      } else if ('status' in pdfResult) {
        // Multiple PDFs — needs disambiguation
        return JSON.stringify(pdfResult);
      } else if ('error' in pdfResult) {
        // No PDF — check for abstract
        if (!cslItems[0].abstract) {
          return JSON.stringify(pdfResult);
        }
        pdfPath = undefined; // abstract-only mode
      }

      return JSON.stringify({ ...normalizedCsl, pdf_path: pdfPath });
    },
  };
}

function zoteroFetchFallback(args: Record<string, unknown>, exportPath: string): string {
  if (!args.citekey && !args.doi) {
    return JSON.stringify({ error: 'Fallback mode requires citekey or DOI; item-key lookup requires a live Zotero connection.' });
  }
  let library: (CslItem & { id?: string })[];
  try {
    library = JSON.parse(fs.readFileSync(exportPath, 'utf-8')) as (CslItem & { id?: string })[];
  } catch {
    return JSON.stringify({ error: `Failed to read BBT export at "${exportPath}"` });
  }
  if (!Array.isArray(library)) return JSON.stringify({ error: 'BBT export is not a JSON array.' });

  let item: (CslItem & { id?: string }) | undefined;
  if (args.citekey) {
    item = library.find(i => i.id === args.citekey);
  } else if (args.doi) {
    const needle = normalizeDoi(args.doi as string);
    const matches = library.filter(i => i.DOI && normalizeDoi(i.DOI) === needle);
    if (matches.length > 1) return JSON.stringify({ error: 'Multiple entries match DOI in export; re-run with citekey to disambiguate.' });
    item = matches[0];
  }

  if (!item) return JSON.stringify({ error: 'Item not found in BBT export.' });
  if (!item.abstract) {
    return JSON.stringify({ error: 'No PDF attached and no abstract available. Cannot ingest without at least one readable source. Open Zotero, add an abstract or attach a PDF, then retry.' });
  }

  const result = normalizeCsl(item, (args.citekey as string) ?? item.id ?? '', undefined, undefined);
  return JSON.stringify(result);
}

// ─── Slug validation ──────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ─── zotero_prepare_bundle ────────────────────────────────────────────────────

function zoteroPrepareBundleTool(vaultPath: string, cfg: () => CrickNoteConfig): ToolHandler {
  return {
    definition: {
      name: 'zotero_prepare_bundle',
      description: 'Create the vault attachment directory and copy the Zotero PDF (or write abstract.md) for Zotero ingestion.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Note slug (kebab-case)' },
          pdf_path: { type: 'string', description: 'Validated absolute path from zotero_fetch_item' },
          abstract: { type: 'string', description: 'Used only in abstract-only mode (no pdf_path)' },
        },
        required: ['slug'],
      },
    },
    execute: async (args) => {
      const config = cfg();
      const z = getZoteroConfig(config);
      if ('error' in z) return JSON.stringify(z);

      const slug = args.slug;
      if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return JSON.stringify({ error: 'Invalid slug format.' });

      const rawBundleDir = path.join(vaultPath, (z as ZoteroConfig).vault_pdf_dir, slug);
      if (fs.existsSync(rawBundleDir) && fs.lstatSync(rawBundleDir).isSymbolicLink()) {
        return JSON.stringify({ error: 'Bundle directory is a symlink — refusing to operate.' });
      }
      let bundleDir: string;
      try {
        bundleDir = resolveVaultPath(vaultPath, path.join((z as ZoteroConfig).vault_pdf_dir, slug));
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message });
      }
      const markerPath = path.join(bundleDir, '.zotero-bundle');
      const pdfPath = typeof args.pdf_path === 'string' && args.pdf_path ? args.pdf_path : undefined;
      const abstract = typeof args.abstract === 'string' && args.abstract ? args.abstract : undefined;

      // Vault boundary check — reject symlinked or escaped bundle paths
      const realVault = fs.realpathSync(vaultPath);
      if (fs.existsSync(bundleDir)) {
        if (fs.lstatSync(bundleDir).isSymbolicLink()) {
          return JSON.stringify({ error: 'Bundle directory is a symlink — refusing to operate.' });
        }
        const realDir = fs.realpathSync(bundleDir);
        if (!realDir.startsWith(realVault + path.sep) && realDir !== realVault) {
          return JSON.stringify({ error: 'Bundle directory resolves outside vault — refusing to operate.' });
        }
      } else {
        const parentDir = path.dirname(bundleDir);
        if (fs.existsSync(parentDir)) {
          const realParent = fs.realpathSync(parentDir);
          if (!realParent.startsWith(realVault + path.sep) && realParent !== realVault) {
            return JSON.stringify({ error: 'Bundle directory parent resolves outside vault — refusing to operate.' });
          }
        }
      }

      const dirExists = fs.existsSync(bundleDir);
      const hasMarker = dirExists && fs.existsSync(markerPath);

      if (dirExists && !hasMarker) {
        return JSON.stringify({ error: `Pre-existing manual bundle at Reading/attachments/${slug}/ — remove or rename it before using Zotero ingestion.` });
      }

      let existingMarkerFiles: Record<string, string> = {};
      if (hasMarker) {
        const existingMarker = readMarker(markerPath);
        if (!existingMarker || existingMarker.created_by !== 'zotero_prepare_bundle') {
          return JSON.stringify({ error: `Marker at Reading/attachments/${slug}/.zotero-bundle was not created by zotero_prepare_bundle. Refusing to operate.` });
        }
        existingMarkerFiles = existingMarker.files;
      }

      if (!dirExists) {
        fs.mkdirSync(bundleDir, { recursive: true });
      }

      const filesCreated: string[] = [];
      const mode = pdfPath ? 'pdf' : 'abstract';

      if (mode === 'pdf') {
        // TOCTOU guard: validate again before copying
        try {
          validateZoteroAttachment(pdfPath!, (z as ZoteroConfig).storage_root);
        } catch (e) {
          if (!dirExists) try { fs.rmdirSync(bundleDir); } catch { /* ignore */ }
          return JSON.stringify({ error: (e as Error).message });
        }

        const destPdf = path.join(bundleDir, 'paper.pdf');
        const sourceHash = sha256File(pdfPath!);
        if (fs.existsSync(destPdf)) {
          if (fs.lstatSync(destPdf).isSymbolicLink()) {
            if (!dirExists) try { fs.rmdirSync(bundleDir); } catch { /* ignore */ }
            return JSON.stringify({ error: 'paper.pdf is a symlink — delete it and re-run to create a vault-owned copy.' });
          }
          const existingHash = sha256File(destPdf);
          if (existingHash !== sourceHash) {
            if (!dirExists) try { fs.rmdirSync(bundleDir); } catch { /* ignore */ }
            return JSON.stringify({ error: `paper.pdf already exists with different content. Delete or rename it before re-running.` });
          }
          // Matching hash and not a symlink — skip copy (don't add to filesCreated)
        } else {
          const tmpPdf = destPdf + '.tmp';
          try {
            fs.copyFileSync(pdfPath!, tmpPdf);
            fs.renameSync(tmpPdf, destPdf);
          } catch (e) {
            try { fs.unlinkSync(tmpPdf); } catch { /* best effort */ }
            if (!dirExists) try { fs.rmdirSync(bundleDir); } catch { /* ignore */ }
            return JSON.stringify({ error: `Failed to copy Zotero PDF into vault: ${(e as Error).message}` });
          }
          filesCreated.push('paper.pdf');
        }

        const mergedFiles = { ...existingMarkerFiles, 'paper.pdf': sourceHash };
        try {
          writeMarker(markerPath, mergedFiles);
        } catch {
          for (const f of filesCreated) {
            try { fs.unlinkSync(path.join(bundleDir, f)); } catch { /* best effort */ }
          }
          if (!dirExists) {
            try {
              if (fs.readdirSync(bundleDir).length === 0) fs.rmdirSync(bundleDir);
            } catch { /* ignore */ }
          }
          return JSON.stringify({ error: 'Failed to write .zotero-bundle marker. Bundle rolled back.' });
        }

        return JSON.stringify({ source_type: 'pdf', source_path: 'paper.pdf', pdf_copied: true, files_created_this_run: filesCreated });

      } else {
        // Abstract-only mode
        if (!abstract) {
          if (!dirExists) try { fs.rmdirSync(bundleDir); } catch { /* ignore */ }
          return JSON.stringify({ error: 'Either pdf_path or abstract must be provided.' });
        }

        const destAbstract = path.join(bundleDir, 'abstract.md');
        const abstractContent = `# Abstract\n\n${abstract}`;
        if (fs.existsSync(destAbstract)) {
          const existingHash = sha256File(destAbstract);
          const sourceHash = sha256Text(abstractContent);
          if (existingHash !== sourceHash) {
            if (!dirExists) try { fs.rmdirSync(bundleDir); } catch { /* ignore */ }
            return JSON.stringify({ error: 'abstract.md already exists with different content.' });
          }
          // Matching hash — skip write
        } else {
          fs.writeFileSync(destAbstract, abstractContent, 'utf-8');
          filesCreated.push('abstract.md');
        }

        const abstractHash = sha256File(destAbstract);
        const mergedFiles = { ...existingMarkerFiles, 'abstract.md': abstractHash };
        try {
          writeMarker(markerPath, mergedFiles);
        } catch {
          for (const f of filesCreated) {
            try { fs.unlinkSync(path.join(bundleDir, f)); } catch { /* best effort */ }
          }
          if (!dirExists) {
            try {
              if (fs.readdirSync(bundleDir).length === 0) fs.rmdirSync(bundleDir);
            } catch { /* ignore */ }
          }
          return JSON.stringify({ error: 'Failed to write .zotero-bundle marker. Bundle rolled back.' });
        }

        return JSON.stringify({ source_type: 'notes', source_path: 'abstract.md', files_created_this_run: filesCreated });
      }
    },
  };
}

// ─── zotero_cleanup_bundle ────────────────────────────────────────────────────

function zoteroCleanupBundleTool(vaultPath: string, cfg: () => CrickNoteConfig): ToolHandler {
  return {
    definition: {
      name: 'zotero_cleanup_bundle',
      description: 'Remove vault attachment files created by zotero_prepare_bundle on cancel. Hash-gated to prevent destroying user-modified files.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Scoped cleanup: only these files are candidates. Omit for full marker-based cleanup.',
          },
        },
        required: ['slug'],
      },
    },
    execute: async (args) => {
      const config = cfg();
      const z = getZoteroConfig(config);
      if ('error' in z) return JSON.stringify(z);

      const slug = args.slug;
      if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return JSON.stringify({ error: 'Invalid slug format.' });

      const rawBundleDir = path.join(vaultPath, (z as ZoteroConfig).vault_pdf_dir, slug);
      if (fs.existsSync(rawBundleDir) && fs.lstatSync(rawBundleDir).isSymbolicLink()) {
        return JSON.stringify({ error: 'Bundle directory is a symlink — refusing to operate.' });
      }
      let bundleDir: string;
      try {
        bundleDir = resolveVaultPath(vaultPath, path.join((z as ZoteroConfig).vault_pdf_dir, slug));
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message });
      }
      const markerPath = path.join(bundleDir, '.zotero-bundle');

      if (!fs.existsSync(markerPath)) {
        return JSON.stringify({ error: 'No .zotero-bundle marker found. Refusing to operate on an unmanaged directory.' });
      }

      const marker = readMarker(markerPath);
      if (!marker) return JSON.stringify({ error: 'Failed to read .zotero-bundle marker.' });
      if (marker.created_by !== 'zotero_prepare_bundle') {
        return JSON.stringify({ error: 'Marker was not created by zotero_prepare_bundle. Refusing to operate.' });
      }

      const realBundleDir = fs.realpathSync(bundleDir);
      const realVaultCleanup = fs.realpathSync(vaultPath);
      if (!realBundleDir.startsWith(realVaultCleanup + path.sep) && realBundleDir !== realVaultCleanup) {
        return JSON.stringify({ error: 'Bundle directory resolves outside vault — refusing to operate.' });
      }

      const scopedFiles: Set<string> | undefined = Array.isArray(args.files)
        ? new Set(args.files as string[])
        : undefined;

      const deleted: string[] = [];
      const skipped: string[] = [];
      const surviving: Record<string, string> = {};

      for (const [filename, storedHash] of Object.entries(marker.files)) {
        // Reject empty, dot-only, or path-separator filenames
        if (!filename || filename === '.' || filename === '..' || path.basename(filename) !== filename || filename.includes('/') || filename.includes('\\')) {
          skipped.push(filename);
          continue;
        }

        const filePath = path.join(bundleDir, filename);
        const inScope = scopedFiles === undefined || scopedFiles.has(filename);

        if (!fs.existsSync(filePath)) {
          // Ghost entry — drop from marker regardless of scope
          continue;
        }

        let lstat: fs.Stats;
        try {
          lstat = fs.lstatSync(filePath);
        } catch {
          skipped.push(filename);
          surviving[filename] = storedHash;
          continue;
        }

        if (!inScope) {
          // Out-of-scope: preserve in surviving marker
          surviving[filename] = storedHash;
          continue;
        }

        if (lstat.isSymbolicLink()) {
          const currentHash = sha256File(filePath);
          if (currentHash !== storedHash) {
            skipped.push(filename);
            surviving[filename] = storedHash;
            continue;
          }

          fs.unlinkSync(filePath);
          deleted.push(filename);
          continue;
        }

        // Containment guard — resolved path must stay inside bundleDir
        let realFilePath: string;
        try {
          realFilePath = fs.realpathSync(filePath);
        } catch {
          skipped.push(filename);
          surviving[filename] = storedHash;
          continue;
        }
        if (realFilePath !== realBundleDir && !realFilePath.startsWith(realBundleDir + path.sep)) {
          skipped.push(filename);
          surviving[filename] = storedHash;
          continue;
        }

        // Reject directories (e.g. "." resolves inside bundleDir but is not a file)
        if (!fs.statSync(filePath).isFile()) {
          skipped.push(filename);
          surviving[filename] = storedHash;
          continue;
        }

        const currentHash = sha256File(filePath);
        if (currentHash !== storedHash) {
          // Hash mismatch — user modified, keep it
          skipped.push(filename);
          surviving[filename] = storedHash;
          continue;
        }

        fs.unlinkSync(filePath);
        deleted.push(filename);
      }

      // Rewrite or delete marker
      if (Object.keys(surviving).length > 0) {
        writeMarker(markerPath, surviving);
      } else {
        try { fs.unlinkSync(markerPath); } catch { /* best effort */ }
      }

      // Remove directory if now empty
      let dirRemoved = false;
      try {
        const remaining = fs.readdirSync(bundleDir);
        if (remaining.length === 0) {
          fs.rmdirSync(bundleDir);
          dirRemoved = true;
        }
      } catch { /* dir may already be gone */ }

      return JSON.stringify({ deleted, skipped, dir_removed: dirRemoved });
    },
  };
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createZoteroTools(vaultPath: string): ToolHandler[] {
  function cfg(): CrickNoteConfig { return loadConfig(); }
  return [
    zoteroFetchItem(vaultPath, cfg),
    zoteroPrepareBundleTool(vaultPath, cfg),
    zoteroCleanupBundleTool(vaultPath, cfg),
  ];
}

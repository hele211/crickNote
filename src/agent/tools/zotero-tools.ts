import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import type { ToolHandler } from './registry.js';
import { loadConfig, type CrickNoteConfig, type ZoteroConfig } from '../../config/config.js';
import { normalizeDoi, slugifyReadingTitle } from '../../knowledge/reading-note.js';

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

function jsonRpc(port: number, method: string, params: unknown[]): Promise<unknown> {
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
  issued?: { 'date-parts'?: number[][] };
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

  const yearRaw = item.issued?.['date-parts']?.[0]?.[0];
  if (typeof yearRaw !== 'number') return { error: 'Item has no publication year.' };

  if (!item['container-title']?.trim()) return { error: 'Item has no journal/container title.' };

  const firstAuthor = rawAuthors[0];
  const slugBase = firstAuthor?.family ?? firstAuthor?.literal ?? 'unknown';
  const slug_prefix = slugifyReadingTitle(slugBase);

  return {
    title: item.title.trim(),
    authors,
    year: yearRaw,
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
  path?: string;
  contentType?: string;
  filename?: string;
  parentItem?: string;
  size?: number;
}

type PdfSelectionResult =
  | string
  | { error: string }
  | { status: 'needs_attachment_selection'; attachments: { id: string; filename: string; size: number }[] };

function selectPdf(attachments: BbtAttachment[], selectedId?: string): PdfSelectionResult {
  const pdfs = attachments.filter(a => a.contentType === 'application/pdf' && a.path);
  if (pdfs.length === 0) {
    return { error: 'No PDF attached and no abstract available. Cannot ingest without at least one readable source. Open Zotero, add an abstract or attach a PDF, then retry.' };
  }

  if (selectedId) {
    const chosen = pdfs.find(a => a.id === selectedId);
    if (!chosen?.path) return { error: `Selected attachment ${selectedId} is not a valid PDF for this item.` };
    return chosen.path;
  }

  if (pdfs.length === 1) return pdfs[0].path!;

  return {
    status: 'needs_attachment_selection',
    attachments: pdfs.map(a => ({
      id: a.id ?? '',
      filename: a.filename ?? path.basename(a.path ?? ''),
      size: a.size ?? 0,
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
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
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
        const items = await jsonRpc(port, 'item.search', [[['DOI', 'is', normalized]]]) as Array<{ itemKey: string; libraryID: number }>;
        if (!Array.isArray(items) || items.length === 0) {
          return JSON.stringify({ error: `No Zotero item found for DOI "${normalized}"` });
        }
        if (items.length > 1) {
          const candidates = items.slice(0, 3).map(i => ({
            zotero_key: i.libraryID === 1 ? i.itemKey : `${i.libraryID}:${i.itemKey}`,
            title: '', year: 0, journal: '',
          }));
          return JSON.stringify({ status: 'needs_item_selection', candidates });
        }
        const item = items[0];
        libraryId = item.libraryID === 1 ? undefined : item.libraryID;
        zoteroKey = libraryId ? `${item.libraryID}:${item.itemKey}` : item.itemKey;
        const keyMap = await jsonRpc(port, 'item.citationkey', [zoteroKey]) as Record<string, string>;
        citekey = keyMap[zoteroKey];
        if (!citekey) return JSON.stringify({ error: `Could not resolve citekey for item "${zoteroKey}"` });
      } else if (args.zotero_key) {
        // Path C — item key provided
        const rawKey = args.zotero_key as string;
        zoteroKey = rawKey;
        const colonIdx = rawKey.indexOf(':');
        if (colonIdx > 0) {
          libraryId = parseInt(rawKey.slice(0, colonIdx), 10);
        }
        const keyMap = await jsonRpc(port, 'item.citationkey', [rawKey]) as Record<string, string>;
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
      const cslValidation = normalizeCsl(cslItems[0], citekey, undefined, zoteroKey);
      if ('error' in cslValidation) return JSON.stringify(cslValidation);

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

      const result = normalizeCsl(cslItems[0], citekey, pdfPath, zoteroKey);
      return JSON.stringify(result);
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

  const result = normalizeCsl(item, (args.citekey as string) ?? '', undefined, undefined);
  return JSON.stringify(result);
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createZoteroTools(vaultPath: string): ToolHandler[] {
  function cfg(): CrickNoteConfig { return loadConfig(); }
  return [
    zoteroFetchItem(vaultPath, cfg),
    // zoteroPrepareBundleTool and zoteroCleanupBundleTool added in Tasks 12+13
  ];
}

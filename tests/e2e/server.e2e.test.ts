/**
 * End-to-End tests for CrickNote.
 *
 * These tests start the REAL server (WebSocket + ingestion) against the
 * sample-vault fixture, then exercise the full flows that the Obsidian
 * plugin would perform:
 *
 *   connect → auth → status → chat → tool execution → edit proposal → confirm/cancel
 *
 * Unlike unit tests that mock dependencies, E2E tests use every real component
 * wired together, so they catch integration bugs that unit tests miss.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { createWebSocketServer } from '../../src/server/websocket.js';
import { generateToken, readToken } from '../../src/server/auth.js';
import { getDatabase, closeDatabase } from '../../src/storage/database.js';
import { IngestionWorker } from '../../src/ingestion/worker.js';
import type { CrickNoteConfig } from '../../src/config/config.js';
import type { WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_VAULT = path.resolve('tests/fixtures/sample-vault');
const RUN_SOCKET_TESTS = process.env.CRICKNOTE_RUN_SOCKET_TESTS === '1';
const describeSockets = RUN_SOCKET_TESTS ? describe : describe.skip;

/** Copy the sample vault into a temp directory so tests can write without polluting fixtures. */
function copyVault(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-e2e-'));
  copyRecursive(SAMPLE_VAULT, tmp);
  return tmp;
}

function copyRecursive(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Open a WebSocket, authenticate, and return a helper object. */
function createClient(port: number, token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'auth',
        token,
        protocolVersion: 1,
        pluginVersion: '0.1.0',
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_ok') {
        clearTimeout(timeout);
        resolve(new TestClient(ws));
      } else if (msg.type === 'auth_error') {
        clearTimeout(timeout);
        reject(new Error(`Auth failed: ${msg.reason}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

class TestClient {
  private ws: WebSocket;
  private pendingMessages: Record<string, unknown>[] = [];
  private waiters: Array<(msg: Record<string, unknown>) => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (this.waiters.length > 0) {
        this.waiters.shift()!(msg);
      } else {
        this.pendingMessages.push(msg);
      }
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait for the next server message, with a timeout. */
  receive(timeoutMs = 10000): Promise<Record<string, unknown>> {
    if (this.pendingMessages.length > 0) {
      return Promise.resolve(this.pendingMessages.shift()!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Receive timeout')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('E2E: CrickNote server', () => {
  let vaultPath: string;
  let dataDir: string;
  let config: CrickNoteConfig;
  let wss: WebSocketServer;
  let ingestion: IngestionWorker;
  let token: string;
  let port: number;
  const originalDataDir = process.env.CRICKNOTE_DATA_DIR;

  beforeAll(async () => {
    // Use a temp copy of the vault so write tests don't touch fixtures
    vaultPath = copyVault();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-e2e-data-'));
    process.env.CRICKNOTE_DATA_DIR = dataDir;

    // Generate an auth token
    generateToken();
    token = readToken();

    // Pick a random high port to avoid collisions
    port = 19000 + Math.floor(Math.random() * 1000);

    config = {
      vaultPath,
      llm: { provider: 'anthropic', apiKey: 'sk-ant-test-placeholder' },
      server: { host: '127.0.0.1', port },
    };

    // Initialize database and ingest the sample vault
    const dbPath = path.join(os.tmpdir(), `cricknote-e2e-${Date.now()}.sqlite`);
    getDatabase(dbPath);

    ingestion = new IngestionWorker(vaultPath, { watchForChanges: false });
    await ingestion.start();

    // Wait for indexing to settle
    await new Promise(r => setTimeout(r, 2000));

    if (RUN_SOCKET_TESTS) {
      wss = await createWebSocketServer(config);
    }
  }, 30000);

  afterAll(() => {
    wss?.close();
    ingestion?.stop();
    closeDatabase();
    fs.rmSync(vaultPath, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.CRICKNOTE_DATA_DIR = originalDataDir;
  });

  // -------------------------------------------------------------------------
  // 1. Connection & Authentication
  // -------------------------------------------------------------------------

  describeSockets('authentication', () => {
    it('accepts a valid token and returns auth_ok', async () => {
      const client = await createClient(port, token);
      client.close();
      // If we got here, auth succeeded (createClient rejects on auth_error)
    });

    it('rejects an invalid token with auth_error', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'auth',
            token: 'wrong-token',
            protocolVersion: 1,
            pluginVersion: '0.1.0',
          }));
        });
        ws.on('message', (data) => resolve(JSON.parse(data.toString())));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      expect(msg.type).toBe('auth_error');
      expect(msg.reason).toBe('invalid_token');
      ws.close();
    });

    it('rejects a wrong protocol version', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'auth',
            token,
            protocolVersion: 99,
            pluginVersion: '0.1.0',
          }));
        });
        ws.on('message', (data) => resolve(JSON.parse(data.toString())));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      expect(msg.type).toBe('auth_error');
      expect(msg.reason).toBe('version_mismatch');
      expect(msg.required).toBe(1);
      ws.close();
    });

    it('closes connection for unauthenticated messages', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const code = await new Promise<number>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'chat', content: 'hello' }));
        });
        ws.on('close', (c) => resolve(c));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      expect(code).toBe(4002);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Status
  // -------------------------------------------------------------------------

  describeSockets('status', () => {
    it('returns indexing state with file counts from the sample vault', async () => {
      const client = await createClient(port, token);
      client.send({ type: 'status' });
      const msg = await client.receive();

      expect(msg.type).toBe('status_response');
      expect(msg.indexing).toBeDefined();
      const indexing = msg.indexing as { state: string; total: number; indexed: number };
      expect(indexing.indexed).toBeGreaterThan(0);
      expect(indexing.total).toBeGreaterThan(0);

      client.close();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Error handling
  // -------------------------------------------------------------------------

  describeSockets('error handling', () => {
    it('rejects malformed JSON', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      // Need to auth first, then send bad JSON — but raw ws doesn't let us send non-JSON after auth easily.
      // Actually, the server handles bad JSON before auth too:
      const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.on('open', () => {
          ws.send('this is not json{{{');
        });
        ws.on('message', (data) => resolve(JSON.parse(data.toString())));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      expect(msg.type).toBe('error');
      expect(msg.message).toBe('Invalid JSON');
      ws.close();
    });

    it('rejects empty chat content', async () => {
      const client = await createClient(port, token);
      client.send({ type: 'chat', content: '' });
      const msg = await client.receive();

      expect(msg.type).toBe('error');
      expect(msg.message).toBe('content must be a non-empty string');
      client.close();
    });

    it('rejects invalid edit_confirm actions', async () => {
      const client = await createClient(port, token);
      client.send({ type: 'edit_confirm', action: 'delete', editId: 'fake' });
      const msg = await client.receive();

      expect(msg.type).toBe('error');
      expect(msg.message as string).toContain('Invalid action');
      expect(msg.message as string).toContain('delete');
      client.close();
    });

    it('handles edit_confirm for unknown editId gracefully', async () => {
      const client = await createClient(port, token);
      client.send({ type: 'edit_confirm', action: 'cancel', editId: 'nonexistent-id' });
      const msg = await client.receive();

      expect(msg.type).toBe('edit_result');
      expect(msg.success).toBe(false);
      client.close();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Vault tools (direct execution without LLM)
  // -------------------------------------------------------------------------

  describe('vault tools — direct execution', () => {
    // These tests exercise the tool layer directly rather than going through
    // the LLM (which would need a real API key). This still validates the full
    // server-side pipeline: tool registry → tool execution → response.

    it('vault_read returns file content from the sample vault', async () => {
      const { createVaultTools } = await import('../../src/agent/tools/vault.js');
      const tools = createVaultTools(vaultPath);
      const readTool = tools.find(t => t.definition.name === 'vault_read')!;

      const result = JSON.parse(await readTool.execute({
        path: 'Projects/ProjectA-CellMigration/2026-03-24-western-blot.md',
      }));

      expect(result.frontmatter.experiment_type).toBe('western-blot');
      expect(result.frontmatter.project).toBe('ProjectA-CellMigration');
      expect(result.content).toContain('p53 protein levels');
    });

    it('vault_list returns indexed notes from the database', async () => {
      const { createVaultTools } = await import('../../src/agent/tools/vault.js');
      const tools = createVaultTools(vaultPath);
      const listTool = tools.find(t => t.definition.name === 'vault_list')!;

      const result = JSON.parse(await listTool.execute({ folder: 'Projects' }));

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      const paths = result.map((r: { path: string }) => r.path);
      expect(paths.some((p: string) => p.includes('western-blot'))).toBe(true);
    });

    it('vault_read rejects path traversal', async () => {
      const { createVaultTools } = await import('../../src/agent/tools/vault.js');
      const tools = createVaultTools(vaultPath);
      const readTool = tools.find(t => t.definition.name === 'vault_read')!;

      const result = JSON.parse(await readTool.execute({ path: '../../../etc/passwd' }));
      expect(result.error).toBeDefined();
    });

    it('vault_write returns a pending_edit for a new file', async () => {
      const { createVaultTools } = await import('../../src/agent/tools/vault.js');
      const tools = createVaultTools(vaultPath);
      const writeTool = tools.find(t => t.definition.name === 'vault_write')!;

      const result = JSON.parse(await writeTool.execute({
        path: 'Projects/test-note.md',
        content: '---\ndate: 2026-03-31\n---\n# Test\n',
      }));

      expect(result.type).toBe('pending_edit');
      expect(result.operation).toBe('create');
    });

    it('vault_append returns a pending_edit with merged content', async () => {
      const { createVaultTools } = await import('../../src/agent/tools/vault.js');
      const tools = createVaultTools(vaultPath);
      const appendTool = tools.find(t => t.definition.name === 'vault_append')!;

      const result = JSON.parse(await appendTool.execute({
        path: 'Projects/ProjectA-CellMigration/2026-03-24-western-blot.md',
        content: '\n## Follow-up\nNeed to repeat with 72h timepoint.\n',
      }));

      expect(result.type).toBe('pending_edit');
      expect(result.operation).toBe('append');
      expect(result.newContent).toContain('Need to repeat with 72h timepoint');
      expect(result.newContent).toContain('p53 protein levels'); // original content preserved
    });
  });

  // -------------------------------------------------------------------------
  // 5. Search tools
  // -------------------------------------------------------------------------

  describe('search tools — direct execution', () => {
    it('vault_search finds notes matching a query', async () => {
      const { createSearchTools } = await import('../../src/agent/tools/search.js');
      const tools = createSearchTools();
      const searchTool = tools.find(t => t.definition.name === 'vault_search')!;

      const result = JSON.parse(await searchTool.execute({ query: 'western blot p53' }));

      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
      const paths = result.results.map((r: { path: string }) => r.path);
      expect(paths.some((p: string) => p.includes('western-blot'))).toBe(true);
    });

    it('vault_search returns empty results for nonsense query', async () => {
      const { createSearchTools } = await import('../../src/agent/tools/search.js');
      const tools = createSearchTools();
      const searchTool = tools.find(t => t.definition.name === 'vault_search')!;

      const result = JSON.parse(await searchTool.execute({ query: 'zzzyyyxxx_no_match_12345' }));

      // Should return gracefully — either empty results or a message
      expect(result.results).toBeDefined();
      expect(result.results.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Task tools
  // -------------------------------------------------------------------------

  describe('task tools — direct execution', () => {
    it('task_list returns tasks from the diary', async () => {
      const { createTaskTools } = await import('../../src/agent/tools/tasks.js');
      const tools = createTaskTools(vaultPath);
      const listTool = tools.find(t => t.definition.name === 'task_list')!;

      const result = JSON.parse(await listTool.execute({ status: 'all' }));

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Should find the tasks from 2026-03-29.md
      const taskTexts = result.map((t: { text: string }) => t.text);
      expect(taskTexts.some((t: string) => t.includes('PCR'))).toBe(true);
    });

    it('task_list filters pending tasks only', async () => {
      const { createTaskTools } = await import('../../src/agent/tools/tasks.js');
      const tools = createTaskTools(vaultPath);
      const listTool = tools.find(t => t.definition.name === 'task_list')!;

      const result = JSON.parse(await listTool.execute({ status: 'pending' }));

      // All returned tasks should be uncompleted
      for (const task of result) {
        expect(task.completed).toBe(false);
      }
    });

    it('task_add returns a pending_edit to create/update a diary note', async () => {
      const { createTaskTools } = await import('../../src/agent/tools/tasks.js');
      const tools = createTaskTools(vaultPath);
      const addTool = tools.find(t => t.definition.name === 'task_add')!;

      const result = JSON.parse(await addTool.execute({
        description: 'Run gel electrophoresis',
        project: 'ProjectA',
      }));

      expect(result.type).toBe('pending_edit');
      expect(result.newContent).toContain('Run gel electrophoresis');
      expect(result.newContent).toContain('[ProjectA]');
    });

    it('task_complete returns a pending_edit that checks off a matching task', async () => {
      const { createTaskTools } = await import('../../src/agent/tools/tasks.js');
      const tools = createTaskTools(vaultPath);
      const completeTool = tools.find(t => t.definition.name === 'task_complete')!;

      const result = JSON.parse(await completeTool.execute({
        task_description: 'PCR',
      }));

      expect(result.type).toBe('pending_edit');
      expect(result.newContent).toContain('- [x] Run PCR for ProjectB samples');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Safe editing flow (propose → confirm/cancel)
  // -------------------------------------------------------------------------

  describe('safe editing — propose and confirm', () => {
    it('proposeEdit + confirmEdit("apply") writes the file to disk', async () => {
      const { SafeWriter } = await import('../../src/editing/safe-writer.js');
      const writer = new SafeWriter();

      const targetPath = path.join(vaultPath, 'Projects', 'e2e-test-note.md');
      const content = '---\ndate: 2026-03-31\n---\n# E2E Test Note\n';

      const proposal = writer.proposeEdit(targetPath, content, 'e2e test', 'e2e-session');

      expect(proposal.editId).toBeDefined();
      expect(proposal.diff).toContain('E2E Test Note');
      expect(proposal.hasConflict).toBe(false);

      // Confirm the edit
      const result = writer.confirmEdit(proposal.editId, 'apply');
      expect(result.success).toBe(true);

      // Verify the file was actually written
      expect(fs.existsSync(targetPath)).toBe(true);
      const written = fs.readFileSync(targetPath, 'utf-8');
      expect(written).toBe(content);

      // Cleanup
      fs.unlinkSync(targetPath);
    });

    it('proposeEdit + confirmEdit("cancel") does NOT write the file', async () => {
      const { SafeWriter } = await import('../../src/editing/safe-writer.js');
      const writer = new SafeWriter();

      const targetPath = path.join(vaultPath, 'Projects', 'e2e-cancelled-note.md');
      const content = '# Should not exist\n';

      const proposal = writer.proposeEdit(targetPath, content, 'e2e cancel test', 'e2e-session');

      const result = writer.confirmEdit(proposal.editId, 'cancel');
      expect(result.success).toBe(true);

      // File should NOT exist
      expect(fs.existsSync(targetPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Ingestion pipeline
  // -------------------------------------------------------------------------

  describe('ingestion pipeline', () => {
    it('indexes all markdown files from the sample vault into the database', () => {
      const db = getDatabase();

      const notes = db.prepare('SELECT path, note_type, experiment_type, project FROM note_metadata').all() as Array<{
        path: string; note_type: string; experiment_type: string; project: string;
      }>;

      expect(notes.length).toBeGreaterThanOrEqual(4); // at least the 4 .md files in fixture

      // Verify the western blot experiment was indexed correctly
      const wb = notes.find(n => n.path.includes('western-blot'));
      expect(wb).toBeDefined();
      expect(wb!.experiment_type).toBe('western-blot');
      expect(wb!.project).toBe('ProjectA-CellMigration');
    });

    it('creates text chunks for indexed notes', () => {
      const db = getDatabase();
      const chunks = db.prepare('SELECT COUNT(*) as count FROM note_chunks').get() as { count: number };
      expect(chunks.count).toBeGreaterThan(0);
    });

    it('populates the BM25 full-text index', () => {
      const db = getDatabase();
      const bm25 = db.prepare('SELECT COUNT(*) as count FROM bm25_index').get() as { count: number };
      expect(bm25.count).toBeGreaterThan(0);
    });
  });
});

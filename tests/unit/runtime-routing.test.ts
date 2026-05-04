import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider, Message, ToolDefinition, ChatOptions, StreamChunk } from '../../src/agent/providers/base.js';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

class FakeLLMProvider implements LLMProvider {
  name = 'fake';
  calls: Array<{ tools: ToolDefinition[]; response: string; messages: Message[] }> = [];
  private responses: string[];

  constructor(responses: string[]) { this.responses = responses; }

  async *chat(
    _messages: Message[],
    tools: ToolDefinition[],
    _opts: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    const response = this.responses[this.calls.length] ?? this.responses[this.responses.length - 1];
    this.calls.push({ tools, response, messages: [..._messages] });
    yield { type: 'text', text: response };
    yield { type: 'done' };
  }
}

let vaultPath: string;
let db: Database.Database;

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(async () => {
  const { setDatabase } = await import('../../src/storage/database.js');
  db.close();
  setDatabase(null);
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

async function makeRuntime(provider: FakeLLMProvider) {
  const { setDatabase } = await import('../../src/storage/database.js');
  setDatabase(db);

  const { AgentRuntime } = await import('../../src/agent/runtime.js');
  const runtime = new AgentRuntime({
    vaultPath,
    llm: { provider: 'openai', apiKey: 'test-key', model: 'test-model' },
  } as never);
  (runtime as Record<string, unknown>).provider = provider;
  return runtime;
}

describe('processMessage — tool routing', () => {
  it('sends zero tools for a plain chat question', async () => {
    const provider = new FakeLLMProvider(['Western blot detects proteins.']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('explain western blot', 'session-1');

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools).toHaveLength(0);
  });

  it('sends search tools for "search my vault"', async () => {
    const provider = new FakeLLMProvider(['Here are your notes.']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('search my vault for IL-42', 'session-2');

    expect(provider.calls[0].tools.map(t => t.name)).toContain('vault_search');
  });

  it('sends search tools on the first call for "what have I recorded"', async () => {
    const provider = new FakeLLMProvider(['Found your notes.']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('what have I recorded about LTP?', 'session-2b');

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools.map(t => t.name)).toContain('vault_search');
  });

  it('sends project tools for "create a new experiment"', async () => {
    const provider = new FakeLLMProvider(['Creating experiment...']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('create a new experiment for blotting', 'session-3');

    const names = provider.calls[0].tools.map(t => t.name);
    expect(names).toContain('create_experiment');
    expect(names).not.toContain('kb_lint');
  });

  it('sends project tools for typo "add an now project"', async () => {
    const provider = new FakeLLMProvider(['Creating project...']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('add an now project for me', 'session-3b');

    const names = provider.calls[0].tools.map(t => t.name);
    expect(names).toContain('create_project');
    expect(names).toContain('reserve_prefix');
    expect(names).toContain('vault_write');
  });

  it('sends write tools for "create a new note in Obsidian"', async () => {
    const provider = new FakeLLMProvider(['Creating note...']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('create a new note in Obsidian', 'session-4');

    const names = provider.calls[0].tools.map(t => t.name);
    expect(names).toContain('vault_write');
    expect(names).toContain('vault_append');
  });

  it('sends write tools on the first call for "record this in the vault"', async () => {
    const provider = new FakeLLMProvider(['Recording...']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('record this in the vault', 'session-5');

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools.map(t => t.name)).toContain('vault_write');
  });

  it('sends write tools for a short follow-up to a previous update offer', async () => {
    const provider = new FakeLLMProvider([
      'Would you like me to update KB001 experiment.md with option B?',
      'I will update it.',
    ]);
    const runtime = await makeRuntime(provider);
    const sessionId = 'session-follow-up-write';

    await runtime.processMessage('please help me calculate the digest volumes', sessionId);
    await runtime.processMessage('option B', sessionId);

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].tools).toHaveLength(0);
    expect(provider.calls[1].tools.map(t => t.name)).toContain('vault_append');
    expect(provider.calls[1].messages.map(m => m.content)).toContain('Would you like me to update KB001 experiment.md with option B?');
  });
});

describe('processMessage — retry path', () => {
  it('retries once with search tools when no-tool response signals vault needed', async () => {
    const provider = new FakeLLMProvider([
      "I don't have access to your vault to search that.",
      'Here are your notes on synaptic tagging.',
    ]);
    const runtime = await makeRuntime(provider);

    const result = await runtime.processMessage('summarize previous context about synaptic tagging', 'session-r1');

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].tools).toHaveLength(0);
    expect(provider.calls[1].tools.map(t => t.name)).toContain('vault_search');
    expect(result.content).toBe('Here are your notes on synaptic tagging.');
  });

  it('retries once with write tools when no-tool response signals write access needed', async () => {
    const provider = new FakeLLMProvider([
      'I cannot create files in Obsidian.',
      'I can create that note now.',
    ]);
    const runtime = await makeRuntime(provider);

    const result = await runtime.processMessage('please put this somewhere permanent', 'session-rw1');

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].tools).toHaveLength(0);
    const retryToolNames = provider.calls[1].tools.map(t => t.name);
    expect(retryToolNames).toContain('vault_write');
    expect(retryToolNames).toContain('create_project');
    expect(retryToolNames).toContain('reserve_prefix');
    expect(result.content).toBe('I can create that note now.');
  });

  it('deletes the stale assistant DB row before retry', async () => {
    const provider = new FakeLLMProvider([
      "I don't have access to your vault.",
      'Found your notes.',
    ]);
    const runtime = await makeRuntime(provider);
    const sessionId = 'session-r2';

    await runtime.processMessage('summarize previous context about LTP', sessionId);

    const rows = db.prepare(
      "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY timestamp ASC"
    ).all(sessionId) as Array<{ content: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('Found your notes.');
  });

  it('does not call onChunk with the failed first response', async () => {
    const provider = new FakeLLMProvider([
      "I don't have access to your vault.",
      'Found your notes.',
    ]);
    const runtime = await makeRuntime(provider);

    const chunks: string[] = [];
    await runtime.processMessage('summarize previous context about plasticity', 'session-r3', t => chunks.push(t));

    expect(chunks.join('')).not.toContain("don't have access");
    expect(chunks.join('')).toContain('Found your notes.');
  });

  it('does NOT retry a second time if the retry answer also signals vault needed', async () => {
    const provider = new FakeLLMProvider([
      "I don't have access to your vault.",
      "I still don't have access to your vault.",
    ]);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('summarize previous context about IL-42', 'session-r4');

    expect(provider.calls).toHaveLength(2);
  });

  it('does NOT retry when tools were selected by the router', async () => {
    const provider = new FakeLLMProvider(["I don't have access to your vault."]);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('search my vault for IL-42', 'session-r5');

    expect(provider.calls).toHaveLength(1);
  });

  it('replays buffered chunks through onChunk when no retry is needed', async () => {
    const provider = new FakeLLMProvider(['Western blot detects proteins by size.']);
    const runtime = await makeRuntime(provider);

    const chunks: string[] = [];
    await runtime.processMessage('explain western blot', 'session-r6', t => chunks.push(t));

    expect(chunks.join('')).toBe('Western blot detects proteins by size.');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import type { CrickNoteConfig } from '../config/config.js';
import type { LLMProvider, Message, ToolCall, StreamChunk, ToolDefinition } from './providers/base.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { ToolRegistry, type ToolContext } from './tools/registry.js';
import { createVaultTools } from './tools/vault.js';
import { createSearchTools } from './tools/search.js';
import { createTaskTools } from './tools/tasks.js';
import { createTemplateTools } from './tools/templates.js';
import { createReadingIntakeTools } from './tools/reading-intake.js';
import { createContextTools } from './tools/context.js';
import { createSerialTools } from './tools/serial-tools.js';
import { createKbTools } from './tools/kb-tools.js';
import { createZoteroTools } from './tools/zotero-tools.js';
import { assembleSystemPrompt } from './context.js';
import { SafeWriter, type EditProposal } from '../editing/safe-writer.js';
import { appendFolderChangelog } from '../editing/changelog.js';
import { getDatabase } from '../storage/database.js';
import { routeTools, needsVaultAccess, needsVaultWriteAccess, SEARCH_BUNDLE, FULL_WRITE_BUNDLE } from './tool-router.js';
import { logger } from '../utils/logger.js';

const log = logger.child('runtime');

const HISTORY_MESSAGE_LIMIT = 16;

/**
 * Strip large body fields from a stored tool result before replaying it in
 * conversation history. The LLM already acted on the full content in the turn
 * it appeared; replaying thousands of extra tokens adds cost with no benefit.
 * path and frontmatter are preserved so the model knows which file was read.
 */
export function compactToolResultForHistory(content: string): string {
  if (content.length <= 500) return content;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    let modified = false;
    if (typeof parsed.context === 'string') {
      parsed.context = '[omitted from history]';
      modified = true;
    }
    if (typeof parsed.content === 'string' && parsed.content.length > 300) {
      parsed.content = '[omitted from history]';
      modified = true;
    }
    if (modified) return JSON.stringify(parsed);
  } catch {
    // Not JSON — leave as-is.
  }
  return content;
}

interface PendingEdit {
  editId: string;
  proposal: EditProposal;
  warnings: string[];
  batchId?: string;
}

export interface RuntimeResponse {
  content: string;
  toolCalls: ToolCall[];
  pendingEdits: PendingEdit[];
}

function normalizeFollowUpText(message: string): string {
  return message
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isShortWriteFollowUp(message: string): boolean {
  const text = normalizeFollowUpText(message);
  if (!text || text.length > 60) return false;
  return /^(yes|yep|yeah|ok|okay|sure|please|do it|go ahead|continue|proceed|update it|add it|write it|save it|that one|this one|option [a-z0-9]+|[a-z])$/.test(text);
}

function recentHistoryHasWriteIntent(history: Message[]): boolean {
  const prior = history.slice(0, -1).slice(-8);
  return prior.some((m) => {
    if (m.role === 'tool') return false;
    const text = normalizeFollowUpText(m.content);
    const hasWriteVerb = /\b(add|append|update|write|save|record|put|edit|modify|apply)\b/.test(text);
    const hasVaultTarget = /\b(note|file|vault|obsidian|experiment|protocol|diary)\b|\b(?:kb|exp|prot|ser)\d{3,}\b|\.md\b/.test(text);
    return (
      (hasWriteVerb && hasVaultTarget) ||
      /\bwould you like me to\b.*\b(add|append|update|write|save|record)\b/.test(text) ||
      /\bpending confirmation\b/.test(text)
    );
  });
}

function selectToolsForMessage(userMessage: string, history: Message[]): string[] {
  const selectedNames = routeTools(userMessage);
  if (selectedNames.length > 0) return selectedNames;
  if (isShortWriteFollowUp(userMessage) && recentHistoryHasWriteIntent(history)) {
    return [...FULL_WRITE_BUNDLE];
  }
  return selectedNames;
}

export class AgentRuntime {
  private provider: LLMProvider;
  private registry: ToolRegistry;
  private safeWriter: SafeWriter;
  private config: CrickNoteConfig;
  private realVaultPath: string;
  private pendingBatches = new Map<string, string[]>();

  constructor(config: CrickNoteConfig) {
    this.config = config;

    // Resolve vault root through symlinks so boundary checks match realpath-resolved file paths.
    try {
      this.realVaultPath = fs.realpathSync(config.vaultPath);
    } catch {
      this.realVaultPath = path.resolve(config.vaultPath);
    }

    // Initialize LLM provider
    if (config.llm.provider === 'anthropic') {
      this.provider = new AnthropicProvider(config.llm.apiKey, config.llm.baseUrl);
    } else {
      this.provider = new OpenAIProvider(config.llm.apiKey, config.llm.baseUrl);
    }

    // Initialize safe writer
    this.safeWriter = new SafeWriter();
    const conflictDetector = this.safeWriter.getConflictDetector();

    // Register tools — pass conflict detector so vault_read/vault_append record snapshots
    this.registry = new ToolRegistry();
    for (const tool of createVaultTools(config.vaultPath, conflictDetector)) {
      this.registry.register(tool);
    }
    for (const tool of createSearchTools(config.vaultPath)) {
      this.registry.register(tool);
    }
    for (const tool of createTaskTools(config.vaultPath, conflictDetector)) {
      this.registry.register(tool);
    }
    for (const tool of createTemplateTools(config.vaultPath, conflictDetector)) {
      this.registry.register(tool);
    }
    for (const tool of createReadingIntakeTools(config.vaultPath, conflictDetector)) {
      this.registry.register(tool);
    }
    for (const tool of createContextTools(config.vaultPath)) {
      this.registry.register(tool);
    }
    for (const tool of createSerialTools(config.vaultPath)) {
      this.registry.register(tool);
    }
    for (const tool of createKbTools(config.vaultPath)) {
      this.registry.register(tool);
    }
    for (const tool of createZoteroTools(config.vaultPath)) {
      this.registry.register(tool);
    }
  }

  private async runAgentLoop(
    history: Message[],
    toolDefs: ToolDefinition[],
    userMessage: string,
    sessionId: string,
    onChunk?: (text: string) => void,
  ): Promise<{ content: string; toolCalls: ToolCall[]; pendingEdits: PendingEdit[] }> {
    const db = getDatabase();
    const systemPrompt = assembleSystemPrompt(this.config.vaultPath, toolDefs, this.config);
    const allToolCalls: ToolCall[] = [];
    const pendingEdits: PendingEdit[] = [];
    let finalContent = '';
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;

      let text = '';
      const toolCallsThisTurn: ToolCall[] = [];
      const toolCallAccumulators = new Map<string, { id: string; name: string; args: string }>();

      for await (const chunk of this.provider.chat(history, toolDefs, {
        systemPrompt,
        model: this.config.llm.model,
      })) {
        if (chunk.type === 'text' && chunk.text) {
          text += chunk.text;
          onChunk?.(chunk.text);
        } else if (chunk.type === 'tool_call_start' && chunk.toolCall) {
          toolCallAccumulators.set(chunk.toolCall.id, {
            id: chunk.toolCall.id,
            name: chunk.toolCall.name,
            args: '',
          });
        } else if (chunk.type === 'tool_call_delta' && chunk.toolCall) {
          const acc = toolCallAccumulators.get(chunk.toolCall.id);
          if (acc) acc.args += chunk.toolCall.arguments;
        } else if (chunk.type === 'tool_call_end' && chunk.toolCall) {
          const acc = toolCallAccumulators.get(chunk.toolCall.id);
          if (acc) {
            try {
              const parsedArgs = JSON.parse(acc.args);
              toolCallsThisTurn.push({ id: acc.id, name: acc.name, arguments: parsedArgs });
            } catch {
              toolCallsThisTurn.push({ id: acc.id, name: acc.name, arguments: {} });
            }
          }
        }
      }

      const assistantMsg: Message = {
        role: 'assistant',
        content: text,
        toolCalls: toolCallsThisTurn.length > 0 ? toolCallsThisTurn : undefined,
      };
      history.push(assistantMsg);
      db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, 'assistant', text, toolCallsThisTurn.length > 0 ? JSON.stringify(toolCallsThisTurn) : null, Date.now());

      if (toolCallsThisTurn.length === 0) {
        finalContent = text;
        break;
      }

      for (const tc of toolCallsThisTurn) {
        allToolCalls.push(tc);
        log.debug('Executing tool', { name: tc.name, id: tc.id });
        const toolContext: ToolContext = { sessionId, vaultPath: this.config.vaultPath };
        const result = await this.registry.execute(tc, toolContext);

        try {
          const parsed = JSON.parse(result);

          const proposeOne = (edit: Record<string, unknown>, batchId?: string) => {
            const absolutePath = edit.path as string;
            const normalizedPath = path.normalize(absolutePath);
            if (!path.isAbsolute(normalizedPath) || (normalizedPath !== this.realVaultPath && !normalizedPath.startsWith(this.realVaultPath + path.sep))) {
              log.warn('Path escapes vault boundary', { path: absolutePath, tool: tc.name });
              return null;
            }
            const meta: Record<string, unknown> = { operation: edit.operation ?? '', path: edit.path };
            if (batchId) meta.batchId = batchId;
            if (edit.reservation && typeof edit.reservation === 'object') {
              Object.assign(meta, edit.reservation);
            }
            const proposal = this.safeWriter.proposeEdit(absolutePath, edit.newContent as string, userMessage, sessionId, meta);
            const toolWarnings = Array.isArray(edit.warnings) ? (edit.warnings as string[]) : [];
            pendingEdits.push({ editId: proposal.editId, proposal, warnings: toolWarnings, batchId });
            if (edit.reservation && typeof edit.reservation === 'object') {
              const { project_id } = edit.reservation as { project_id: string };
              db.prepare('UPDATE prefix_reservations SET edit_id = ? WHERE project_id = ?').run(proposal.editId, project_id);
            }
            return proposal;
          };

          if (parsed.type === 'pending_edits' && Array.isArray(parsed.edits)) {
            const batchId = Math.random().toString(36).slice(2, 10);
            const batchEditIds: string[] = [];
            const confirmations: unknown[] = [];
            for (const edit of parsed.edits as Record<string, unknown>[]) {
              const proposal = proposeOne(edit, batchId);
              if (!proposal) {
                confirmations.push({ error: 'Path escapes vault boundary', path: edit.path });
              } else {
                batchEditIds.push(proposal.editId);
                confirmations.push({ status: 'pending_confirmation', path: edit.path, operation: edit.operation, editId: proposal.editId, hasConflict: proposal.hasConflict });
              }
            }
            if (batchEditIds.length > 1) {
              this.pendingBatches.set(batchId, batchEditIds);
            }
            const toolResult = JSON.stringify({ status: 'pending_confirmation', batchId, edits: confirmations });
            history.push({ role: 'tool', content: toolResult, toolCallId: tc.id });
            db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?)')
              .run(sessionId, 'tool', toolResult, tc.id, Date.now());
          } else if (parsed.type === 'pending_edit') {
            const absolutePath = parsed.path as string;
            const normalizedPath = path.normalize(absolutePath);
            if (!path.isAbsolute(normalizedPath) || (normalizedPath !== this.realVaultPath && !normalizedPath.startsWith(this.realVaultPath + path.sep))) {
              log.warn('Path escapes vault boundary', { path: absolutePath, tool: tc.name });
              history.push({ role: 'tool', content: JSON.stringify({ error: 'Path escapes vault boundary' }), toolCallId: tc.id });
              continue;
            }
            const meta: Record<string, unknown> = { operation: parsed.operation ?? '', path: parsed.path };
            if (parsed.reservation && typeof parsed.reservation === 'object') {
              Object.assign(meta, parsed.reservation);
            }
            if (parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)) {
              Object.assign(meta, parsed.meta);
            }
            const proposal = this.safeWriter.proposeEdit(absolutePath, parsed.newContent, userMessage, sessionId, meta);
            const toolWarnings = Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [];
            pendingEdits.push({ editId: proposal.editId, proposal, warnings: toolWarnings });
            if (parsed.reservation && typeof parsed.reservation === 'object') {
              const { project_id } = parsed.reservation as { project_id: string };
              db.prepare('UPDATE prefix_reservations SET edit_id = ? WHERE project_id = ?').run(proposal.editId, project_id);
            }
            const toolResult = JSON.stringify({
              status: 'pending_confirmation',
              path: parsed.path,
              operation: parsed.operation,
              editId: proposal.editId,
              hasConflict: proposal.hasConflict,
              ...(typeof parsed.message === 'string' && parsed.message ? { message: parsed.message } : {}),
            });
            history.push({ role: 'tool', content: toolResult, toolCallId: tc.id });
            db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?)')
              .run(sessionId, 'tool', toolResult, tc.id, Date.now());
          } else {
            history.push({ role: 'tool', content: result, toolCallId: tc.id });
            db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?)')
              .run(sessionId, 'tool', result, tc.id, Date.now());
          }
        } catch {
          history.push({ role: 'tool', content: result, toolCallId: tc.id });
          db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?)')
            .run(sessionId, 'tool', result, tc.id, Date.now());
        }
      }

      if (text) finalContent = text;
    }

    return { content: finalContent, toolCalls: allToolCalls, pendingEdits };
  }

  async processMessage(
    userMessage: string,
    sessionId: string,
    onChunk?: (text: string) => void,
  ): Promise<RuntimeResponse> {
    const db = getDatabase();

    const session = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      db.prepare('INSERT INTO chat_sessions (id, created_at, last_active, metadata) VALUES (?, ?, ?, ?)')
        .run(sessionId, Date.now(), Date.now(), JSON.stringify({ provider: this.config.llm.provider }));
    }

    const recentMessages = db.prepare(
      `SELECT role, content, tool_calls, tool_call_id FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ${HISTORY_MESSAGE_LIMIT}`
    ).all(sessionId) as Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>;

    const history: Message[] = recentMessages.reverse().map(m => ({
      role: m.role as 'user' | 'assistant' | 'tool',
      content: m.role === 'tool' ? compactToolResultForHistory(m.content) : m.content,
      toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
      toolCallId: m.tool_call_id ?? undefined,
    }));

    history.push({ role: 'user', content: userMessage });
    db.prepare('INSERT INTO chat_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(sessionId, 'user', userMessage, Date.now());

    // Route: select tool bundle from the user message, with short replies
    // interpreted against recent history.
    const selectedNames = selectToolsForMessage(userMessage, history);
    const toolDefs = this.registry.getDefinitionsByName(selectedNames);

    // When no tools are selected, buffer chunks during the first pass so we can
    // suppress the failed response if a retry is needed.
    const bufferedChunks: string[] = [];
    const bufferingOnChunk = (text: string) => { bufferedChunks.push(text); };
    const firstPassOnChunk = selectedNames.length === 0 ? bufferingOnChunk : onChunk;
    const firstCallTs = Date.now();

    let result = await this.runAgentLoop(history, toolDefs, userMessage, sessionId, firstPassOnChunk);

    if (selectedNames.length === 0 && (needsVaultAccess(result.content) || needsVaultWriteAccess(result.content))) {
      // Delete the stale assistant DB row so history replay stays clean.
      db.prepare(
        'DELETE FROM chat_messages WHERE rowid = (SELECT rowid FROM chat_messages WHERE session_id = ? AND role = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1)'
      ).run(sessionId, 'assistant', firstCallTs);
      if (history[history.length - 1].role === 'assistant') history.pop();

      const retryBundle = needsVaultWriteAccess(result.content) ? FULL_WRITE_BUNDLE : SEARCH_BUNDLE;
      const retryDefs = this.registry.getDefinitionsByName([...retryBundle]);
      result = await this.runAgentLoop(history, retryDefs, userMessage, sessionId, onChunk);
    } else if (selectedNames.length === 0) {
      // No retry needed — replay buffered chunks so the caller receives streaming output.
      for (const chunk of bufferedChunks) onChunk?.(chunk);
    }

    db.prepare('UPDATE chat_sessions SET last_active = ? WHERE id = ?').run(Date.now(), sessionId);

    return result;
  }

  async confirmEdit(editId: string, action: 'apply' | 'force' | 'cancel', sessionId: string): Promise<{ success: boolean; message: string }> {
    const db = getDatabase();
    db.prepare('DELETE FROM prefix_reservations WHERE expires_at < ?').run(Date.now());

    // Fetch meta BEFORE confirmEdit deletes the pending entry
    const editMeta = this.safeWriter.getPendingEditMeta(editId) ?? {};
    const batchId = typeof editMeta.batchId === 'string' ? editMeta.batchId : null;

    // Preflight: for apply/force, verify conflict-eligibility of ALL batch members before writing any
    if (batchId && action !== 'cancel') {
      const batchMates = (this.pendingBatches.get(batchId) ?? []).filter(id => id !== editId);
      const allIds = [editId, ...batchMates];
      for (const id of allIds) {
        const pre = this.safeWriter.preflightEdit(id, action);
        if (!pre.ok) {
          for (const cancelId of allIds) {
            const cancelMeta = this.safeWriter.getPendingEditMeta(cancelId) ?? {};
            this.safeWriter.confirmEdit(cancelId, 'cancel');
            db.prepare('DELETE FROM prefix_reservations WHERE edit_id = ?').run(cancelId);
            db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)')
              .run(sessionId, 'edit_cancelled', JSON.stringify({ editId: cancelId, action: 'cancel', success: true, reason: pre.error, ...cancelMeta }), Date.now());
          }
          this.pendingBatches.delete(batchId);
          return { success: false, message: `Batch cancelled: ${pre.error}` };
        }
      }
    }

    const result = this.safeWriter.confirmEdit(editId, action);

    if (action === 'cancel') {
      db.prepare('DELETE FROM prefix_reservations WHERE edit_id = ?').run(editId);
    }
    const eventType = (action === 'cancel' || !result.success) ? 'edit_cancelled' : 'edit_confirmed';
    db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)')
      .run(sessionId, eventType, JSON.stringify({ editId, action, success: result.success, ...editMeta }), Date.now());

    if (result.success && action !== 'cancel') {
      this.writeChangelogEntry(editMeta);
    }

    // Propagate action to all other edits in the same batch atomically.
    // If the primary failed, cancel mates rather than attempting to apply them.
    if (batchId) {
      const batchMates = (this.pendingBatches.get(batchId) ?? []).filter(id => id !== editId);
      const propagateAction = (action === 'cancel' || !result.success) ? 'cancel' : action;
      for (const mateId of batchMates) {
        const mateMeta = this.safeWriter.getPendingEditMeta(mateId) ?? {};
        const mateResult = this.safeWriter.confirmEdit(mateId, propagateAction);
        if (propagateAction === 'cancel') {
          db.prepare('DELETE FROM prefix_reservations WHERE edit_id = ?').run(mateId);
        }
        const mateEventType = (propagateAction === 'cancel' || !mateResult.success) ? 'edit_cancelled' : 'edit_confirmed';
        db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)')
          .run(sessionId, mateEventType, JSON.stringify({ editId: mateId, action: propagateAction, success: mateResult.success, ...mateMeta }), Date.now());
        if (mateResult.success && propagateAction !== 'cancel') {
          this.writeChangelogEntry(mateMeta);
        }
      }
      this.pendingBatches.delete(batchId);
    }

    return { success: result.success, message: result.error ?? (result.success ? 'Edit applied' : 'Edit failed') };
  }

  private writeChangelogEntry(editMeta: Record<string, unknown>): void {
    const editPath = typeof editMeta.path === 'string' ? editMeta.path : '';
    const operation = typeof editMeta.operation === 'string' ? editMeta.operation : 'edit';
    if (!editPath) return;
    const relPath = path.isAbsolute(editPath)
      ? path.relative(this.realVaultPath, editPath).replace(/\\/g, '/')
      : editPath;
    try {
      appendFolderChangelog({ vaultPath: this.realVaultPath, targetPath: relPath, operation, description: `${relPath} written` });
    } catch {
      // changelog write failures must not break the confirm response
    }
  }

  /**
   * Clean up pending edits for a disconnected session.
   */
  cleanupSession(sessionId: string): void {
    this.safeWriter.cleanupSession(sessionId);
  }

  getStatus(): { indexing: { state: string; total: number; indexed: number } } {
    const db = getDatabase();
    const status = db.prepare('SELECT state, total_files, indexed_files FROM indexing_status WHERE id = 1').get() as {
      state: string;
      total_files: number;
      indexed_files: number;
    } | undefined;

    return {
      indexing: {
        state: status?.state ?? 'idle',
        total: status?.total_files ?? 0,
        indexed: status?.indexed_files ?? 0,
      },
    };
  }
}

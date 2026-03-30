import path from 'node:path';
import type { CrickNoteConfig } from '../config/config.js';
import type { LLMProvider, Message, ToolCall, StreamChunk } from './providers/base.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { ToolRegistry } from './tools/registry.js';
import { createVaultTools } from './tools/vault.js';
import { createSearchTools } from './tools/search.js';
import { createTaskTools } from './tools/tasks.js';
import { createTemplateTools } from './tools/templates.js';
import { createContextTools } from './tools/context.js';
import { assembleSystemPrompt } from './context.js';
import { SafeWriter, type EditProposal, type ConfirmResult } from '../editing/safe-writer.js';
import { getDatabase } from '../storage/database.js';

interface PendingEdit {
  editId: string;
  proposal: EditProposal;
}

export interface RuntimeResponse {
  content: string;
  toolCalls: ToolCall[];
  pendingEdits: PendingEdit[];
}

export class AgentRuntime {
  private provider: LLMProvider;
  private registry: ToolRegistry;
  private safeWriter: SafeWriter;
  private config: CrickNoteConfig;

  constructor(config: CrickNoteConfig) {
    this.config = config;

    // Initialize LLM provider
    if (config.llm.provider === 'anthropic') {
      this.provider = new AnthropicProvider(config.llm.apiKey);
    } else {
      this.provider = new OpenAIProvider(config.llm.apiKey);
    }

    // Initialize safe writer
    this.safeWriter = new SafeWriter();

    // Register tools — pass conflict detector so vault_read/vault_append record snapshots
    this.registry = new ToolRegistry();
    for (const tool of createVaultTools(config.vaultPath, this.safeWriter.getConflictDetector())) {
      this.registry.register(tool);
    }
    for (const tool of createSearchTools(config.vaultPath)) {
      this.registry.register(tool);
    }
    for (const tool of createTaskTools(config.vaultPath)) {
      this.registry.register(tool);
    }
    for (const tool of createTemplateTools(config.vaultPath)) {
      this.registry.register(tool);
    }
    for (const tool of createContextTools(config.vaultPath)) {
      this.registry.register(tool);
    }
  }

  async processMessage(userMessage: string, sessionId: string): Promise<RuntimeResponse> {
    const db = getDatabase();

    // Ensure session exists
    const session = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      db.prepare('INSERT INTO chat_sessions (id, created_at, last_active, metadata) VALUES (?, ?, ?, ?)')
        .run(sessionId, Date.now(), Date.now(), JSON.stringify({ provider: this.config.llm.provider }));
    }

    // Load recent history
    const recentMessages = db.prepare(
      'SELECT role, content, tool_calls, tool_call_id FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 20'
    ).all(sessionId) as Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>;

    const history: Message[] = recentMessages.reverse().map(m => ({
      role: m.role as 'user' | 'assistant' | 'tool',
      content: m.content,
      toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
      toolCallId: m.tool_call_id ?? undefined,
    }));

    // Add user message
    history.push({ role: 'user', content: userMessage });
    db.prepare('INSERT INTO chat_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(sessionId, 'user', userMessage, Date.now());

    // Assemble system prompt
    const systemPrompt = assembleSystemPrompt(this.config.vaultPath, this.registry.getDefinitions());

    // Agent loop: call LLM, execute tools, repeat until done
    const allToolCalls: ToolCall[] = [];
    const pendingEdits: PendingEdit[] = [];
    let finalContent = '';
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;

      const chunks: StreamChunk[] = [];
      let text = '';
      const toolCallsThisTurn: ToolCall[] = [];
      const toolCallAccumulators = new Map<string, { id: string; name: string; args: string }>();

      for await (const chunk of this.provider.chat(history, this.registry.getDefinitions(), {
        systemPrompt,
        model: this.config.llm.model,
      })) {
        if (chunk.type === 'text' && chunk.text) {
          text += chunk.text;
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

      // Save assistant message
      const assistantMsg: Message = {
        role: 'assistant',
        content: text,
        toolCalls: toolCallsThisTurn.length > 0 ? toolCallsThisTurn : undefined,
      };
      history.push(assistantMsg);
      db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, 'assistant', text, toolCallsThisTurn.length > 0 ? JSON.stringify(toolCallsThisTurn) : null, Date.now());

      // If no tool calls, we're done
      if (toolCallsThisTurn.length === 0) {
        finalContent = text;
        break;
      }

      // Execute tools
      for (const tc of toolCallsThisTurn) {
        allToolCalls.push(tc);
        const result = await this.registry.execute(tc);

        // Check if result is a pending edit
        try {
          const parsed = JSON.parse(result);
          if (parsed.type === 'pending_edit') {
            // Vault tools now embed the resolved absolute path; validate it stays within the vault.
            const absolutePath = parsed.path as string;
            if (!path.isAbsolute(absolutePath) || !absolutePath.startsWith(path.resolve(this.config.vaultPath))) {
              history.push({ role: 'tool', content: JSON.stringify({ error: 'Path escapes vault boundary' }), toolCallId: tc.id });
              continue;
            }
            const proposal = this.safeWriter.proposeEdit(
              absolutePath,
              parsed.newContent,
              userMessage,
              sessionId
            );
            pendingEdits.push({ editId: proposal.editId, proposal });

            // Tell the LLM the edit is pending confirmation
            const toolResult = JSON.stringify({
              status: 'pending_confirmation',
              path: parsed.path,
              operation: parsed.operation,
              editId: proposal.editId,
              hasConflict: proposal.hasConflict,
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

      finalContent = text;
    }

    // Update session last_active
    db.prepare('UPDATE chat_sessions SET last_active = ? WHERE id = ?').run(Date.now(), sessionId);

    return { content: finalContent, toolCalls: allToolCalls, pendingEdits };
  }

  async confirmEdit(editId: string, action: 'apply' | 'force' | 'cancel'): Promise<{ success: boolean; message: string }> {
    const result = this.safeWriter.confirmEdit(editId, action);
    return { success: result.success, message: result.error ?? (result.success ? 'Edit applied' : 'Edit failed') };
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

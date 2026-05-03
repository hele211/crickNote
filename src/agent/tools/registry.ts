import type { ToolDefinition, ToolCall } from '../providers/base.js';

export interface ToolContext {
  sessionId: string;
  vaultPath: string;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, context?: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>();
  register(handler: ToolHandler): void { this.tools.set(handler.definition.name, handler); }
  getDefinitions(): ToolDefinition[] { return Array.from(this.tools.values()).map(h => h.definition); }
  getDefinitionsByName(names: string[]): ToolDefinition[] {
    const nameSet = new Set(names);
    return Array.from(this.tools.values())
      .filter(h => nameSet.has(h.definition.name))
      .map(h => h.definition);
  }
  has(name: string): boolean { return this.tools.has(name); }

  async execute(toolCall: ToolCall, context?: ToolContext): Promise<string> {
    const handler = this.tools.get(toolCall.name);
    if (!handler) return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
    try {
      return await handler.execute(toolCall.arguments, context);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : 'Tool execution failed' });
    }
  }
}

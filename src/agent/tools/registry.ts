import type { ToolDefinition, ToolCall } from '../providers/base.js';

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.tools.set(handler.definition.name, handler);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(h => h.definition);
  }

  async execute(toolCall: ToolCall): Promise<string> {
    const handler = this.tools.get(toolCall.name);
    if (!handler) {
      return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
    }

    try {
      return await handler.execute(toolCall.arguments);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : 'Tool execution failed',
      });
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

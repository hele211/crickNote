import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, Message, ToolDefinition, ChatOptions, StreamChunk, ToolCall } from './base.js';

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *chat(
    messages: Message[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): AsyncIterable<StreamChunk> {
    const anthropicMessages = messages.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [{
            type: 'tool_result' as const,
            tool_use_id: m.toolCallId!,
            content: m.content,
          }],
        };
      }

      if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }
        for (const tc of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        return { role: 'assistant' as const, content };
      }

      return {
        role: m.role as 'user' | 'assistant',
        content: m.content,
      };
    });

    const anthropicTools: Anthropic.Tool[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const stream = this.client.messages.stream({
      model: options.model ?? 'claude-sonnet-4-20250514',
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
      system: options.systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    let currentToolCall: { id: string; name: string; args: string } | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentToolCall = {
            id: event.content_block.id,
            name: event.content_block.name,
            args: '',
          };
          yield {
            type: 'tool_call_start',
            toolCall: { id: currentToolCall.id, name: currentToolCall.name, arguments: '' },
          };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        } else if (event.delta.type === 'input_json_delta' && currentToolCall) {
          currentToolCall.args += event.delta.partial_json;
          yield {
            type: 'tool_call_delta',
            toolCall: { id: currentToolCall.id, name: currentToolCall.name, arguments: event.delta.partial_json },
          };
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolCall) {
          yield {
            type: 'tool_call_end',
            toolCall: { id: currentToolCall.id, name: currentToolCall.name, arguments: currentToolCall.args },
          };
          currentToolCall = null;
        }
      } else if (event.type === 'message_stop') {
        yield { type: 'done' };
      }
    }
  }
}

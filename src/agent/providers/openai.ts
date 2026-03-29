import OpenAI from 'openai';
import type { LLMProvider, Message, ToolDefinition, ChatOptions, StreamChunk } from './base.js';

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async *chat(
    messages: Message[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): AsyncIterable<StreamChunk> {
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

    if (options.systemPrompt) {
      openaiMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const m of messages) {
      if (m.role === 'tool') {
        openaiMessages.push({
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId!,
        });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        openaiMessages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        openaiMessages.push({
          role: m.role,
          content: m.content,
        });
      }
    }

    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model: options.model ?? 'gpt-4o',
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      stream: true,
    });

    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: 'text', text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            toolCalls.set(tc.index, { id: tc.id, name: tc.function?.name ?? '', args: '' });
            yield {
              type: 'tool_call_start',
              toolCall: { id: tc.id, name: tc.function?.name ?? '', arguments: '' },
            };
          }
          if (tc.function?.arguments) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              existing.args += tc.function.arguments;
              yield {
                type: 'tool_call_delta',
                toolCall: { id: existing.id, name: existing.name, arguments: tc.function.arguments },
              };
            }
          }
        }
      }

      if (chunk.choices[0]?.finish_reason) {
        for (const [, tc] of toolCalls) {
          yield {
            type: 'tool_call_end',
            toolCall: { id: tc.id, name: tc.name, arguments: tc.args },
          };
        }
        yield { type: 'done' };
      }
    }
  }
}

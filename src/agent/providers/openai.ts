import OpenAI from 'openai';
import type { LLMProvider, Message, ToolDefinition, ChatOptions, StreamChunk } from './base.js';

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;
  private baseURL?: string;

  constructor(apiKey: string, baseURL?: string) {
    this.baseURL = baseURL;
    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  async *chat(
    messages: Message[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): AsyncIterable<StreamChunk> {
    const useNativeOllama = (() => {
      if (!this.baseURL) return false;
      const url = new URL(this.baseURL);
      return (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '11434';
    })();
    if (useNativeOllama) {
      yield* this.chatOllama(messages, tools, options);
      return;
    }

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

  private async *chatOllama(
    messages: Message[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): AsyncIterable<StreamChunk> {
    const ollamaMessages: Array<Record<string, unknown>> = [];

    if (options.systemPrompt) {
      ollamaMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const m of messages) {
      if (m.role === 'tool') {
        ollamaMessages.push({
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId,
        });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        ollamaMessages.push({
          role: 'assistant',
          content: m.content || '',
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        });
      } else {
        ollamaMessages.push({ role: m.role, content: m.content });
      }
    }

    const ollamaTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const nativeBaseURL = new URL(this.baseURL!);
    if (nativeBaseURL.pathname.endsWith('/v1')) {
      nativeBaseURL.pathname = nativeBaseURL.pathname.slice(0, -3) || '/';
    }
    const response = await fetch(new URL('/api/chat', nativeBaseURL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model ?? 'gpt-4o',
        messages: ollamaMessages,
        tools: ollamaTools.length > 0 ? ollamaTools : undefined,
        stream: true,
        think: false,
        options: {
          temperature: options.temperature ?? 0.3,
          num_predict: options.maxTokens ?? 4096,
        },
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let toolCallIndex = 0;

    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as {
          done?: boolean;
          message?: {
            content?: string;
            tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
          };
        };

        if (parsed.message?.content) {
          yield { type: 'text', text: parsed.message.content };
        }

        for (const tc of parsed.message?.tool_calls ?? []) {
          const id = `ollama-tool-${++toolCallIndex}`;
          const name = tc.function?.name ?? '';
          const args = JSON.stringify(tc.function?.arguments ?? {});
          yield { type: 'tool_call_start', toolCall: { id, name, arguments: '' } };
          yield { type: 'tool_call_delta', toolCall: { id, name, arguments: args } };
          yield { type: 'tool_call_end', toolCall: { id, name, arguments: args } };
        }

        if (parsed.done) {
          yield { type: 'done' };
        }
      }
    }
  }
}

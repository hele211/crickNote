import { describe, it, expect } from 'vitest';
import { PROVIDER_PRESETS } from '../../src/config/config.js';

describe('PROVIDER_PRESETS', () => {
  it('contains Z.AI Claude-compatible preset with correct base URL', () => {
    const preset = PROVIDER_PRESETS['zhipu-claude'];
    expect(preset).toBeDefined();
    expect(preset.provider).toBe('anthropic');
    expect(preset.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(preset.defaultModel).toBe('glm-4.5-flash');
    expect(preset.label).toContain('Zhipu');
  });

  it('contains Z.AI OpenAI-compatible preset with correct base URL', () => {
    const preset = PROVIDER_PRESETS['zhipu-openai'];
    expect(preset).toBeDefined();
    expect(preset.provider).toBe('openai');
    expect(preset.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4/');
    expect(preset.defaultModel).toBe('glm-5');
    expect(preset.label).toContain('Zhipu');
  });

  it('all presets have required fields', () => {
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.provider, `${key}.provider`).toMatch(/^(anthropic|openai)$/);
      expect(preset.baseUrl, `${key}.baseUrl`).toMatch(/^https?:\/\//);
      expect(preset.defaultModel, `${key}.defaultModel`).toBeTruthy();
      expect(preset.label, `${key}.label`).toBeTruthy();
    }
  });
});

describe('Provider constructor accepts baseURL', () => {
  it('AnthropicProvider accepts optional baseURL without throwing', async () => {
    const { AnthropicProvider } = await import('../../src/agent/providers/anthropic.js');
    // Just verifying the constructor doesn't throw — actual API call would need a real key
    expect(() => new AnthropicProvider('test-key')).not.toThrow();
    expect(() => new AnthropicProvider('test-key', 'https://open.bigmodel.cn/api/anthropic')).not.toThrow();
  });

  it('OpenAIProvider accepts optional baseURL without throwing', async () => {
    const { OpenAIProvider } = await import('../../src/agent/providers/openai.js');
    expect(() => new OpenAIProvider('test-key')).not.toThrow();
    expect(() => new OpenAIProvider('test-key', 'https://open.bigmodel.cn/api/paas/v4/')).not.toThrow();
  });
});

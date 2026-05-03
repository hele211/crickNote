import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import type { ToolHandler } from '../../src/agent/tools/registry.js';

function makeHandler(name: string): ToolHandler {
  return {
    definition: { name, description: `desc ${name}`, parameters: {} },
    execute: async () => '{}',
  };
}

describe('ToolRegistry.getDefinitionsByName', () => {
  it('returns definitions for known names in registration order', () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('vault_read'));
    reg.register(makeHandler('vault_write'));
    reg.register(makeHandler('vault_search'));

    const defs = reg.getDefinitionsByName(['vault_search', 'vault_read']);
    expect(defs.map(d => d.name)).toEqual(['vault_read', 'vault_search']);
  });

  it('silently ignores unknown names', () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('vault_read'));

    const defs = reg.getDefinitionsByName(['vault_read', 'nonexistent']);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('vault_read');
  });

  it('returns empty array for empty names list', () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('vault_read'));
    expect(reg.getDefinitionsByName([])).toEqual([]);
  });

  it('deduplicates if the same name appears twice in the input', () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('vault_read'));
    const defs = reg.getDefinitionsByName(['vault_read', 'vault_read']);
    expect(defs).toHaveLength(1);
  });
});

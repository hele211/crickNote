import { loadConfig } from '../config/config.js';
import { startService } from '../service.js';

export async function start(): Promise<void> {
  const config = loadConfig();

  console.log(`\nCrickNote agent starting...`);
  console.log(`Vault: ${config.vaultPath}`);
  console.log(`LLM: ${config.llm.provider}${config.llm.baseUrl ? ` → ${config.llm.baseUrl}` : ''} (model: ${config.llm.model ?? 'default'})`);
  console.log(`Server: ${config.server.host}:${config.server.port}`);

  await startService(config);
}

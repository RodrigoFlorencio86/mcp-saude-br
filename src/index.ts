#!/usr/bin/env node
import { loadAllData, scheduleRefreshes } from './data/loader.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  // Carregar dados (ANVISA obrigatório, CMED em background)
  await loadAllData();

  // Agendar refreshes periódicos
  scheduleRefreshes();

  // Iniciar servidor MCP via stdio
  await startServer();
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});

#!/usr/bin/env node
import { loadAllData, scheduleRefreshes } from './data/loader.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  // Sobe o transport stdio IMEDIATAMENTE — o cliente MCP (Claude Desktop)
  // espera resposta de `initialize` em poucos segundos. Carregar 60+ MB de
  // CSVs antes disso causa timeout/desconexão.
  await startServer();

  // Datasets carregam em background. Tools que dependem de cada store
  // verificam disponibilidade individualmente e respondem com mensagem
  // amigável quando o dado ainda não chegou ou quando o load falhou.
  loadAllData();
  scheduleRefreshes();
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});

import PQueue from 'p-queue';
import type { default as PQueueType } from 'p-queue';
import { CONFIG } from '../config.js';

/**
 * Fila para requisições à ANVISA (APIs oficiais, maior concorrência permitida)
 */
export const anvisaQueue: PQueueType = new PQueue({
  concurrency: CONFIG.HTTP.ANVISA_CONCURRENCY,
  intervalCap: CONFIG.HTTP.ANVISA_RATE_PER_SEC,
  interval: 1000,
});

/**
 * Fila para requisições ao consultaremedios.com.br
 * Rate limit extremamente conservador: 1 req/s, sem concorrência
 */
export const consultaRemediosQueue: PQueueType = new PQueue({
  concurrency: CONFIG.HTTP.CR_CONCURRENCY,
  intervalCap: CONFIG.HTTP.CR_RATE_PER_SEC,
  interval: 1000,
});

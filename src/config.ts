import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../data');

export const CONFIG = {
  DATA_DIR,

  ANVISA: {
    // URL correta do CSV direto (sem ZIP) — verificada em março/2026
    CSV_URL: 'https://dados.anvisa.gov.br/dados/DADOS_ABERTOS_MEDICAMENTOS.csv',
    LOCAL_CSV: path.join(DATA_DIR, 'anvisa', 'DADOS_ABERTOS_MEDICAMENTOS.csv'),
    // Tempo máximo de vida do arquivo local antes de re-baixar (7 dias em ms)
    MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    // Encoding do CSV da ANVISA
    ENCODING: 'latin1' as BufferEncoding,
  },

  CMED: {
    // ANVISA também publica tabela de preços no portal de dados abertos
    DIRECT_URL: 'https://dados.anvisa.gov.br/dados/TA_PRECOS_MEDICAMENTOS.csv',
    // Fallback: página da CMED (scraping para encontrar link mais atual)
    PAGE_URL: 'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos',
    LOCAL_FILE: path.join(DATA_DIR, 'cmed', 'TA_PRECOS_MEDICAMENTOS.csv'),
    MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000, // 30 dias
  },

  BULARIO: {
    // API não-oficial do Bulário Eletrônico ANVISA
    SEARCH_URL: 'https://consultas.anvisa.gov.br/api/consulta/bulario',
    BASE_URL: 'https://bulario.anvisa.gov.br',
    MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7 dias
  },

  CONSULTA_REMEDIOS: {
    BASE_URL: 'https://consultaremedios.com.br',
    ROBOTS_TXT_URL: 'https://consultaremedios.com.br/robots.txt',
    // Páginas que o robots.txt permite acesso
    ALLOWED_PATHS: ['/principios-ativos', '/fabricantes', '/marcas'],
    // Rate limit respeitoso: 1 req/s
    RATE_LIMIT_RPS: 1,
    USER_AGENT: 'mcp-saude-br/1.0 (educational research; dados de medicamentos brasileiros)',
    ROBOTS_CACHE_AGE_MS: 24 * 60 * 60 * 1000, // 24 horas
    CONDITIONS_CACHE_AGE_MS: 3 * 24 * 60 * 60 * 1000, // 3 dias
  },

  CACHE_TTL: {
    MEDICATIONS_LIST: 6 * 60 * 60,     // 6 horas (segundos)
    MEDICATION_DETAIL: 24 * 60 * 60,   // 24 horas
    BULA: 7 * 24 * 60 * 60,           // 7 dias
    PRICES: 24 * 60 * 60,             // 24 horas
    CONDITIONS: 3 * 24 * 60 * 60,     // 3 dias
    MANUFACTURERS: 24 * 60 * 60,      // 24 horas
    SEARCH: 30 * 60,                  // 30 minutos
  },

  HTTP: {
    TIMEOUT_MS: 30_000,
    MAX_RETRIES: 3,
    RETRY_BASE_DELAY_MS: 1_000,
    // Concorrência para ANVISA (API oficial, pode aguentar mais)
    ANVISA_CONCURRENCY: 3,
    ANVISA_RATE_PER_SEC: 10,
    // Concorrência para consultaremedios (respeitoso)
    CR_CONCURRENCY: 1,
    CR_RATE_PER_SEC: 1,
  },

  SEARCH: {
    DEFAULT_LIMIT: 10,
    MAX_LIMIT: 100,
    MIN_QUERY_LENGTH: 2,
  },

  SERVER: {
    NAME: 'mcp-saude-br',
    VERSION: '1.0.0',
  },
} as const;

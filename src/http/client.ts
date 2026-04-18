import https from 'https';
import zlib from 'zlib';
import axios from 'axios';
import type { AxiosInstance, AxiosError } from 'axios';
import { CONFIG } from '../config.js';

// Domínios do governo brasileiro com certificados ICP-Brasil (não reconhecidos pelo Node.js padrão)
const GOV_BR_DOMAINS = ['.gov.br', '.anvisa.gov.br', '.saude.gov.br'];

function isGovBrUrl(url?: string): boolean {
  if (!url) return false;
  return GOV_BR_DOMAINS.some(d => url.includes(d));
}

// Agent HTTPS que aceita certificados ICP-Brasil (apenas para sites gov.br conhecidos)
const govBrHttpsAgent = new https.Agent({ rejectUnauthorized: false });

function createAxiosInstance(): AxiosInstance {
  const instance = axios.create({
    timeout: CONFIG.HTTP.TIMEOUT_MS,
    headers: {
      'User-Agent': CONFIG.CONSULTA_REMEDIOS.USER_AGENT,
      'Accept': 'text/html,application/json,*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
  });

  // Interceptor para aplicar o agent gov.br automaticamente
  instance.interceptors.request.use((config) => {
    if (isGovBrUrl(config.url)) {
      config.httpsAgent = govBrHttpsAgent;
    }
    return config;
  });

  // Interceptor de retry com exponential backoff
  instance.interceptors.response.use(
    response => response,
    async (error: AxiosError) => {
      const config = error.config as (typeof error.config & { _retryCount?: number }) | undefined;
      if (!config) return Promise.reject(error);

      // Não fazer retry em erros do cliente (4xx), exceto 429 (Too Many Requests)
      if (error.response) {
        const status = error.response.status;
        if (status >= 400 && status < 500 && status !== 429) {
          return Promise.reject(error);
        }
      }

      config._retryCount = config._retryCount ?? 0;

      if (config._retryCount >= CONFIG.HTTP.MAX_RETRIES) {
        return Promise.reject(error);
      }

      config._retryCount += 1;
      const delay = CONFIG.HTTP.RETRY_BASE_DELAY_MS * Math.pow(2, config._retryCount - 1);

      await new Promise(resolve => setTimeout(resolve, delay));
      return instance(config);
    }
  );

  return instance;
}

export const httpClient = createAxiosInstance();

/**
 * Baixa um arquivo gzipado e retorna o conteúdo descomprimido como Buffer.
 * Usado para o cache pré-validado dos CSVs no GitHub Release.
 */
export async function downloadGzipped(url: string, timeoutMs?: number): Promise<Buffer> {
  const response = await httpClient.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs ?? CONFIG.HTTP.TIMEOUT_MS,
    // Impede o axios/Node de descomprimir baseado no Content-Encoding —
    // o GitHub serve o arquivo .gz cru, não como transport encoding.
    decompress: false,
  });
  const compressed = Buffer.from(response.data);
  return zlib.gunzipSync(compressed);
}

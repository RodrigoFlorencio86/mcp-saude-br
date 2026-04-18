import https from 'https';
import fs from 'fs';
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

/**
 * Lê e descomprime um arquivo .gz local (asset estático commitado).
 * Usado como último fallback quando release e fonte original falham.
 */
export function readGzippedFile(filePath: string): Buffer {
  return zlib.gunzipSync(fs.readFileSync(filePath));
}

export interface FetchDatasetOpts {
  /** Nome do dataset para logs (ex: "ANVISA medicamentos") */
  label: string;
  /** URL do GitHub Release (gzipado) — primeira tentativa */
  releaseUrl: string;
  /** URL canônica da fonte original (CSV cru, sem gzip) */
  sourceUrl: string;
  /**
   * Caminho do asset estático commitado no repo (gzipado).
   * Usado se release e source falharem. Garante que sempre tenha
   * dado pra mostrar (mesmo que defasado).
   */
  staticAssetPath: string;
  /** Timeout do download remoto em ms */
  timeoutMs?: number;
}

/**
 * Busca um dataset com 3 camadas de fallback:
 *   1. GitHub Release (rápido, atualizado semanalmente)
 *   2. Fonte original (ao vivo)
 *   3. Asset estático committed no repo (snapshot que vai junto no npm)
 *
 * Retorna o conteúdo CSV/ZIP cru (Buffer) e o nome da fonte usada.
 * Lança erro só se TODAS as 3 tentativas falharem.
 */
export async function fetchDataset(opts: FetchDatasetOpts): Promise<{ data: Buffer; source: 'release' | 'original' | 'static' }> {
  const { label, releaseUrl, sourceUrl, staticAssetPath, timeoutMs = 60_000 } = opts;

  try {
    console.error(`[${label}] Tentando GitHub Release: ${releaseUrl}`);
    const data = await downloadGzipped(releaseUrl, timeoutMs);
    console.error(`[${label}] ✓ Obtido via release (${(data.byteLength / 1024 / 1024).toFixed(2)} MB).`);
    return { data, source: 'release' };
  } catch (err) {
    console.error(`[${label}] Release indisponível (${(err as Error).message}).`);
  }

  try {
    console.error(`[${label}] Tentando fonte original: ${sourceUrl}`);
    const response = await httpClient.get<ArrayBuffer>(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
    });
    const data = Buffer.from(response.data);
    console.error(`[${label}] ✓ Obtido da fonte original (${(data.byteLength / 1024 / 1024).toFixed(2)} MB).`);
    return { data, source: 'original' };
  } catch (err) {
    console.error(`[${label}] Fonte original indisponível (${(err as Error).message}).`);
  }

  if (fs.existsSync(staticAssetPath)) {
    const data = readGzippedFile(staticAssetPath);
    console.error(`[${label}] ⚠ Usando snapshot estático committed no repo (${(data.byteLength / 1024 / 1024).toFixed(2)} MB). Dados podem estar defasados — atualize quando possível.`);
    return { data, source: 'static' };
  }

  throw new Error(`[${label}] Nenhuma fonte disponível: release, fonte original e asset estático falharam.`);
}

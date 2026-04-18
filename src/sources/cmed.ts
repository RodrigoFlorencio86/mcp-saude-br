import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import { CONFIG } from '../config.js';
import { httpClient, downloadGzipped } from '../http/client.js';
import { anvisaQueue } from '../http/queue.js';
import type { MedicationPrice } from '../data/types.js';
import { normalize } from '../utils/text.js';

/**
 * Retorna true se o arquivo CMED local existe e está dentro do prazo
 */
function isLocalCmedFresh(): boolean {
  try {
    const stat = fs.statSync(CONFIG.CMED.LOCAL_FILE);
    return Date.now() - stat.mtimeMs < CONFIG.CMED.MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Tenta encontrar o link de download do arquivo CMED na página da ANVISA
 * O link muda a cada publicação; fazemos scraping simples da página de preços
 */
async function findCmedDownloadUrl(): Promise<string | null> {
  try {
    const response = await anvisaQueue.add(() =>
      httpClient.get<string>(CONFIG.CMED.PAGE_URL)
    );
    if (!response) return null;
    const html = response.data;

    // Procurar links para arquivos .csv ou .xlsx com "LISTA" ou "CMED" no nome
    const matches = html.match(/href="([^"]*(?:LISTA_CONFORMIDADE|CMED|lista_cmed|conformidade)[^"]*\.(?:csv|xlsx|xls|zip))[^"]*"/gi);
    if (matches && matches.length > 0) {
      const hrefMatch = matches[0].match(/href="([^"]+)"/i);
      if (hrefMatch) {
        const url = hrefMatch[1];
        return url.startsWith('http') ? url : `https://www.gov.br${url}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Baixa a tabela de preços CMED
 * Tenta primeiro a URL direta do portal de dados abertos ANVISA;
 * caso falhe, faz scraping da página CMED para encontrar link atual
 */
async function downloadCmedFile(): Promise<void> {
  fs.mkdirSync(path.dirname(CONFIG.CMED.LOCAL_FILE), { recursive: true });

  // Tentar primeiro o cache pré-validado no GitHub Release
  try {
    console.error(`[CMED] Tentando cache do release: ${CONFIG.CMED.RELEASE_URL}`);
    const csvBuf = await downloadGzipped(CONFIG.CMED.RELEASE_URL, 60_000);
    fs.writeFileSync(CONFIG.CMED.LOCAL_FILE, csvBuf);
    const sizeMB = (csvBuf.byteLength / 1024 / 1024).toFixed(1);
    console.error(`[CMED] Tabela obtida via release (${sizeMB} MB).`);
    return;
  } catch (err) {
    console.error(`[CMED] Release indisponível (${(err as Error).message}). Caindo para fonte original...`);
  }

  // Tentar URL direta do portal de dados abertos ANVISA
  let url: string | null = CONFIG.CMED.DIRECT_URL;

  try {
    console.error(`[CMED] Tentando URL direta: ${url}`);
    const response = await anvisaQueue.add(() =>
      httpClient.get<ArrayBuffer>(url as string, { responseType: 'arraybuffer' })
    );
    if (response && response.data) {
      fs.mkdirSync(path.dirname(CONFIG.CMED.LOCAL_FILE), { recursive: true });
      fs.writeFileSync(CONFIG.CMED.LOCAL_FILE, Buffer.from(response.data));
      console.error('[CMED] Tabela de preços baixada via URL direta.');
      return;
    }
  } catch {
    console.error('[CMED] URL direta falhou. Tentando scraping da página CMED...');
  }

  // Fallback: scraping da página
  url = await findCmedDownloadUrl();
  if (!url) {
    throw new Error('Não foi possível encontrar o link de download da tabela CMED.');
  }

  console.error(`[CMED] Baixando tabela de preços: ${url}`);
  const response = await anvisaQueue.add(() =>
    httpClient.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
  );
  if (!response) throw new Error('Download CMED retornou vazio');

  fs.mkdirSync(path.dirname(CONFIG.CMED.LOCAL_FILE), { recursive: true });
  fs.writeFileSync(CONFIG.CMED.LOCAL_FILE, Buffer.from(response.data));
  console.error('[CMED] Tabela baixada com sucesso.');
}

/**
 * Parseia o CSV da CMED
 * Detecta colunas por nome (não por posição), pois o formato muda ocasionalmente
 */
async function parseCmedCsv(filePath: string): Promise<Map<string, MedicationPrice[]>> {
  const priceMap = new Map<string, MedicationPrice[]>();

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'latin1' });
    // Detectar delimitador lendo início do arquivo
    const head = fs.readFileSync(filePath, 'latin1').slice(0, 500);
    const delimiter = head.includes(';') ? ';' : ',';

    const parser = parse({
      delimiter,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,   // Tolerar aspas malformadas em CSVs do governo
      skip_records_with_error: true,
    });

    parser.on('readable', () => {
      let record: Record<string, string>;
      while ((record = parser.read() as Record<string, string>) !== null) {
        try {
          const price = parseCmedRow(record);
          if (!price.productKey) continue;

          if (!priceMap.has(price.productKey)) {
            priceMap.set(price.productKey, []);
          }
          const entry: MedicationPrice = {
            presentation: price.presentation,
            ean: price.ean,
            ggrem: price.ggrem,
            pf0: price.pf0,
            pf17: price.pf17,
            pf18: price.pf18,
            pf19: price.pf19,
            pf20: price.pf20,
            pmc17: price.pmc17,
            pmc18: price.pmc18,
            pmc19: price.pmc19,
            pmc20: price.pmc20,
            tarja: price.tarja,
          };
          priceMap.get(price.productKey)!.push(entry);
        } catch {
          // Ignorar linhas malformadas
        }
      }
    });

    parser.on('error', reject);
    parser.on('end', () => {
      console.error(`[CMED] ${priceMap.size} produtos com preço carregados.`);
      resolve(priceMap);
    });

    stream.pipe(parser);
  });
}

interface CmedParsedRow {
  productKey: string;
  presentation: string;
  ean: string;
  ggrem: string;
  pf0?: number;
  pf17?: number;
  pf18?: number;
  pf19?: number;
  pf20?: number;
  pmc17?: number;
  pmc18?: number;
  pmc19?: number;
  pmc20?: number;
  tarja?: string;
}

/**
 * Extrai campos da linha CMED de forma resiliente (por nome de coluna)
 */
function parseCmedRow(row: Record<string, string>): CmedParsedRow {
  // Helper para encontrar coluna por padrão (case-insensitive, sem acentos)
  const getCol = (...patterns: string[]): string => {
    for (const [key, val] of Object.entries(row)) {
      const k = normalize(key);
      if (patterns.some(p => k.includes(normalize(p)))) return val?.trim() ?? '';
    }
    return '';
  };

  const toNum = (s: string): number | undefined => {
    if (!s) return undefined;
    const cleaned = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return isNaN(n) ? undefined : n;
  };

  const productName = getCol('PRODUTO', 'NOME');
  const productKey = normalize(productName);
  const presentation = getCol('APRESENTACAO', 'APRESENTAÇÃO', 'APRES');
  const ean = getCol('EAN 1', 'EAN1', 'EAN');
  const ggrem = getCol('CODIGO GGREM', 'GGREM', 'CODIGO');
  const tarja = getCol('TARJA');

  return {
    productKey,
    presentation,
    ean,
    ggrem,
    pf0: toNum(getCol('PF SEM IMPOSTO', 'PF 0%', 'PF0')),
    pf17: toNum(getCol('PF 17%', 'PF17')),
    pf18: toNum(getCol('PF 18%', 'PF18')),
    pf19: toNum(getCol('PF 19%', 'PF19')),
    pf20: toNum(getCol('PF 20%', 'PF20')),
    pmc17: toNum(getCol('PMC 17%', 'PMC17')),
    pmc18: toNum(getCol('PMC 18%', 'PMC18')),
    pmc19: toNum(getCol('PMC 19%', 'PMC19')),
    pmc20: toNum(getCol('PMC 20%', 'PMC20')),
    tarja: tarja || undefined,
  };
}

/**
 * Carrega os preços CMED (baixa se necessário) e retorna o mapa
 */
export async function loadCmedPrices(): Promise<Map<string, MedicationPrice[]>> {
  if (!isLocalCmedFresh()) {
    try {
      await downloadCmedFile();
    } catch (err) {
      console.error('[CMED] Falha ao baixar:', (err as Error).message);
      // Se o arquivo antigo existir, usar mesmo desatualizado
      if (!fs.existsSync(CONFIG.CMED.LOCAL_FILE)) {
        return new Map();
      }
      console.error('[CMED] Usando versão cacheada anterior.');
    }
  } else {
    console.error('[CMED] Usando cache local de preços.');
  }

  try {
    return await parseCmedCsv(CONFIG.CMED.LOCAL_FILE);
  } catch (err) {
    console.error('[CMED] Falha ao parsear:', (err as Error).message);
    return new Map();
  }
}

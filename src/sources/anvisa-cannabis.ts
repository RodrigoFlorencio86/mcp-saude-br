import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import { CONFIG } from '../config.js';
import { fetchDataset } from '../http/client.js';
import type { CannabisProduct } from '../data/types.js';
import { normalize, parseAnvisaDate, parseRegistrationStatus } from '../utils/text.js';

export function isLocalCannabisFresh(): boolean {
  try {
    const stat = fs.statSync(CONFIG.ANVISA_CANNABIS.LOCAL_CSV);
    return Date.now() - stat.mtimeMs < CONFIG.ANVISA_CANNABIS.MAX_AGE_MS;
  } catch {
    return false;
  }
}

export async function downloadCannabisCsv(): Promise<void> {
  console.error('[Cannabis] Baixando produtos cannabis ANVISA...');
  fs.mkdirSync(path.dirname(CONFIG.ANVISA_CANNABIS.LOCAL_CSV), { recursive: true });

  const { data } = await fetchDataset({
    label: 'Cannabis',
    releaseUrl: CONFIG.ANVISA_CANNABIS.RELEASE_URL,
    sourceUrl: CONFIG.ANVISA_CANNABIS.CSV_URL,
    staticAssetPath: CONFIG.ANVISA_CANNABIS.STATIC_ASSET_PATH,
  });

  fs.writeFileSync(CONFIG.ANVISA_CANNABIS.LOCAL_CSV, data);
}

/**
 * Parseia o CSV de produtos cannabis. O arquivo NÃO tem header — colunas são
 * identificadas por posição, conforme inspeção do conteúdo em abr/2026.
 *
 * Layout posicional (separador `;`, encoding latin1):
 *   0  NU_PROCESSO
 *   2  NO_RAZAO_SOCIAL_EMPRESA
 *   3  DT_VENCIMENTO_REGISTRO (formatada DD/MM/YYYY)
 *   4  DT_VENCIMENTO_REGISTRO (MMYYYY)
 *   5  NU_CNPJ_EMPRESA
 *   6  NO_PRODUTO
 *   8  NU_REGISTRO_PRODUTO
 *   19 PRINCIPIO_ATIVO (ex: "canabidiol")
 *   20 SITUACAO_REGISTRO (ex: "Válido", "Caduco/Cancelado")
 */
export async function parseCannabisCsv(): Promise<CannabisProduct[]> {
  console.error('[Cannabis] Parseando CSV...');
  const products: CannabisProduct[] = [];

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(CONFIG.ANVISA_CANNABIS.LOCAL_CSV, {
      encoding: CONFIG.ANVISA_CANNABIS.ENCODING,
    });

    const parser = parse({
      delimiter: ';',
      columns: false,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_records_with_error: true,
    });

    parser.on('readable', () => {
      let row: string[];
      while ((row = parser.read() as string[]) !== null) {
        const product = rowToCannabisProduct(row);
        if (product) products.push(product);
      }
    });

    parser.on('error', (err) => {
      console.error('[Cannabis] Erro ao parsear CSV:', err.message);
      reject(err);
    });

    parser.on('end', () => {
      console.error(`[Cannabis] ${products.length} produtos cannabis carregados.`);
      resolve(products);
    });

    stream.pipe(parser);
  });
}

function rowToCannabisProduct(row: string[]): CannabisProduct | null {
  const processNumber = (row[0] ?? '').trim();
  const manufacturerRaw = (row[2] ?? '').trim();
  const cnpj = (row[5] ?? '').trim().replace(/\D/g, '');
  const nameRaw = (row[6] ?? '').trim();
  const registrationNumber = (row[8] ?? '').trim() || processNumber;
  const activeRaw = (row[19] ?? '').trim();
  const statusRaw = (row[20] ?? '').trim();
  const expiryRaw = (row[4] ?? row[3] ?? '').trim();

  if (!nameRaw) return null;

  return {
    processNumber,
    registrationNumber,
    nameRaw,
    name: normalize(nameRaw),
    manufacturerRaw,
    manufacturer: normalize(manufacturerRaw),
    manufacturerCnpj: cnpj,
    activeIngredientRaw: activeRaw,
    activeIngredient: normalize(activeRaw),
    registrationStatus: parseRegistrationStatus(statusRaw),
    registrationStatusRaw: statusRaw,
    registrationExpiry: parseAnvisaDate(expiryRaw),
  };
}

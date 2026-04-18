import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import { fetchDataset } from '../http/client.js';
import type { Supplement } from '../data/types.js';
import { normalize, parseAnvisaDate, parseRegistrationStatus } from '../utils/text.js';

export function isLocalAlimentosFresh(): boolean {
  try {
    const stat = fs.statSync(CONFIG.ANVISA_ALIMENTOS.LOCAL_CSV);
    return Date.now() - stat.mtimeMs < CONFIG.ANVISA_ALIMENTOS.MAX_AGE_MS;
  } catch {
    return false;
  }
}

export async function downloadAlimentosCsv(): Promise<void> {
  console.error('[Alimentos] Baixando suplementos/alimentos ANVISA...');
  fs.mkdirSync(path.dirname(CONFIG.ANVISA_ALIMENTOS.LOCAL_CSV), { recursive: true });

  const { data } = await fetchDataset({
    label: 'Alimentos',
    releaseUrl: CONFIG.ANVISA_ALIMENTOS.RELEASE_URL,
    sourceUrl: CONFIG.ANVISA_ALIMENTOS.CSV_URL,
    staticAssetPath: CONFIG.ANVISA_ALIMENTOS.STATIC_ASSET_PATH,
    timeoutMs: 120_000,
  });

  fs.writeFileSync(CONFIG.ANVISA_ALIMENTOS.LOCAL_CSV, data);
}

/**
 * Parseia o CSV de alimentos/suplementos da ANVISA.
 *
 * Por que parse manual em vez de csv-parse: o CSV tem aspas malformadas
 * (linha 148+) e campos longos com `;` literal não-escapado dentro
 * (DS_ALEGACAO_FUNCIONAL pode conter dezenas de `;`), o que faz csv-parse
 * abortar mesmo com `relax_quotes` + `skip_records_with_error`.
 *
 * Estratégia: split simples por `;`, preservando o número de colunas do
 * header. Quando uma linha tem MAIS colunas que o header (overflow do
 * campo claims), juntamos as colunas extras de volta no campo
 * DS_ALEGACAO_FUNCIONAL e mantemos a última coluna (DT_CARGA_ETL).
 * Aspas em torno dos campos são removidas no fim.
 */
export async function parseAlimentosCsv(): Promise<Supplement[]> {
  console.error('[Alimentos] Parseando CSV...');

  const text = fs.readFileSync(CONFIG.ANVISA_ALIMENTOS.LOCAL_CSV, {
    encoding: CONFIG.ANVISA_ALIMENTOS.ENCODING,
  }).replace(/^\uFEFF/, '');

  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  const expectedCols = headers.length;
  const claimsIdx = headers.findIndex(h => h === 'DS_ALEGACAO_FUNCIONAL');

  const supplements: Supplement[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;

    let cols = splitCsvLine(line);

    // Overflow: campo de alegações tem `;` literal — junta de volta no
    // claims e preserva a última coluna (DT_CARGA_ETL) na posição final.
    if (cols.length > expectedCols && claimsIdx >= 0) {
      const overflow = cols.length - expectedCols;
      const merged = cols.slice(claimsIdx, claimsIdx + 1 + overflow).join(';');
      cols = [
        ...cols.slice(0, claimsIdx),
        merged,
        ...cols.slice(claimsIdx + 1 + overflow),
      ];
    }

    if (cols.length < expectedCols - 2) continue; // linha truncada/inválida

    const row: Record<string, string> = {};
    for (let c = 0; c < expectedCols; c++) {
      row[headers[c]] = (cols[c] ?? '').trim();
    }

    const supp = rowToSupplement(row);
    if (supp) supplements.push(supp);
  }

  console.error(`[Alimentos] ${supplements.length} suplementos carregados.`);
  return supplements;
}

/**
 * Split de uma linha CSV por `;` respeitando aspas: `;` dentro de
 * `"..."` é tratado como literal (campo MARCAS frequentemente contém
 * `"MARCA1 ; MARCA2 ; MARCA3"`).
 *
 * Não tenta resolver aspas escapadas (`""` → `"`) porque o CSV da
 * ANVISA não escapa consistentemente — apenas remove as aspas externas
 * de cada campo.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ';' && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current.trim());
  return fields;
}

function rowToSupplement(row: Record<string, string>): Supplement | null {
  const nameRaw = (row.NO_PRODUTO ?? '').trim();
  if (!nameRaw) return null;

  const registrationNumber = (row.NU_REGISTRO_NOTIFICACAO_PRODUTO ?? row.NU_REGISTRO ?? row.NU_PROCESSO ?? '').trim();
  const manufacturerRaw = (row.NO_RAZAO_SOCIAL_EMPRESA ?? '').trim();
  const cnpj = (row.NU_CNPJ_EMPRESA ?? '').trim().replace(/\D/g, '');
  const statusRaw = (row.SITUACAO_REGISTRO ?? '').trim();
  const category = (row.DS_CATEGORIA_PRODUTO ?? '').trim();
  const expiryRaw = (row.DT_VENCIMENTO_REGISTRO ?? '').trim();
  const claims = (row.DS_ALEGACAO_FUNCIONAL ?? '').trim() || undefined;

  // Marcas vêm separadas por `;` ou `,` no campo MARCAS
  const marcasRaw = (row.MARCAS ?? '').trim();
  const brands = marcasRaw
    ? marcasRaw.split(/[;,]/).map(s => s.trim()).filter(s => s.length > 0)
    : [];

  return {
    registrationNumber,
    nameRaw,
    name: normalize(nameRaw),
    manufacturerRaw,
    manufacturer: normalize(manufacturerRaw),
    manufacturerCnpj: cnpj,
    brands,
    brandsNormalized: brands.map(b => normalize(b)),
    category,
    registrationStatus: parseRegistrationStatus(statusRaw),
    registrationStatusRaw: statusRaw,
    registrationExpiry: parseAnvisaDate(expiryRaw),
    functionalClaims: claims,
  };
}

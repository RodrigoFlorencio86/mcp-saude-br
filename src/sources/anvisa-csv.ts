import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import { CONFIG } from '../config.js';
import { httpClient } from '../http/client.js';
import { anvisaQueue } from '../http/queue.js';
import type { AnvisaRawRow, Medication } from '../data/types.js';
import {
  normalize,
  parseActiveIngredients,
  parseAnvisaDate,
  parseCategory,
  parseRegistrationStatus,
  parseManufacturer,
} from '../utils/text.js';

/**
 * Verifica se o arquivo local existe e é recente (dentro do MAX_AGE_MS)
 */
export function isLocalCsvFresh(): boolean {
  try {
    const stat = fs.statSync(CONFIG.ANVISA.LOCAL_CSV);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < CONFIG.ANVISA.MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Baixa o CSV direto da ANVISA (sem ZIP)
 */
export async function downloadAnvisaCsv(): Promise<void> {
  console.error('[ANVISA] Baixando base de medicamentos...');
  console.error(`[ANVISA] URL: ${CONFIG.ANVISA.CSV_URL}`);

  const csvData = await anvisaQueue.add(async () => {
    const response = await httpClient.get<ArrayBuffer>(CONFIG.ANVISA.CSV_URL, {
      responseType: 'arraybuffer',
    });
    return response.data;
  });

  if (!csvData) throw new Error('Download retornou vazio');

  // Garantir que o diretório existe
  fs.mkdirSync(path.dirname(CONFIG.ANVISA.LOCAL_CSV), { recursive: true });

  // Salvar CSV diretamente
  fs.writeFileSync(CONFIG.ANVISA.LOCAL_CSV, Buffer.from(csvData));
  const sizeMB = (Buffer.from(csvData).byteLength / 1024 / 1024).toFixed(1);
  console.error(`[ANVISA] CSV baixado com sucesso (${sizeMB} MB).`);
}

/**
 * Parseia o CSV da ANVISA e retorna array de Medication
 * Tenta delimitador ';' primeiro, depois ',' como fallback
 */
export async function parseAnvisaCsv(): Promise<Medication[]> {
  console.error('[ANVISA] Parseando CSV...');

  // Detectar delimitador lendo as primeiras linhas
  const head = fs.readFileSync(CONFIG.ANVISA.LOCAL_CSV, { encoding: 'latin1' }).slice(0, 500);
  const delimiter = head.includes(';') ? ';' : ',';
  console.error(`[ANVISA] Delimitador detectado: "${delimiter}"`);

  const medications: Medication[] = [];

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(CONFIG.ANVISA.LOCAL_CSV, {
      encoding: CONFIG.ANVISA.ENCODING,
    });

    const parser = parse({
      delimiter,
      columns: true,        // Primeira linha como cabeçalho
      skip_empty_lines: true,
      trim: true,
      bom: true,            // Remover BOM se presente
      relax_column_count: true,
    });

    parser.on('readable', () => {
      let record: AnvisaRawRow;
      while ((record = parser.read() as AnvisaRawRow) !== null) {
        const med = rowToMedication(record);
        if (med) medications.push(med);
      }
    });

    parser.on('error', (err) => {
      console.error('[ANVISA] Erro ao parsear CSV:', err.message);
      reject(err);
    });

    parser.on('end', () => {
      console.error(`[ANVISA] ${medications.length} medicamentos carregados.`);
      resolve(medications);
    });

    stream.pipe(parser);
  });
}

/**
 * Converte uma linha bruta do CSV em Medication normalizado
 * Retorna null para linhas inválidas
 */
function rowToMedication(row: AnvisaRawRow): Medication | null {
  // Campos obrigatórios
  const id = row.NUMERO_REGISTRO_PRODUTO?.trim() || row.NUMERO_REGISTRO_MEDICAMENTO?.trim();
  const nameRaw = row.NOME_PRODUTO?.trim();

  // Aceitar registros sem ID (usando nome como identificador)
  const effectiveId = id || normalize(nameRaw ?? '').replace(/\s+/g, '_').slice(0, 50);
  if (!effectiveId || !nameRaw) return null;

  // EMPRESA_DETENTORA_REGISTRO tem formato "CNPJ - NOME DO FABRICANTE"
  const empresaRaw = row.EMPRESA_DETENTORA_REGISTRO?.trim()
    ?? row.NOME_TITULAR_PRODUTO?.trim()
    ?? '';
  const { cnpj, name: manufacturerNameFromField } = parseManufacturer(empresaRaw);
  const manufacturerRaw = manufacturerNameFromField || empresaRaw;
  const activeIngredientsRaw = row.PRINCIPIO_ATIVO?.trim() ?? '';

  return {
    id: effectiveId,
    name: normalize(nameRaw),
    nameRaw,
    manufacturer: normalize(manufacturerRaw),
    manufacturerRaw,
    manufacturerCnpj: cnpj || (row.NUMERO_CNPJ_TITULAR?.trim() ?? ''),
    registrationNumber: effectiveId,
    registrationExpiry: parseAnvisaDate(row.DATA_VENCIMENTO_REGISTRO ?? ''),
    processNumber: row.NUMERO_PROCESSO?.trim(),
    category: parseCategory(row.CATEGORIA_REGULATORIA ?? ''),
    activeIngredients: parseActiveIngredients(activeIngredientsRaw),
    activeIngredientsRaw,
    registrationStatus: parseRegistrationStatus(row.SITUACAO_REGISTRO ?? ''),
    therapeuticClass: row.CLASSE_TERAPEUTICA?.trim() || undefined,
  };
}

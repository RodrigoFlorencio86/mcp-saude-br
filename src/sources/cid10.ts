import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { httpClient, downloadGzipped } from '../http/client.js';
import { CONFIG } from '../config.js';
import type { Cid10Entry } from '../data/types.js';

const LOCAL_DIR = path.join(CONFIG.DATA_DIR, 'cid10');
const LOCAL_ZIP = path.join(LOCAL_DIR, 'CID10CSV.ZIP');
const LOCAL_JSON = path.join(LOCAL_DIR, 'cid10.json');

// CID-10 muda raramente — TTL de 1 ano
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function isCid10Fresh(): boolean {
  try {
    const stat = fs.statSync(LOCAL_JSON);
    return Date.now() - stat.mtimeMs < MAX_AGE_MS;
  } catch {
    return false;
  }
}

function findEntryInZip(zip: AdmZip, nameParts: string[]): Buffer | null {
  const entries = zip.getEntries();
  for (const entry of entries) {
    const name = entry.entryName.toUpperCase();
    if (nameParts.some(p => name.includes(p.toUpperCase()))) {
      return entry.getData();
    }
  }
  return null;
}

function parseCategorias(content: string): Cid10Entry[] {
  const records = parse(content, {
    delimiter: ';',
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    skip_records_with_error: true,
  }) as Record<string, string>[];

  return records
    .filter(r => r.CATSUB && r.DESCR)
    .map(r => ({
      code: r.CATSUB.trim(),
      description: r.DESCR.trim(),
      descriptionAbbrev: r.DESCRABREV?.trim(),
      isSubcategory: false,
      excluded: r.EXCLUIDA?.trim() === '1' || r.EXCLUIDA?.trim().toLowerCase() === 's',
    }));
}

function parseSubcategorias(content: string): Cid10Entry[] {
  const records = parse(content, {
    delimiter: ';',
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    skip_records_with_error: true,
  }) as Record<string, string>[];

  return records
    .filter(r => r.SUBCAT && r.DESCR)
    .map(r => ({
      code: r.SUBCAT.trim(),
      description: r.DESCR.trim(),
      descriptionAbbrev: r.DESCRABREV?.trim(),
      isSubcategory: true,
      parentCode: r.CATEG?.trim(),
      excluded: r.EXCLUIDA?.trim() === '1' || r.EXCLUIDA?.trim().toLowerCase() === 's',
    }));
}

async function downloadAndParse(): Promise<Cid10Entry[]> {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });

  // Tenta primeiro o cache pré-validado no GitHub Release
  let downloaded = false;
  try {
    console.error(`[CID-10] Tentando cache do release: ${CONFIG.CID10.RELEASE_URL}`);
    const zipBuf = await downloadGzipped(CONFIG.CID10.RELEASE_URL, 60_000);
    fs.writeFileSync(LOCAL_ZIP, zipBuf);
    console.error(`[CID-10] ZIP obtido via release.`);
    downloaded = true;
  } catch (err) {
    console.error(`[CID-10] Release indisponível (${(err as Error).message}). Caindo para fonte original...`);
  }

  if (!downloaded) {
    const url = CONFIG.CID10.ZIP_URL;
    console.error(`[CID-10] Baixando tabela de ${url} ...`);

    const response = await httpClient.get(url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    });

    fs.writeFileSync(LOCAL_ZIP, Buffer.from(response.data as ArrayBuffer));
    console.error(`[CID-10] ZIP salvo em ${LOCAL_ZIP}`);
  }

  const zip = new AdmZip(LOCAL_ZIP);

  const categoriasBuf = findEntryInZip(zip, ['CATEGORIAS']);
  const subcatBuf = findEntryInZip(zip, ['SUBCATEGOR']);

  const entries: Cid10Entry[] = [];

  if (categoriasBuf) {
    const content = categoriasBuf.toString('latin1');
    const cats = parseCategorias(content);
    entries.push(...cats);
    console.error(`[CID-10] ${cats.length} categorias carregadas.`);
  } else {
    console.error('[CID-10] Aviso: arquivo de categorias não encontrado no ZIP.');
  }

  if (subcatBuf) {
    const content = subcatBuf.toString('latin1');
    const subcats = parseSubcategorias(content);
    entries.push(...subcats);
    console.error(`[CID-10] ${subcats.length} subcategorias carregadas.`);
  }

  // Filtra entradas excluídas
  const valid = entries.filter(e => !e.excluded);

  fs.writeFileSync(LOCAL_JSON, JSON.stringify(valid, null, 2), 'utf-8');
  console.error(`[CID-10] ${valid.length} entradas válidas salvas em cache.`);

  return valid;
}

/** Carrega tabela CID-10, usando cache local se disponível */
export async function loadCid10(): Promise<Cid10Entry[]> {
  if (isCid10Fresh()) {
    console.error('[CID-10] Carregando do cache local...');
    const json = fs.readFileSync(LOCAL_JSON, 'utf-8');
    const entries = JSON.parse(json) as Cid10Entry[];
    console.error(`[CID-10] ${entries.length} entradas carregadas do cache.`);
    return entries;
  }

  return downloadAndParse();
}

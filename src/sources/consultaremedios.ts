import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';
import { CONFIG } from '../config.js';
import { httpClient } from '../http/client.js';
import { consultaRemediosQueue } from '../http/queue.js';
import type { ConditionMedicationsMap } from '../data/types.js';
import { normalize } from '../utils/text.js';

const conditionsCache = new NodeCache({
  stdTTL: CONFIG.CACHE_TTL.CONDITIONS,
  checkperiod: 3600,
});

const CONDITIONS_FILE = path.join(CONFIG.DATA_DIR, 'anvisa', 'conditions.json');

// ──────────────────────────────────────────────────────────────
// Robots.txt compliance
// ──────────────────────────────────────────────────────────────

let robotsDisallowedPaths: string[] = [];
let robotsLastFetched = 0;

async function loadRobotsTxt(): Promise<void> {
  const AGE = Date.now() - robotsLastFetched;
  if (robotsDisallowedPaths.length > 0 && AGE < CONFIG.CONSULTA_REMEDIOS.ROBOTS_CACHE_AGE_MS) return;

  try {
    const response = await consultaRemediosQueue.add(() =>
      httpClient.get<string>(CONFIG.CONSULTA_REMEDIOS.ROBOTS_TXT_URL, { timeout: 5000 })
    );
    if (!response) return;

    robotsDisallowedPaths = [];
    for (const line of response.data.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('disallow:')) {
        const p = trimmed.split(':')[1]?.trim();
        if (p) robotsDisallowedPaths.push(p);
      }
    }
    robotsLastFetched = Date.now();
  } catch {
    // Manter lista anterior ou vazia
  }
}

function isPathAllowed(urlPath: string): boolean {
  for (const disallowed of robotsDisallowedPaths) {
    if (disallowed.includes('*')) {
      const regex = new RegExp(disallowed.replace(/\*/g, '.*').replace(/\?/g, '[?]'));
      if (regex.test(urlPath)) return false;
    } else {
      if (urlPath.startsWith(disallowed)) return false;
    }
  }
  return true;
}

// ──────────────────────────────────────────────────────────────
// Busca por condição médica
// ──────────────────────────────────────────────────────────────

/**
 * Carrega mapa de condições do cache em disco
 */
function loadConditionsFromDisk(): ConditionMedicationsMap[] {
  try {
    if (fs.existsSync(CONDITIONS_FILE)) {
      const raw = fs.readFileSync(CONDITIONS_FILE, 'utf-8');
      const data = JSON.parse(raw) as Array<ConditionMedicationsMap & { lastUpdated: string }>;
      return data.map(d => ({ ...d, lastUpdated: new Date(d.lastUpdated) }));
    }
  } catch { /* ignorar */ }
  return [];
}

/**
 * Salva mapa de condições no disco
 */
function saveConditionsToDisk(conditions: ConditionMedicationsMap[]): void {
  try {
    fs.mkdirSync(path.dirname(CONDITIONS_FILE), { recursive: true });
    fs.writeFileSync(CONDITIONS_FILE, JSON.stringify(conditions, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ConsultaRemedios] Aviso: falha ao salvar condições em disco:', err);
  }
}

/**
 * Scraping da página de uma condição específica
 * Extrai nomes de medicamentos listados na categoria
 */
async function scrapeConditionPage(url: string): Promise<string[]> {
  const urlPath = new URL(url).pathname;
  if (!isPathAllowed(urlPath)) {
    console.error(`[ConsultaRemedios] Caminho bloqueado pelo robots.txt: ${urlPath}`);
    return [];
  }

  try {
    const response = await consultaRemediosQueue.add(() =>
      httpClient.get<string>(url, { timeout: 15_000 })
    );
    if (!response) return [];

    const $ = cheerio.load(response.data);
    const names: string[] = [];

    // Seletores comuns para listas de produtos
    $('h2, h3, [data-testid*="product"], .product-name, [class*="product"], [class*="medication"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 200) names.push(text);
    });

    // Fallback: links de produto
    $('a[href*="/p"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 200) names.push(text);
    });

    return [...new Set(names)].slice(0, 100);
  } catch (err) {
    console.error(`[ConsultaRemedios] Falha ao scrapepar ${url}:`, (err as Error).message);
    return [];
  }
}

/**
 * Mapeia nome de condição para slug de URL
 * Ex: "diabetes" → "diabetes", "dor de cabeça" → "dor-de-cabeca"
 */
function conditionToSlug(condition: string): string {
  return normalize(condition).replace(/\s+/g, '-');
}

/**
 * Retorna medicamentos para uma condição médica
 * Usa lazy loading com cache em memória + disco
 */
export async function getMedicationsByCondition(
  condition: string,
  limit: number = 20
): Promise<ConditionMedicationsMap | null> {
  const cacheKey = `condition:${normalize(condition)}`;

  // Verificar cache em memória
  const cached = conditionsCache.get<ConditionMedicationsMap>(cacheKey);
  if (cached) return cached;

  // Verificar cache em disco
  const diskConditions = loadConditionsFromDisk();
  const found = diskConditions.find(c => normalize(c.condition) === normalize(condition));
  const CACHE_AGE_MS = CONFIG.CONSULTA_REMEDIOS.CONDITIONS_CACHE_AGE_MS;

  if (found && Date.now() - found.lastUpdated.getTime() < CACHE_AGE_MS) {
    conditionsCache.set(cacheKey, found);
    return found;
  }

  // Verificar robots.txt antes de fazer requisições
  await loadRobotsTxt();

  const slug = conditionToSlug(condition);
  const url = `${CONFIG.CONSULTA_REMEDIOS.BASE_URL}/${slug}/c`;

  const urlPath = `/${slug}/c`;
  if (!isPathAllowed(urlPath)) {
    return null;
  }

  const names = await scrapeConditionPage(url);

  if (names.length === 0) {
    // Tentar URL alternativa
    const altUrl = `${CONFIG.CONSULTA_REMEDIOS.BASE_URL}/medicamentos/${slug}/c`;
    const altNames = await scrapeConditionPage(altUrl);
    if (altNames.length === 0) return null;
    names.push(...altNames);
  }

  const result: ConditionMedicationsMap = {
    condition,
    conditionSlug: slug,
    conditionUrl: url,
    medicationNames: names.slice(0, limit),
    lastUpdated: new Date(),
  };

  // Salvar em cache memória e disco
  conditionsCache.set(cacheKey, result);
  const allConditions = diskConditions.filter(c => normalize(c.condition) !== normalize(condition));
  allConditions.push(result);
  saveConditionsToDisk(allConditions);

  return result;
}

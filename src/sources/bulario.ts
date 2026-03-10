import NodeCache from 'node-cache';
import { CONFIG } from '../config.js';
import { httpClient } from '../http/client.js';
import { anvisaQueue } from '../http/queue.js';
import type { BulaResult } from '../data/types.js';
import { normalize, toCacheKey } from '../utils/text.js';

const bulaCache = new NodeCache({ stdTTL: CONFIG.CACHE_TTL.BULA, checkperiod: 3600 });

interface AnvisaBulaApiItem {
  nomeProduto?: string;
  nomeEmpresa?: string;
  numRegistro?: string;
  idProduto?: number;
  idBulaPacienteProtegido?: string;
  idBulaProfissionalProtegido?: string;
  dataPublicacao?: string;
}

interface AnvisaBulaApiResponse {
  content?: AnvisaBulaApiItem[];
  totalElements?: number;
}

/**
 * Busca bula no Bulário Eletrônico ANVISA
 * Usa a API interna não-documentada do portal
 */
export async function getBula(medicationName: string): Promise<BulaResult> {
  const cacheKey = `bula:${toCacheKey(medicationName)}`;
  const cached = bulaCache.get<BulaResult>(cacheKey);
  if (cached) return cached;

  const searchUrl = `${CONFIG.BULARIO.BASE_URL}/#/bulario?nomeProduto=${encodeURIComponent(medicationName)}`;

  let result: BulaResult = {
    medicationName,
    searchUrl,
  };

  try {
    // Tentar API interna do Bulário Eletrônico
    const apiResult = await queryBularioApi(medicationName);
    if (apiResult) {
      result = { ...result, ...apiResult };
    }
  } catch (err) {
    console.error('[Bulário] API indisponível, retornando URL de busca:', (err as Error).message);
  }

  bulaCache.set(cacheKey, result);
  return result;
}

/**
 * Consulta a API interna do Bulário Eletrônico ANVISA
 */
async function queryBularioApi(medicationName: string): Promise<Partial<BulaResult> | null> {
  // A API do Bulário Eletrônico usa endpoint do portal de consultas ANVISA
  const apiUrl = `${CONFIG.BULARIO.SEARCH_URL}?`;
  const params = new URLSearchParams({
    nome: medicationName,
    count: '5',
    page: '0',
  });

  const response = await anvisaQueue.add(() =>
    httpClient.get<AnvisaBulaApiResponse>(`${apiUrl}${params}`, {
      headers: {
        'Authorization': 'Guest',
        'Accept': 'application/json',
      },
      timeout: 10_000,
    })
  );

  if (!response || !response.data?.content?.length) {
    // Tentar endpoint alternativo
    return await queryBularioApiAlt(medicationName);
  }

  const items = response.data.content;
  const normalizedQuery = normalize(medicationName);

  // Encontrar o item mais relevante
  const best = items.reduce<AnvisaBulaApiItem | null>((prev, curr) => {
    const currName = normalize(curr.nomeProduto ?? '');
    const prevName = normalize(prev?.nomeProduto ?? '');
    const currScore = currName.includes(normalizedQuery) ? 1 : 0;
    const prevScore = prevName.includes(normalizedQuery) ? 1 : 0;
    return currScore >= prevScore ? curr : prev;
  }, null);

  if (!best) return null;

  const result: Partial<BulaResult> = {
    medicationName: best.nomeProduto ?? medicationName,
    registrationNumber: best.numRegistro,
    manufacturer: best.nomeEmpresa,
    lastUpdated: best.dataPublicacao,
  };

  // Construir URLs do PDF se os IDs estiverem disponíveis
  if (best.idBulaPacienteProtegido) {
    result.bulaPacienteUrl = `https://consultas.anvisa.gov.br/api/consulta/bulario/pdf?idDocumento=${best.idBulaPacienteProtegido}`;
  }
  if (best.idBulaProfissionalProtegido) {
    result.bulaProfissionalUrl = `https://consultas.anvisa.gov.br/api/consulta/bulario/pdf?idDocumento=${best.idBulaProfissionalProtegido}`;
  }

  return result;
}

/**
 * Endpoint alternativo do Bulário Eletrônico
 */
async function queryBularioApiAlt(medicationName: string): Promise<Partial<BulaResult> | null> {
  try {
    const altUrl = `https://consultas.anvisa.gov.br/api/consulta/medicamentos/`;
    const params = new URLSearchParams({
      nome_produto: medicationName,
      situacao_registro: 'Válido',
    });

    const response = await anvisaQueue.add(() =>
      httpClient.get<{ content?: AnvisaBulaApiItem[] }>(`${altUrl}?${params}`, {
        headers: { 'Authorization': 'Guest', 'Accept': 'application/json' },
        timeout: 10_000,
      })
    );

    if (!response?.data?.content?.length) return null;
    const item = response.data.content[0];
    return { medicationName: item.nomeProduto ?? medicationName, registrationNumber: item.numRegistro };
  } catch {
    return null;
  }
}

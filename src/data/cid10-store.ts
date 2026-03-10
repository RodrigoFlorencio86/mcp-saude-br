import type { Cid10Entry } from './types.js';
import { normalize } from '../utils/text.js';

/**
 * Store em memória para a tabela CID-10.
 * Suporta busca por código exato e por descrição (nome da doença em português).
 */
export class Cid10Store {
  private entries: Cid10Entry[] = [];

  // Índice por código exato: "E11" → entry
  private byCode = new Map<string, Cid10Entry>();

  // Índice por token de descrição normalizada: "diabetes" → Set<índices>
  private byDescriptionToken = new Map<string, Set<number>>();

  private _loaded = false;

  get isLoaded(): boolean {
    return this._loaded;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Carrega entradas e constrói índices */
  load(entries: Cid10Entry[]): void {
    this.entries = entries;
    this.byCode.clear();
    this.byDescriptionToken.clear();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      this.byCode.set(entry.code.toUpperCase(), entry);

      const tokens = normalize(entry.description)
        .split(/[\s\-\/\(\),\.]+/)
        .filter(t => t.length >= 3);

      for (const token of tokens) {
        if (!this.byDescriptionToken.has(token)) {
          this.byDescriptionToken.set(token, new Set());
        }
        this.byDescriptionToken.get(token)!.add(i);
      }
    }

    this._loaded = true;
    console.error(`[CID-10 Store] ${entries.length} entradas indexadas.`);
  }

  /** Busca exata por código CID-10 (ex: "E11", "E11.0") */
  getByCode(code: string): Cid10Entry | undefined {
    return this.byCode.get(code.trim().toUpperCase());
  }

  /**
   * Busca por código ou nome de doença.
   * - Se query parece um código (letra + dígitos), tenta lookup direto e prefixo
   * - Caso contrário, busca por tokens na descrição
   */
  search(query: string, limit: number = 20): Cid10Entry[] {
    const trimmed = query.trim();
    const upper = trimmed.toUpperCase();

    // Detecta se parece código CID: começa com letra seguida de dígitos (A00, E11, etc.)
    const isCode = /^[A-Z]\d/.test(upper);

    if (isCode) {
      // Busca exata primeiro
      const exact = this.byCode.get(upper);
      if (exact) return [exact];

      // Busca por prefixo: "E1" → E10, E11, E12...
      const results: Cid10Entry[] = [];
      for (const [code, entry] of this.byCode) {
        if (code.startsWith(upper)) results.push(entry);
        if (results.length >= limit) break;
      }
      return results;
    }

    // Busca textual por tokens da descrição
    const normalizedQuery = normalize(trimmed);
    const queryTokens = normalizedQuery
      .split(/[\s\-\/\(\),\.]+/)
      .filter(t => t.length >= 3);

    if (queryTokens.length === 0) return [];

    const scores = new Map<number, number>();

    for (const token of queryTokens) {
      // Busca exata no índice
      const exact = this.byDescriptionToken.get(token);
      if (exact) {
        for (const idx of exact) scores.set(idx, (scores.get(idx) ?? 0) + 3);
      }

      // Busca por prefixo/substring
      for (const [key, idxSet] of this.byDescriptionToken) {
        if (key !== token) {
          if (key.startsWith(token)) {
            for (const idx of idxSet) scores.set(idx, (scores.get(idx) ?? 0) + 2);
          } else if (key.includes(token)) {
            for (const idx of idxSet) scores.set(idx, (scores.get(idx) ?? 0) + 1);
          }
        }
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      // Priorizar categorias sobre subcategorias quando score igual
      .sort((a, b) => {
        const scoreDiff = b[1] - a[1];
        if (scoreDiff !== 0) return scoreDiff;
        const aIsSubcat = this.entries[a[0]].isSubcategory ? 1 : 0;
        const bIsSubcat = this.entries[b[0]].isSubcategory ? 1 : 0;
        return aIsSubcat - bIsSubcat;
      })
      .map(([idx]) => this.entries[idx]);
  }

  /**
   * Retorna keywords extraídas de um CID para usar na busca de medicamentos.
   * Ex: "Diabetes mellitus não-insulino-dependente" → ["diabetes", "mellitus"]
   */
  getSearchKeywordsForEntry(entry: Cid10Entry): string[] {
    // Palavras a ignorar (stopwords médicas irrelevantes para busca de medicamentos)
    const STOPWORDS = new Set([
      'nao', 'sem', 'com', 'por', 'sob', 'tipo', 'outra', 'outras', 'outro',
      'outros', 'especificada', 'especificado', 'especificadas', 'especificados',
      'naospecificada', 'naoespecificado', 'multipla', 'multiplas', 'aguda',
      'agudo', 'cronica', 'cronico', 'nao', 'dependente', 'dependencia',
      'insulino', 'mellitus', // muito genérico — melhor usar "diabetes" sozinho
    ]);

    return normalize(entry.description)
      .split(/[\s\-\/\(\),\.;]+/)
      .filter(t => t.length >= 4 && !STOPWORDS.has(t))
      .slice(0, 5); // máx 5 palavras-chave para não poluir busca
  }

  /** Retorna todas as categorias (não subcategorias) */
  getCategories(): Cid10Entry[] {
    return this.entries.filter(e => !e.isSubcategory);
  }

  /** Retorna subcategorias de uma categoria pai */
  getSubcategories(parentCode: string): Cid10Entry[] {
    const upper = parentCode.toUpperCase();
    return this.entries.filter(e => e.isSubcategory && e.parentCode?.toUpperCase() === upper);
  }
}

// Singleton global
export const cid10Store = new Cid10Store();

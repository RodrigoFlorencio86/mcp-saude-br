import type { Supplement } from './types.js';
import { normalize } from '../utils/text.js';

/**
 * Store em memória de suplementos alimentares ANVISA (~58k registros).
 * Indexação análoga ao MedicationStore: tokens por nome/marca/fabricante,
 * lookup O(1) por número de registro.
 */
export class SupplementsStore {
  private supplements: Supplement[] = [];

  private byName = new Map<string, Set<number>>();
  private byBrand = new Map<string, Set<number>>();
  private byManufacturer = new Map<string, Set<number>>();
  private byRegistration = new Map<string, number>();
  private byCategory = new Map<string, Set<number>>();

  private _loaded = false;

  get isLoaded(): boolean {
    return this._loaded;
  }

  get size(): number {
    return this.supplements.length;
  }

  load(supplements: Supplement[]): void {
    this.supplements = supplements;
    this.byName.clear();
    this.byBrand.clear();
    this.byManufacturer.clear();
    this.byRegistration.clear();
    this.byCategory.clear();

    for (let i = 0; i < supplements.length; i++) {
      const s = supplements[i];

      const tokens = s.name.split(/\s+/).filter(t => t.length >= 2);
      for (const tok of tokens) {
        if (!this.byName.has(tok)) this.byName.set(tok, new Set());
        this.byName.get(tok)!.add(i);
      }
      if (!this.byName.has(s.name)) this.byName.set(s.name, new Set());
      this.byName.get(s.name)!.add(i);

      for (const brand of s.brandsNormalized) {
        if (!brand) continue;
        if (!this.byBrand.has(brand)) this.byBrand.set(brand, new Set());
        this.byBrand.get(brand)!.add(i);

        const brandTokens = brand.split(/\s+/).filter(t => t.length >= 2);
        for (const tok of brandTokens) {
          if (!this.byBrand.has(tok)) this.byBrand.set(tok, new Set());
          this.byBrand.get(tok)!.add(i);
        }
      }

      if (s.manufacturer) {
        if (!this.byManufacturer.has(s.manufacturer)) this.byManufacturer.set(s.manufacturer, new Set());
        this.byManufacturer.get(s.manufacturer)!.add(i);
      }

      if (s.registrationNumber) {
        this.byRegistration.set(s.registrationNumber, i);
      }

      if (s.category) {
        const cat = normalize(s.category);
        if (!this.byCategory.has(cat)) this.byCategory.set(cat, new Set());
        this.byCategory.get(cat)!.add(i);
      }
    }

    this._loaded = true;
    console.error(`[Supplements Store] ${supplements.length} suplementos indexados.`);
  }

  /**
   * Busca por nome do produto, marca ou fabricante.
   */
  search(query: string, limit: number = 20): Supplement[] {
    const q = normalize(query);
    const tokens = q.split(/\s+/).filter(t => t.length >= 2);
    const scores = new Map<number, number>();
    const bump = (idx: number, n: number) => scores.set(idx, (scores.get(idx) ?? 0) + n);

    // Match exato no nome completo
    const exactName = this.byName.get(q);
    if (exactName) for (const idx of exactName) bump(idx, 10);

    // Match exato em marca (alta relevância — usuário busca por marca conhecida)
    const exactBrand = this.byBrand.get(q);
    if (exactBrand) for (const idx of exactBrand) bump(idx, 8);

    // Tokens
    for (const tok of tokens) {
      const nameMatches = this.byName.get(tok);
      if (nameMatches) for (const idx of nameMatches) bump(idx, 3);

      const brandMatches = this.byBrand.get(tok);
      if (brandMatches) for (const idx of brandMatches) bump(idx, 3);

      // Prefixo em marcas (whey → whey protein, wheyfit, etc)
      for (const [key, idxSet] of this.byBrand) {
        if (key !== tok && key.startsWith(tok)) {
          for (const idx of idxSet) bump(idx, 2);
        }
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([idx]) => this.supplements[idx]);
  }

  getByRegistration(reg: string): Supplement | undefined {
    const idx = this.byRegistration.get(reg.trim());
    return idx !== undefined ? this.supplements[idx] : undefined;
  }

  getByManufacturer(name: string, limit: number = 50): Supplement[] {
    const q = normalize(name);
    const seen = new Set<number>();
    const matches: Supplement[] = [];

    const exact = this.byManufacturer.get(q);
    if (exact) for (const idx of exact) {
      if (!seen.has(idx)) { seen.add(idx); matches.push(this.supplements[idx]); }
    }

    for (const [key, idxSet] of this.byManufacturer) {
      if (matches.length >= limit) break;
      if (key === q) continue;
      if (key.includes(q) || q.includes(key)) {
        for (const idx of idxSet) {
          if (!seen.has(idx)) { seen.add(idx); matches.push(this.supplements[idx]); }
        }
      }
    }

    return matches.slice(0, limit);
  }

  /**
   * Lista fabricantes com contagem. Como são muitos (milhares),
   * suporta paginação via limit/offset e filtro por substring.
   */
  listManufacturers(filter?: string, limit: number = 50, activeOnly: boolean = false):
    Array<{ name: string; nameRaw: string; productCount: number; activeCount: number }> {
    const filterNorm = filter ? normalize(filter) : '';
    const result: Array<{ name: string; nameRaw: string; productCount: number; activeCount: number }> = [];

    for (const [name, idxSet] of this.byManufacturer) {
      if (filterNorm && !name.includes(filterNorm)) continue;
      const items = Array.from(idxSet).map(idx => this.supplements[idx]);
      const activeCount = items.filter(s => s.registrationStatus === 'VALIDO').length;
      if (activeOnly && activeCount === 0) continue;
      result.push({
        name,
        nameRaw: items[0]?.manufacturerRaw ?? name,
        productCount: items.length,
        activeCount,
      });
    }

    return result
      .sort((a, b) => b.productCount - a.productCount)
      .slice(0, limit);
  }

  listCategories(): Array<{ category: string; productCount: number }> {
    const result: Array<{ category: string; productCount: number }> = [];
    for (const [cat, idxSet] of this.byCategory) {
      const items = Array.from(idxSet).map(idx => this.supplements[idx]);
      result.push({ category: items[0]?.category ?? cat, productCount: idxSet.size });
    }
    return result.sort((a, b) => b.productCount - a.productCount);
  }
}

export const supplementsStore = new SupplementsStore();

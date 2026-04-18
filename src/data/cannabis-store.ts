import type { CannabisProduct } from './types.js';
import { normalize } from '../utils/text.js';

/**
 * Store em memória de produtos cannabis. Volume baixo (~60 produtos) — busca
 * linear é trivialmente rápida, mas mantemos índices para consistência com os
 * outros stores e para suportar `getByManufacturer` em O(1).
 */
export class CannabisStore {
  private products: CannabisProduct[] = [];

  private byName = new Map<string, Set<number>>();
  private byManufacturer = new Map<string, Set<number>>();
  private byActiveIngredient = new Map<string, Set<number>>();
  private byRegistration = new Map<string, number>();

  private _loaded = false;

  get isLoaded(): boolean {
    return this._loaded;
  }

  get size(): number {
    return this.products.length;
  }

  load(products: CannabisProduct[]): void {
    this.products = products;
    this.byName.clear();
    this.byManufacturer.clear();
    this.byActiveIngredient.clear();
    this.byRegistration.clear();

    for (let i = 0; i < products.length; i++) {
      const p = products[i];

      const tokens = p.name.split(/\s+/).filter(t => t.length >= 2);
      for (const tok of tokens) {
        if (!this.byName.has(tok)) this.byName.set(tok, new Set());
        this.byName.get(tok)!.add(i);
      }
      if (!this.byName.has(p.name)) this.byName.set(p.name, new Set());
      this.byName.get(p.name)!.add(i);

      if (p.manufacturer) {
        if (!this.byManufacturer.has(p.manufacturer)) this.byManufacturer.set(p.manufacturer, new Set());
        this.byManufacturer.get(p.manufacturer)!.add(i);
      }

      if (p.activeIngredient) {
        if (!this.byActiveIngredient.has(p.activeIngredient)) this.byActiveIngredient.set(p.activeIngredient, new Set());
        this.byActiveIngredient.get(p.activeIngredient)!.add(i);
      }

      if (p.registrationNumber) {
        this.byRegistration.set(p.registrationNumber, i);
      }
    }

    this._loaded = true;
    console.error(`[Cannabis Store] ${products.length} produtos indexados.`);
  }

  /**
   * Busca livre por nome / fabricante / princípio ativo.
   * Volume baixo permite scan + scoring sem estouro.
   */
  search(query: string | undefined, limit: number = 50): CannabisProduct[] {
    if (!query || !query.trim()) return this.products.slice(0, limit);

    const q = normalize(query);
    const tokens = q.split(/\s+/).filter(t => t.length >= 2);
    const scores = new Map<number, number>();

    const bump = (idx: number, n: number) => scores.set(idx, (scores.get(idx) ?? 0) + n);

    for (let i = 0; i < this.products.length; i++) {
      const p = this.products[i];
      if (p.name === q) bump(i, 10);
      else if (p.name.includes(q)) bump(i, 5);
      if (p.manufacturer.includes(q)) bump(i, 3);
      if (p.activeIngredient.includes(q)) bump(i, 4);
      for (const tok of tokens) {
        if (p.name.includes(tok)) bump(i, 2);
        if (p.manufacturer.includes(tok)) bump(i, 1);
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([idx]) => this.products[idx]);
  }

  getByRegistration(reg: string): CannabisProduct | undefined {
    const idx = this.byRegistration.get(reg.trim());
    return idx !== undefined ? this.products[idx] : undefined;
  }

  getByManufacturer(name: string, limit: number = 100): CannabisProduct[] {
    const q = normalize(name);
    const matches: CannabisProduct[] = [];
    const seen = new Set<number>();

    const exact = this.byManufacturer.get(q);
    if (exact) for (const idx of exact) {
      if (!seen.has(idx)) { seen.add(idx); matches.push(this.products[idx]); }
    }

    for (const [key, idxSet] of this.byManufacturer) {
      if (key === q) continue;
      if (key.includes(q) || q.includes(key)) {
        for (const idx of idxSet) {
          if (!seen.has(idx)) { seen.add(idx); matches.push(this.products[idx]); }
        }
      }
    }

    return matches.slice(0, limit);
  }

  /**
   * Lista fabricantes únicos com contagem total e ativa.
   * Cannabis tem poucos fabricantes — útil retornar tudo.
   */
  listManufacturers(): Array<{ name: string; nameRaw: string; productCount: number; activeCount: number }> {
    const result: Array<{ name: string; nameRaw: string; productCount: number; activeCount: number }> = [];
    for (const [name, idxSet] of this.byManufacturer) {
      const items = Array.from(idxSet).map(idx => this.products[idx]);
      const activeCount = items.filter(p => p.registrationStatus === 'VALIDO').length;
      result.push({
        name,
        nameRaw: items[0]?.manufacturerRaw ?? name,
        productCount: items.length,
        activeCount,
      });
    }
    return result.sort((a, b) => a.nameRaw.localeCompare(b.nameRaw, 'pt-BR'));
  }
}

export const cannabisStore = new CannabisStore();

import type { Medication, MedicationPrice, StoreStats } from './types.js';
import { normalize } from '../utils/text.js';

/**
 * Store em memória com 5 índices de busca para sub-milissegundo performance
 */
export class MedicationStore {
  private medications: Medication[] = [];
  private generics: Medication[] = [];

  // Índice 1: por tokens do nome (pode mapear para múltiplos medicamentos)
  private byName = new Map<string, Set<number>>();
  // Índice 2: por número de registro (único)
  private byRegistration = new Map<string, number>();
  // Índice 3: por princípio ativo (cada ingrediente → medicamentos)
  private byActiveIngredient = new Map<string, Set<number>>();
  // Índice 4: por fabricante normalizado
  private byManufacturer = new Map<string, Set<number>>();
  // Índice 5: por classe terapêutica
  private byTherapeuticClass = new Map<string, Set<number>>();

  private _ready = false;
  private _readyPromise: Promise<void>;
  private _resolveReady!: () => void;
  private _stats: Partial<StoreStats> = {};

  constructor() {
    this._readyPromise = new Promise(resolve => {
      this._resolveReady = resolve;
    });
  }

  /** Bloqueia até o store estar pronto */
  async waitForReady(): Promise<void> {
    return this._readyPromise;
  }

  get isReady(): boolean {
    return this._ready;
  }

  /** Carrega medicamentos e reconstrói todos os índices */
  load(meds: Medication[]): void {
    this.medications = meds;

    // Reconstruir índices
    this.byName.clear();
    this.byRegistration.clear();
    this.byActiveIngredient.clear();
    this.byManufacturer.clear();
    this.byTherapeuticClass.clear();
    this.generics = [];

    for (let i = 0; i < meds.length; i++) {
      const med = meds[i];
      this.indexMedication(i, med);
    }

    this._stats = {
      totalMedications: meds.length,
      validMedications: meds.filter(m => m.registrationStatus === 'VALIDO').length,
      genericCount: this.generics.length,
      manufacturerCount: this.byManufacturer.size,
      therapeuticClassCount: this.byTherapeuticClass.size,
      activeIngredientCount: this.byActiveIngredient.size,
      lastUpdated: new Date(),
      cmedLoaded: false,
    };

    this._ready = true;
    this._resolveReady();
    console.error(`[Store] Pronto: ${meds.length} medicamentos indexados.`);
  }

  private indexMedication(idx: number, med: Medication): void {
    // Índice por nome — indexar cada token do nome
    const nameTokens = med.name.split(/\s+/).filter(t => t.length >= 2);
    for (const token of nameTokens) {
      if (!this.byName.has(token)) this.byName.set(token, new Set());
      this.byName.get(token)!.add(idx);
    }
    // Também indexar pelo nome completo normalizado
    if (!this.byName.has(med.name)) this.byName.set(med.name, new Set());
    this.byName.get(med.name)!.add(idx);

    // Índice por registro
    this.byRegistration.set(med.registrationNumber, idx);

    // Índice por princípio ativo
    for (const ingredient of med.activeIngredients) {
      if (!this.byActiveIngredient.has(ingredient)) {
        this.byActiveIngredient.set(ingredient, new Set());
      }
      this.byActiveIngredient.get(ingredient)!.add(idx);
    }

    // Índice por fabricante
    if (med.manufacturer) {
      if (!this.byManufacturer.has(med.manufacturer)) {
        this.byManufacturer.set(med.manufacturer, new Set());
      }
      this.byManufacturer.get(med.manufacturer)!.add(idx);
    }

    // Índice por classe terapêutica
    if (med.therapeuticClass) {
      const cls = normalize(med.therapeuticClass);
      if (!this.byTherapeuticClass.has(cls)) {
        this.byTherapeuticClass.set(cls, new Set());
      }
      this.byTherapeuticClass.get(cls)!.add(idx);
    }

    // Array de genéricos
    if (med.category === 'GENERICO') {
      this.generics.push(med);
    }
  }

  /** Enriquece medicamentos com dados de preço do CMED */
  loadPrices(priceMap: Map<string, MedicationPrice[]>): void {
    let enriched = 0;
    for (const med of this.medications) {
      const key = normalize(med.nameRaw);
      const prices = priceMap.get(key) ?? priceMap.get(med.registrationNumber);
      if (prices) {
        med.prices = prices;
        enriched++;
      }
    }
    if (this._stats) this._stats.cmedLoaded = true;
    console.error(`[Store] CMED: ${enriched} medicamentos enriquecidos com preços.`);
  }

  // ============================================================
  // Métodos de busca
  // ============================================================

  /**
   * Busca por nome, princípio ativo ou fabricante
   * Retorna resultados ordenados por score de relevância
   */
  search(query: string, limit: number = 10): Medication[] {
    const normalizedQuery = normalize(query);
    const tokens = normalizedQuery.split(/\s+/).filter(t => t.length >= 2);

    const scores = new Map<number, number>();

    // Busca exata por nome completo normalizado
    const exactMatches = this.byName.get(normalizedQuery);
    if (exactMatches) {
      for (const idx of exactMatches) scores.set(idx, (scores.get(idx) ?? 0) + 10);
    }

    // Busca por tokens no nome
    for (const token of tokens) {
      const matches = this.byName.get(token);
      if (matches) {
        for (const idx of matches) scores.set(idx, (scores.get(idx) ?? 0) + 3);
      }
      // Busca parcial por prefixo nos nomes indexados
      for (const [key, idxSet] of this.byName) {
        if (key !== token && key.startsWith(token)) {
          for (const idx of idxSet) scores.set(idx, (scores.get(idx) ?? 0) + 2);
        } else if (key !== token && key.includes(token)) {
          for (const idx of idxSet) scores.set(idx, (scores.get(idx) ?? 0) + 1);
        }
      }
    }

    // Busca por princípio ativo
    for (const token of tokens) {
      const matches = this.byActiveIngredient.get(token);
      if (matches) {
        for (const idx of matches) scores.set(idx, (scores.get(idx) ?? 0) + 5);
      }
      for (const [key, idxSet] of this.byActiveIngredient) {
        if (key !== token && key.startsWith(token)) {
          for (const idx of idxSet) scores.set(idx, (scores.get(idx) ?? 0) + 4);
        }
      }
    }

    // Ordenar por score e retornar
    const sorted = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([idx]) => this.medications[idx]);

    return sorted;
  }

  /** Busca por número de registro exato */
  getByRegistration(registrationNumber: string): Medication | undefined {
    const idx = this.byRegistration.get(registrationNumber.trim());
    return idx !== undefined ? this.medications[idx] : undefined;
  }

  /** Busca medicamentos por princípio ativo */
  searchByIngredient(ingredient: string, limit: number = 50): Medication[] {
    const normalized = normalize(ingredient);
    const results = new Set<number>();

    // Busca exata
    const exact = this.byActiveIngredient.get(normalized);
    if (exact) for (const idx of exact) results.add(idx);

    // Busca por prefixo
    for (const [key, idxSet] of this.byActiveIngredient) {
      if (key.startsWith(normalized) || key.includes(normalized)) {
        for (const idx of idxSet) results.add(idx);
      }
    }

    return Array.from(results)
      .slice(0, limit)
      .map(idx => this.medications[idx]);
  }

  /** Retorna medicamentos de um fabricante */
  getByManufacturer(manufacturerName: string, limit: number = 100): Medication[] {
    const normalized = normalize(manufacturerName);
    const results = new Set<number>();

    const exact = this.byManufacturer.get(normalized);
    if (exact) for (const idx of exact) results.add(idx);

    // Busca parcial
    for (const [key, idxSet] of this.byManufacturer) {
      if (key !== normalized && (key.includes(normalized) || normalized.includes(key))) {
        for (const idx of idxSet) results.add(idx);
      }
    }

    return Array.from(results)
      .slice(0, limit)
      .map(idx => this.medications[idx]);
  }

  /** Lista todos os fabricantes com contagem */
  listManufacturers(activeOnly: boolean = false): Array<{ name: string; nameRaw: string; medicationCount: number; activeCount: number }> {
    const result: Array<{ name: string; nameRaw: string; medicationCount: number; activeCount: number }> = [];

    for (const [name, idxSet] of this.byManufacturer) {
      const meds = Array.from(idxSet).map(idx => this.medications[idx]);
      const activeCount = meds.filter(m => m.registrationStatus === 'VALIDO').length;
      if (activeOnly && activeCount === 0) continue;
      const nameRaw = meds[0]?.manufacturerRaw ?? name;
      result.push({ name, nameRaw, medicationCount: meds.length, activeCount });
    }

    return result.sort((a, b) => a.nameRaw.localeCompare(b.nameRaw, 'pt-BR'));
  }

  /** Retorna genéricos, opcionalmente filtrados por princípio ativo */
  listGenerics(activeIngredient?: string, limit: number = 50): Medication[] {
    if (!activeIngredient) return this.generics.slice(0, limit);

    const normalized = normalize(activeIngredient);
    return this.generics
      .filter(m => m.activeIngredients.some(ing => ing.includes(normalized)))
      .slice(0, limit);
  }

  /** Lista classes terapêuticas com contagem */
  listTherapeuticClasses(): Array<{ code: string; medicationCount: number }> {
    const result: Array<{ code: string; medicationCount: number }> = [];
    for (const [code, idxSet] of this.byTherapeuticClass) {
      result.push({ code, medicationCount: idxSet.size });
    }
    return result.sort((a, b) => b.medicationCount - a.medicationCount);
  }

  /** Retorna medicamentos de uma classe terapêutica */
  getByTherapeuticClass(cls: string, limit: number = 50): Medication[] {
    const normalized = normalize(cls);
    const idxSet = this.byTherapeuticClass.get(normalized);
    if (!idxSet) return [];
    return Array.from(idxSet).slice(0, limit).map(idx => this.medications[idx]);
  }

  /** Estatísticas do store */
  getStats(): StoreStats {
    return {
      totalMedications: this._stats.totalMedications ?? 0,
      validMedications: this._stats.validMedications ?? 0,
      genericCount: this._stats.genericCount ?? 0,
      manufacturerCount: this._stats.manufacturerCount ?? 0,
      therapeuticClassCount: this._stats.therapeuticClassCount ?? 0,
      activeIngredientCount: this._stats.activeIngredientCount ?? 0,
      lastUpdated: this._stats.lastUpdated,
      cmedLoaded: this._stats.cmedLoaded ?? false,
    };
  }
}

// Instância global do store (singleton)
export const medicationStore = new MedicationStore();

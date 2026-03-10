/**
 * Utilitários de normalização de texto para PT-BR
 * Essencial para qualidade da busca em nomes de medicamentos brasileiros
 */

/**
 * Remove acentos e normaliza string para busca
 * Ex: "Atenção" → "atencao", "Ácido Fólico" → "acido folico"
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove combining diacritical marks
    .toLowerCase()
    .trim();
}

/**
 * Tokeniza texto normalizado em palavras individuais
 * Remove tokens muito curtos (< 2 chars) que não ajudam na busca
 */
export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[\s\+\-\/\(\)\,\.]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

/**
 * Cria chave de cache normalizada para um nome de medicamento
 */
export function toCacheKey(text: string): string {
  return normalize(text).replace(/\s+/g, '_');
}

/**
 * Verifica se um texto de query corresponde (parcialmente) a um texto alvo
 * Retorna score: 3 = exato, 2 = começa com, 1 = contém, 0 = não encontrado
 */
export function matchScore(query: string, target: string): number {
  const q = normalize(query);
  const t = normalize(target);
  if (t === q) return 3;
  if (t.startsWith(q)) return 2;
  if (t.includes(q)) return 1;
  return 0;
}

/**
 * Parseia a string de princípios ativos do CSV da ANVISA
 * Suporta separadores: vírgula, "+", ";"
 * Ex: "PARACETAMOL, CLORFENIRAMINA" → ["paracetamol", "clorfeniramina"]
 * Ex: "AMOXICILINA + ÁCIDO CLAVULÂNICO" → ["amoxicilina", "acido clavulanico"]
 */
export function parseActiveIngredients(raw: string): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(/[,\+;]/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => normalize(s));
}

/**
 * Parseia data em vários formatos ANVISA:
 * - DD/MM/YYYY (ex: "15/01/2003")
 * - MMYYYY (ex: "102014" = Outubro/2014)
 * - MM/YYYY
 * Retorna undefined se inválida
 */
export function parseAnvisaDate(raw: string): Date | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const s = raw.trim();

  // Formato DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [day, month, year] = s.split('/').map(Number);
    const date = new Date(year, month - 1, day);
    return isNaN(date.getTime()) ? undefined : date;
  }

  // Formato MM/YYYY
  if (/^\d{2}\/\d{4}$/.test(s)) {
    const [month, year] = s.split('/').map(Number);
    const date = new Date(year, month - 1, 1);
    return isNaN(date.getTime()) ? undefined : date;
  }

  // Formato MMYYYY (6 dígitos) — ex: "102014" = Outubro/2014
  if (/^\d{6}$/.test(s)) {
    const month = parseInt(s.slice(0, 2), 10);
    const year = parseInt(s.slice(2), 10);
    if (month >= 1 && month <= 12 && year >= 1990 && year <= 2099) {
      return new Date(year, month - 1, 1);
    }
  }

  return undefined;
}

/**
 * Parseia o campo EMPRESA_DETENTORA_REGISTRO do CSV ANVISA
 * Formato: "CNPJ - NOME DO FABRICANTE"
 * Ex: "61186136000122 - VALEANT FARMACÊUTICA DO BRASIL LTDA" → { cnpj: "61186136000122", name: "VALEANT..." }
 */
export function parseManufacturer(raw: string): { cnpj: string; name: string } {
  if (!raw || !raw.trim()) return { cnpj: '', name: '' };
  const dashIdx = raw.indexOf(' - ');
  if (dashIdx === -1) return { cnpj: '', name: raw.trim() };
  const cnpj = raw.slice(0, dashIdx).trim().replace(/\D/g, ''); // apenas dígitos
  const name = raw.slice(dashIdx + 3).trim();
  return { cnpj, name };
}

/**
 * Mapeia string de categoria regulatória ANVISA para enum
 */
export function parseCategory(raw: string): import('../data/types.js').MedicationCategory {
  const normalized = normalize(raw ?? '');
  if (normalized.includes('generico') || normalized === 'g') return 'GENERICO';
  if (normalized.includes('similar') || normalized === 's') return 'SIMILAR';
  if (normalized.includes('referencia') || normalized === 'r' || normalized.includes('novo')) return 'REFERENCIA';
  if (normalized.includes('biologico') || normalized === 'b') return 'BIOLOGICO';
  if (normalized.includes('fitoterapico') || normalized === 'f') return 'FITOTERAPICO';
  if (normalized.includes('dinamizado') || normalized === 'd') return 'DINAMIZADO';
  if (normalized.includes('radiofarmaco')) return 'RADIOFARMACO';
  return 'OTHER';
}

/**
 * Mapeia string de situação de registro para enum
 * Suporta variações: "Ativo"/"Inativo" (CSV atual), "Válido"/"Vencido" (outros formatos)
 */
export function parseRegistrationStatus(raw: string): import('../data/types.js').RegistrationStatus {
  const normalized = normalize(raw ?? '');
  if (normalized === 'ativo' || normalized.includes('valid')) return 'VALIDO';
  if (normalized === 'inativo' || normalized.includes('vencid') || normalized.includes('inativo')) return 'VENCIDO';
  if (normalized.includes('cancel')) return 'CANCELADO';
  return 'OUTROS';
}

/**
 * Trunca texto para exibição, respeitando palavras
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3).replace(/\s+\S*$/, '') + '...';
}

/**
 * Formata data para exibição no padrão brasileiro
 */
export function formatDateBR(date: Date | undefined): string {
  if (!date) return 'N/D';
  return date.toLocaleDateString('pt-BR');
}

/**
 * Formata valor monetário em reais
 */
export function formatBRL(value: number | undefined): string {
  if (value === undefined || value === null) return 'N/D';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ============================================================
// Tipos centrais do MCP Server de Saúde Brasileiro
// ============================================================

/** Categorias regulatórias de medicamentos conforme ANVISA */
export type MedicationCategory =
  | 'GENERICO'
  | 'SIMILAR'
  | 'REFERENCIA'
  | 'BIOLOGICO'
  | 'FITOTERAPICO'
  | 'DINAMIZADO'
  | 'RADIOFARMACO'
  | 'OTHER';

/** Status de registro ANVISA */
export type RegistrationStatus = 'VALIDO' | 'VENCIDO' | 'CANCELADO' | 'OUTROS';

/** Preço de um medicamento conforme tabela CMED */
export interface MedicationPrice {
  state?: string;       // Sigla do estado (SP, RJ...) ou undefined para preço nacional
  presentation: string; // Ex: "comprimido 500mg caixa com 30"
  ean?: string;
  ggrem?: string;       // Código GGREM (identificador CMED)
  pf0?: number;         // Preço de Fábrica sem impostos
  pf17?: number;
  pf18?: number;
  pf19?: number;
  pf20?: number;
  pmc17?: number;       // Preço Máximo ao Consumidor
  pmc18?: number;
  pmc19?: number;
  pmc20?: number;
  tarja?: string;       // "VERMELHO", "PRETO", "AMARELO", "SEM TARJA"
  regiaoPreco?: string;
}

/** Representação interna de um medicamento (oriundo do CSV ANVISA) */
export interface Medication {
  /** NUMERO_REGISTRO_PRODUTO — identificador único */
  id: string;
  /** Nome normalizado para busca (sem acentos, lowercase) */
  name: string;
  /** Nome original como consta no CSV */
  nameRaw: string;
  /** Nome do titular/fabricante normalizado */
  manufacturer: string;
  /** Nome do titular como consta no CSV */
  manufacturerRaw: string;
  /** CNPJ do titular */
  manufacturerCnpj: string;
  /** Número de registro (ex: 1.0002.0001.001-9) */
  registrationNumber: string;
  /** Data de vencimento do registro */
  registrationExpiry?: Date;
  /** Número do processo administrativo */
  processNumber?: string;
  /** Categoria regulatória */
  category: MedicationCategory;
  /** Princípios ativos normalizados (split em "+") */
  activeIngredients: string[];
  /** Princípios ativos originais */
  activeIngredientsRaw: string;
  /** Situação do registro */
  registrationStatus: RegistrationStatus;
  /** Classe terapêutica (quando disponível no CSV) */
  therapeuticClass?: string;
  /** Preços CMED (enriquecidos após carregamento do CMED) */
  prices?: MedicationPrice[];
}

/** Linha bruta do CSV ANVISA (nomes de colunas do arquivo original) */
export interface AnvisaRawRow {
  EXPEDIENTE?: string;
  TIPO?: string;
  TIPO_PRODUTO?: string;
  NUMERO_REGISTRO_PRODUTO?: string;
  NOME_PRODUTO?: string;
  ID_TITULAR_PRODUTO?: string;
  NOME_TITULAR_PRODUTO?: string;
  /** Formato no CSV atual: "CNPJ - NOME DO FABRICANTE" */
  EMPRESA_DETENTORA_REGISTRO?: string;
  NUMERO_CNPJ_TITULAR?: string;
  DATA_VENCIMENTO_REGISTRO?: string;
  DATA_FINALIZACAO_PROCESSO?: string;
  NUMERO_PROCESSO?: string;
  CATEGORIA_REGULATORIA?: string;
  NUMERO_REGISTRO_MEDICAMENTO?: string;
  PRINCIPIO_ATIVO?: string;
  SITUACAO_REGISTRO?: string;
  CLASSE_TERAPEUTICA?: string;
  [key: string]: string | undefined;
}

/** Resultado de busca de bula no Bulário Eletrônico ANVISA */
export interface BulaResult {
  medicationName: string;
  registrationNumber?: string;
  manufacturer?: string;
  /** URL do PDF da bula do paciente */
  bulaPacienteUrl?: string;
  /** URL do PDF da bula do profissional de saúde */
  bulaProfissionalUrl?: string;
  /** URL de busca no Bulário (fallback) */
  searchUrl: string;
  lastUpdated?: string;
}

/** Mapa de condição médica para lista de nomes de medicamentos */
export interface ConditionMedicationsMap {
  condition: string;
  conditionSlug: string;
  conditionUrl: string;
  medicationNames: string[];
  lastUpdated: Date;
}

/** Entrada da tabela CID-10 (Classificação Internacional de Doenças) */
export interface Cid10Entry {
  /** Código CID-10 — 3 chars para categorias (ex: E11), 5 chars para subcategorias (ex: E11.0) */
  code: string;
  /** Descrição completa em português */
  description: string;
  /** Descrição abreviada */
  descriptionAbbrev?: string;
  /** true se for subcategoria (ex: E11.0), false se for categoria (ex: E11) */
  isSubcategory: boolean;
  /** Código da categoria pai (apenas subcategorias) */
  parentCode?: string;
  /** Entrada excluída/descontinuada */
  excluded?: boolean;
}

/**
 * Produto à base de cannabis (canabidiol etc.) regulamentado pela ANVISA.
 * Origem: TA_CONSULTA_PRODUTOS_CANNABIS.CSV (sem header, parse posicional).
 */
export interface CannabisProduct {
  /** Número do processo administrativo */
  processNumber: string;
  /** Número de registro/notificação ANVISA */
  registrationNumber: string;
  /** Nome do produto (raw) */
  nameRaw: string;
  /** Nome normalizado para busca */
  name: string;
  /** Razão social do fabricante (raw) */
  manufacturerRaw: string;
  /** Fabricante normalizado */
  manufacturer: string;
  /** CNPJ do fabricante */
  manufacturerCnpj: string;
  /** Princípio ativo (ex: "canabidiol") raw */
  activeIngredientRaw: string;
  /** Princípio ativo normalizado */
  activeIngredient: string;
  /** Situação do registro */
  registrationStatus: RegistrationStatus;
  /** Texto bruto da situação para exibição */
  registrationStatusRaw: string;
  /** Data de vencimento do registro */
  registrationExpiry?: Date;
}

/**
 * Suplemento alimentar registrado/notificado na ANVISA.
 * Origem: TA_CONSULTA_ALIMENTOS.CSV (com header).
 */
export interface Supplement {
  /** Número de registro/notificação */
  registrationNumber: string;
  /** Nome do produto raw */
  nameRaw: string;
  /** Nome normalizado */
  name: string;
  /** Razão social do fabricante raw */
  manufacturerRaw: string;
  /** Fabricante normalizado */
  manufacturer: string;
  /** CNPJ */
  manufacturerCnpj: string;
  /** Marcas associadas (lista, podem ser múltiplas separadas por ;) */
  brands: string[];
  /** Marcas normalizadas para busca */
  brandsNormalized: string[];
  /** Categoria do produto (ex: "Suplementos alimentares") */
  category: string;
  /** Situação do registro */
  registrationStatus: RegistrationStatus;
  registrationStatusRaw: string;
  /** Vencimento do registro (formato MMYYYY no CSV) */
  registrationExpiry?: Date;
  /** Alegações funcionais (texto longo) */
  functionalClaims?: string;
}

/** Estatísticas do data store */
export interface StoreStats {
  totalMedications: number;
  validMedications: number;
  genericCount: number;
  manufacturerCount: number;
  therapeuticClassCount: number;
  activeIngredientCount: number;
  lastUpdated?: Date;
  cmedLoaded: boolean;
}

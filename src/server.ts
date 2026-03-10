import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CONFIG } from './config.js';
import { medicationStore } from './data/store.js';
import { cid10Store } from './data/cid10-store.js';
import { getBula } from './sources/bulario.js';
import { getMedicationsByCondition } from './sources/consultaremedios.js';
import {
  normalize,
  formatDateBR,
  formatBRL,
  truncate,
} from './utils/text.js';
import { toToolError, unknownToolError } from './utils/errors.js';

// ============================================================
// Schemas Zod para validação dos parâmetros das ferramentas
// ============================================================

const ESTADOS_BR = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS',
                    'MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC',
                    'SP','SE','TO'] as const;

const schemas = {
  search_medications: z.object({
    query: z.string().min(2).max(200).describe('Nome, princípio ativo ou condição'),
    type: z.enum(['GENERICO','SIMILAR','REFERENCIA','BIOLOGICO','FITOTERAPICO','OTHER']).optional(),
    manufacturer: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(10),
  }),

  get_medication_details: z.object({
    name: z.string().min(2).max(200).describe('Nome do medicamento'),
    registration_number: z.string().optional().describe('Número de registro ANVISA'),
  }),

  get_bula: z.object({
    medication_name: z.string().min(2).max(200),
  }),

  list_manufacturers: z.object({
    active_only: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(50),
  }),

  get_manufacturer_medications: z.object({
    manufacturer_name: z.string().min(2).max(200),
    limit: z.number().int().min(1).max(100).default(20),
  }),

  list_generic_medications: z.object({
    active_ingredient: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),

  search_by_active_ingredient: z.object({
    ingredient_name: z.string().min(2).max(200),
    type: z.enum(['GENERICO','SIMILAR','REFERENCIA','BIOLOGICO','ALL']).default('ALL'),
    limit: z.number().int().min(1).max(100).default(20),
  }),

  check_price: z.object({
    medication_name: z.string().min(2).max(200),
    state: z.enum(ESTADOS_BR).optional().describe('Sigla do estado (ex: SP, RJ)'),
  }),

  get_medications_by_condition: z.object({
    condition: z.string().min(2).max(200).describe('Condição médica (ex: diabetes, asma, diarreia)'),
    limit: z.number().int().min(1).max(50).default(20),
  }),

  check_anvisa_registration: z.object({
    registration_number: z.string().min(5).max(50),
  }),

  list_therapeutic_classes: z.object({
    limit: z.number().int().min(1).max(200).default(50),
  }),

  search_by_cid: z.object({
    query: z.string().min(1).max(100).describe('Código CID-10 (ex: E11) ou nome da doença (ex: diabetes)'),
    include_subcategories: z.boolean().default(false).describe('Incluir subcategorias na busca'),
    limit: z.number().int().min(1).max(50).default(10),
  }),

  get_cid_info: z.object({
    code_or_name: z.string().min(1).max(100).describe('Código CID-10 (ex: E11) ou nome da doença'),
    show_medications: z.boolean().default(true).describe('Buscar medicamentos relacionados na base ANVISA'),
  }),
};

// ============================================================
// Definições das ferramentas (metadados para o cliente MCP)
// ============================================================

const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'search_medications',
    description: 'Busca medicamentos por nome, princípio ativo ou condição médica. Retorna lista com nome, fabricante, categoria (genérico/similar/referência) e status de registro ANVISA.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nome do medicamento, princípio ativo ou condição médica', minLength: 2 },
        type: { type: 'string', enum: ['GENERICO','SIMILAR','REFERENCIA','BIOLOGICO','FITOTERAPICO','OTHER'], description: 'Filtrar por tipo/categoria do medicamento' },
        manufacturer: { type: 'string', description: 'Filtrar por fabricante' },
        limit: { type: 'number', default: 10, minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_medication_details',
    description: 'Retorna detalhes completos de um medicamento: fabricante, princípios ativos, situação do registro ANVISA, data de vencimento, classe terapêutica e preços CMED quando disponíveis.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome do medicamento' },
        registration_number: { type: 'string', description: 'Número de registro ANVISA (opcional, para busca exata)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_bula',
    description: 'Busca a bula oficial do medicamento no Bulário Eletrônico da ANVISA. Retorna links para PDF da bula do paciente e do profissional de saúde.',
    inputSchema: {
      type: 'object',
      properties: {
        medication_name: { type: 'string', description: 'Nome do medicamento' },
      },
      required: ['medication_name'],
    },
  },
  {
    name: 'list_manufacturers',
    description: 'Lista fabricantes/titulares de medicamentos registrados na ANVISA com contagem de produtos.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', default: true, description: 'Mostrar apenas fabricantes com registros válidos' },
        limit: { type: 'number', default: 50, minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: 'get_manufacturer_medications',
    description: 'Lista os medicamentos registrados por um fabricante específico na ANVISA.',
    inputSchema: {
      type: 'object',
      properties: {
        manufacturer_name: { type: 'string', description: 'Nome do fabricante/laboratório' },
        limit: { type: 'number', default: 20, minimum: 1, maximum: 100 },
      },
      required: ['manufacturer_name'],
    },
  },
  {
    name: 'list_generic_medications',
    description: 'Lista medicamentos genéricos registrados na ANVISA, com opção de filtrar por princípio ativo.',
    inputSchema: {
      type: 'object',
      properties: {
        active_ingredient: { type: 'string', description: 'Filtrar genéricos por princípio ativo (ex: metformina, amoxicilina)' },
        limit: { type: 'number', default: 20, minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'search_by_active_ingredient',
    description: 'Busca medicamentos que contêm um princípio ativo específico. Útil para encontrar genéricos, similares e medicamentos de referência com o mesmo componente.',
    inputSchema: {
      type: 'object',
      properties: {
        ingredient_name: { type: 'string', description: 'Nome do princípio ativo (ex: paracetamol, dipirona, metformina)' },
        type: { type: 'string', enum: ['GENERICO','SIMILAR','REFERENCIA','BIOLOGICO','ALL'], default: 'ALL' },
        limit: { type: 'number', default: 20, minimum: 1, maximum: 100 },
      },
      required: ['ingredient_name'],
    },
  },
  {
    name: 'check_price',
    description: 'Verifica os preços oficiais de um medicamento conforme tabela CMED (Câmara de Regulação do Mercado de Medicamentos). Inclui Preço de Fábrica (PF) e Preço Máximo ao Consumidor (PMC) por estado.',
    inputSchema: {
      type: 'object',
      properties: {
        medication_name: { type: 'string', description: 'Nome do medicamento' },
        state: { type: 'string', description: 'Sigla do estado brasileiro (ex: SP, RJ, MG) para preço regional' },
      },
      required: ['medication_name'],
    },
  },
  {
    name: 'get_medications_by_condition',
    description: 'Lista medicamentos indicados para uma condição médica ou doença específica (ex: diabetes, asma, hipertensão, diarreia).',
    inputSchema: {
      type: 'object',
      properties: {
        condition: { type: 'string', description: 'Condição médica ou doença (em português)' },
        limit: { type: 'number', default: 20, minimum: 1, maximum: 50 },
      },
      required: ['condition'],
    },
  },
  {
    name: 'check_anvisa_registration',
    description: 'Verifica a situação do registro de um medicamento na ANVISA: válido, vencido ou cancelado.',
    inputSchema: {
      type: 'object',
      properties: {
        registration_number: { type: 'string', description: 'Número de registro ANVISA do medicamento' },
      },
      required: ['registration_number'],
    },
  },
  {
    name: 'list_therapeutic_classes',
    description: 'Lista as classes terapêuticas de medicamentos registrados na ANVISA com a contagem de medicamentos em cada classe.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 50, minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'search_by_cid',
    description: 'Busca doenças e condições médicas pela tabela CID-10 (Classificação Internacional de Doenças). Aceita código CID (ex: E11, J45) ou nome da doença em português (ex: diabetes, asma, hipertensão).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Código CID-10 (ex: E11) ou nome da doença em português (ex: diabetes, asma)' },
        include_subcategories: { type: 'boolean', default: false, description: 'Incluir subcategorias detalhadas na resposta' },
        limit: { type: 'number', default: 10, minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_cid_info',
    description: 'Retorna informações detalhadas sobre uma doença pelo código CID-10 ou nome, incluindo subcategorias e medicamentos relacionados registrados na ANVISA.',
    inputSchema: {
      type: 'object',
      properties: {
        code_or_name: { type: 'string', description: 'Código CID-10 (ex: E11) ou nome da doença (ex: diabetes mellitus)' },
        show_medications: { type: 'boolean', default: true, description: 'Buscar medicamentos relacionados na base ANVISA' },
      },
      required: ['code_or_name'],
    },
  },
];

// ============================================================
// Handlers das ferramentas
// ============================================================

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function handleSearchMedications(args: unknown): Promise<ToolResult> {
  const { query, type, manufacturer, limit } = schemas.search_medications.parse(args);
  await medicationStore.waitForReady();

  let results = medicationStore.search(query, Math.min(limit * 3, 300));

  if (type) results = results.filter(m => m.category === type);
  if (manufacturer) {
    const mfn = normalize(manufacturer);
    results = results.filter(m => m.manufacturer.includes(mfn));
  }
  results = results.slice(0, limit);

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `Nenhum medicamento encontrado para "${query}".` }] };
  }

  const lines = results.map((m, i) =>
    `${i + 1}. **${m.nameRaw}**\n   - Fabricante: ${m.manufacturerRaw}\n   - Categoria: ${m.category}\n   - Princípio(s) ativo(s): ${m.activeIngredientsRaw || 'N/D'}\n   - Registro: ${m.registrationNumber} (${m.registrationStatus})`
  );

  return {
    content: [{
      type: 'text',
      text: `**${results.length} medicamento(s) encontrado(s) para "${query}":**\n\n${lines.join('\n\n')}`,
    }],
  };
}

async function handleGetMedicationDetails(args: unknown): Promise<ToolResult> {
  const { name, registration_number } = schemas.get_medication_details.parse(args);
  await medicationStore.waitForReady();

  let med = registration_number
    ? medicationStore.getByRegistration(registration_number)
    : undefined;

  if (!med) {
    const results = medicationStore.search(name, 1);
    med = results[0];
  }

  if (!med) {
    return { content: [{ type: 'text', text: `Medicamento "${name}" não encontrado na base ANVISA.` }] };
  }

  const lines = [
    `## ${med.nameRaw}`,
    ``,
    `- **Fabricante:** ${med.manufacturerRaw}`,
    `- **CNPJ:** ${med.manufacturerCnpj || 'N/D'}`,
    `- **Categoria:** ${med.category}`,
    `- **Princípio(s) ativo(s):** ${med.activeIngredientsRaw || 'N/D'}`,
    `- **Classe terapêutica:** ${med.therapeuticClass || 'N/D'}`,
    `- **Número de registro:** ${med.registrationNumber}`,
    `- **Status:** ${med.registrationStatus}`,
    `- **Vencimento do registro:** ${formatDateBR(med.registrationExpiry)}`,
    `- **Processo:** ${med.processNumber || 'N/D'}`,
  ];

  if (med.prices && med.prices.length > 0) {
    lines.push('', '### Preços CMED');
    for (const p of med.prices.slice(0, 3)) {
      lines.push(`- **${p.presentation}**`);
      if (p.pf0 !== undefined) lines.push(`  - PF (sem impostos): ${formatBRL(p.pf0)}`);
      if (p.pmc18 !== undefined) lines.push(`  - PMC (18% ICMS): ${formatBRL(p.pmc18)}`);
      if (p.tarja) lines.push(`  - Tarja: ${p.tarja}`);
    }
    lines.push('', '*Preços CMED são referência máxima legal. Preços reais podem variar.*');
  } else {
    lines.push('', '*Dados de preço CMED não disponíveis para este medicamento.*');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleGetBula(args: unknown): Promise<ToolResult> {
  const { medication_name } = schemas.get_bula.parse(args);

  const bula = await getBula(medication_name);

  const lines = [
    `## Bula: ${bula.medicationName}`,
    '',
    bula.manufacturer ? `- **Fabricante:** ${bula.manufacturer}` : '',
    bula.registrationNumber ? `- **Registro ANVISA:** ${bula.registrationNumber}` : '',
    bula.lastUpdated ? `- **Última atualização:** ${bula.lastUpdated}` : '',
    '',
    '### Links para a Bula Oficial (ANVISA)',
    bula.bulaPacienteUrl
      ? `- **Bula do Paciente (PDF):** ${bula.bulaPacienteUrl}`
      : '- Bula do paciente: não disponível via API',
    bula.bulaProfissionalUrl
      ? `- **Bula do Profissional (PDF):** ${bula.bulaProfissionalUrl}`
      : '- Bula do profissional: não disponível via API',
    '',
    `- **Buscar no Bulário Eletrônico ANVISA:** ${bula.searchUrl}`,
  ].filter(l => l !== '');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleListManufacturers(args: unknown): Promise<ToolResult> {
  const { active_only, limit } = schemas.list_manufacturers.parse(args);
  await medicationStore.waitForReady();

  const manufacturers = medicationStore.listManufacturers(active_only).slice(0, limit);

  if (manufacturers.length === 0) {
    return { content: [{ type: 'text', text: 'Nenhum fabricante encontrado.' }] };
  }

  const lines = manufacturers.map((m, i) =>
    `${i + 1}. **${m.nameRaw}** — ${m.medicationCount} produtos (${m.activeCount} válidos)`
  );

  return {
    content: [{
      type: 'text',
      text: `**${manufacturers.length} fabricante(s) registrado(s) na ANVISA:**\n\n${lines.join('\n')}`,
    }],
  };
}

async function handleGetManufacturerMedications(args: unknown): Promise<ToolResult> {
  const { manufacturer_name, limit } = schemas.get_manufacturer_medications.parse(args);
  await medicationStore.waitForReady();

  const meds = medicationStore.getByManufacturer(manufacturer_name, limit);

  if (meds.length === 0) {
    return { content: [{ type: 'text', text: `Nenhum medicamento encontrado para o fabricante "${manufacturer_name}".` }] };
  }

  const lines = meds.map((m, i) =>
    `${i + 1}. **${m.nameRaw}** (${m.category}) — ${m.registrationStatus}`
  );

  return {
    content: [{
      type: 'text',
      text: `**${meds.length} medicamento(s) do fabricante "${manufacturer_name}":**\n\n${lines.join('\n')}`,
    }],
  };
}

async function handleListGenericMedications(args: unknown): Promise<ToolResult> {
  const { active_ingredient, limit } = schemas.list_generic_medications.parse(args);
  await medicationStore.waitForReady();

  const meds = medicationStore.listGenerics(active_ingredient, limit);

  if (meds.length === 0) {
    const msg = active_ingredient
      ? `Nenhum genérico encontrado com o princípio ativo "${active_ingredient}".`
      : 'Nenhum medicamento genérico encontrado.';
    return { content: [{ type: 'text', text: msg }] };
  }

  const lines = meds.map((m, i) =>
    `${i + 1}. **${m.nameRaw}** — ${m.activeIngredientsRaw || 'N/D'} (${m.manufacturerRaw})`
  );

  const header = active_ingredient
    ? `**${meds.length} genérico(s) com "${active_ingredient}":**`
    : `**${meds.length} medicamento(s) genérico(s):**`;

  return { content: [{ type: 'text', text: `${header}\n\n${lines.join('\n')}` }] };
}

async function handleSearchByActiveIngredient(args: unknown): Promise<ToolResult> {
  const { ingredient_name, type, limit } = schemas.search_by_active_ingredient.parse(args);
  await medicationStore.waitForReady();

  let meds = medicationStore.searchByIngredient(ingredient_name, limit * 3);

  if (type !== 'ALL') {
    meds = meds.filter(m => m.category === type);
  }
  meds = meds.slice(0, limit);

  if (meds.length === 0) {
    return { content: [{ type: 'text', text: `Nenhum medicamento encontrado com o princípio ativo "${ingredient_name}".` }] };
  }

  // Agrupar por categoria para melhor visualização
  const grouped: Record<string, typeof meds> = {};
  for (const med of meds) {
    if (!grouped[med.category]) grouped[med.category] = [];
    grouped[med.category].push(med);
  }

  const sections = Object.entries(grouped).map(([cat, items]) => {
    const lines = items.map((m, i) => `  ${i + 1}. ${m.nameRaw} (${m.manufacturerRaw})`);
    return `**${cat}:**\n${lines.join('\n')}`;
  });

  return {
    content: [{
      type: 'text',
      text: `**${meds.length} medicamento(s) com "${ingredient_name}":**\n\n${sections.join('\n\n')}`,
    }],
  };
}

async function handleCheckPrice(args: unknown): Promise<ToolResult> {
  const { medication_name, state } = schemas.check_price.parse(args);
  await medicationStore.waitForReady();

  const stats = medicationStore.getStats();
  if (!stats.cmedLoaded) {
    return {
      content: [{
        type: 'text',
        text: `Dados de preço CMED ainda sendo carregados. Tente novamente em alguns segundos.\n\nAlternativamente, consulte: https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos`,
      }],
    };
  }

  const results = medicationStore.search(medication_name, 20);
  const withPrices = results.filter(m => m.prices && m.prices.length > 0);

  if (withPrices.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `Preços CMED não encontrados para "${medication_name}".\n\nConsulte: https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos`,
      }],
    };
  }

  const lines = [`## Preços CMED: ${medication_name}`, ''];

  for (const med of withPrices.slice(0, 3)) {
    lines.push(`### ${med.nameRaw} (${med.manufacturerRaw})`);
    for (const price of (med.prices ?? []).slice(0, 2)) {
      lines.push(`**${price.presentation}**`);
      if (price.pf0 !== undefined) lines.push(`- PF sem impostos: ${formatBRL(price.pf0)}`);
      if (!state || state === 'SP') {
        if (price.pf18 !== undefined) lines.push(`- PF 18% ICMS: ${formatBRL(price.pf18)}`);
        if (price.pmc18 !== undefined) lines.push(`- PMC 18% ICMS: ${formatBRL(price.pmc18)}`);
      }
      if (state === 'RJ' || state === 'MG' || state === 'RS') {
        if (price.pmc19 !== undefined) lines.push(`- PMC 19% ICMS (${state}): ${formatBRL(price.pmc19)}`);
      }
      if (price.tarja) lines.push(`- Tarja: ${price.tarja}`);
      if (price.ean) lines.push(`- EAN: ${price.ean}`);
    }
    lines.push('');
  }

  lines.push('*Preços CMED são referência máxima legal. Preços reais podem ser menores.*');
  lines.push('*Fonte: CMED/ANVISA — ' + new Date().getFullYear() + '*');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleGetMedicationsByCondition(args: unknown): Promise<ToolResult> {
  const { condition, limit } = schemas.get_medications_by_condition.parse(args);
  await medicationStore.waitForReady();

  // Primeira tentativa: busca direta no store ANVISA pela condição
  const anvisaResults = medicationStore.search(condition, 10);

  // Segunda tentativa: scraping do consultaremedios (lazy)
  let conditionMap = null;
  try {
    conditionMap = await getMedicationsByCondition(condition, limit);
  } catch (err) {
    console.error('[Tool] Erro ao buscar condição no consultaremedios:', err);
  }

  const lines: string[] = [`## Medicamentos para: ${condition}`, ''];

  if (conditionMap && conditionMap.medicationNames.length > 0) {
    lines.push(`### Encontrado via categorias (consultaremedios.com.br)`);
    conditionMap.medicationNames.slice(0, limit).forEach((name, i) => {
      lines.push(`${i + 1}. ${truncate(name, 100)}`);
    });
    lines.push('');
    lines.push(`*Fonte: ${conditionMap.conditionUrl}*`);
  } else if (anvisaResults.length > 0) {
    lines.push(`### Resultados da base ANVISA para "${condition}"`);
    anvisaResults.forEach((m, i) => {
      lines.push(`${i + 1}. **${m.nameRaw}** (${m.category}) — ${m.activeIngredientsRaw || 'N/D'}`);
    });
  } else {
    lines.push(`Nenhum resultado encontrado para a condição "${condition}".`);
    lines.push('');
    lines.push('Dicas:');
    lines.push('- Use o nome em português (ex: "diabetes", "asma", "hipertensão")');
    lines.push('- Tente buscar pelo princípio ativo com search_by_active_ingredient');
    lines.push('- Tente search_medications com o nome da doença');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleCheckAnvisaRegistration(args: unknown): Promise<ToolResult> {
  const { registration_number } = schemas.check_anvisa_registration.parse(args);
  await medicationStore.waitForReady();

  const med = medicationStore.getByRegistration(registration_number);

  if (!med) {
    return {
      content: [{
        type: 'text',
        text: `Registro "${registration_number}" não encontrado na base ANVISA.\n\nVerifique em: https://consultas.anvisa.gov.br/#/medicamentos/`,
      }],
    };
  }

  const expiry = med.registrationExpiry;
  const today = new Date();
  const daysUntilExpiry = expiry
    ? Math.floor((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const statusEmoji = med.registrationStatus === 'VALIDO' ? '✅' : med.registrationStatus === 'VENCIDO' ? '⚠️' : '❌';

  const lines = [
    `## Registro ANVISA: ${registration_number}`,
    '',
    `${statusEmoji} **Status:** ${med.registrationStatus}`,
    `- **Produto:** ${med.nameRaw}`,
    `- **Fabricante:** ${med.manufacturerRaw}`,
    `- **CNPJ:** ${med.manufacturerCnpj || 'N/D'}`,
    `- **Categoria:** ${med.category}`,
    `- **Princípio(s) ativo(s):** ${med.activeIngredientsRaw || 'N/D'}`,
    `- **Vencimento:** ${formatDateBR(expiry)}`,
    daysUntilExpiry !== null
      ? `- **Dias até vencimento:** ${daysUntilExpiry > 0 ? daysUntilExpiry : `VENCIDO há ${Math.abs(daysUntilExpiry)} dias`}`
      : '',
  ].filter(l => l !== '');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleListTherapeuticClasses(args: unknown): Promise<ToolResult> {
  const { limit } = schemas.list_therapeutic_classes.parse(args);
  await medicationStore.waitForReady();

  const classes = medicationStore.listTherapeuticClasses().slice(0, limit);

  if (classes.length === 0) {
    return { content: [{ type: 'text', text: 'Dados de classes terapêuticas não disponíveis.' }] };
  }

  const lines = classes.map((c, i) =>
    `${i + 1}. **${c.code}** — ${c.medicationCount} medicamento(s)`
  );

  return {
    content: [{
      type: 'text',
      text: `**${classes.length} classe(s) terapêutica(s):**\n\n${lines.join('\n')}`,
    }],
  };
}

async function handleSearchByCid(args: unknown): Promise<ToolResult> {
  const { query, include_subcategories, limit } = schemas.search_by_cid.parse(args);

  if (!cid10Store.isLoaded) {
    return {
      content: [{
        type: 'text',
        text: 'Tabela CID-10 ainda sendo carregada. Aguarde alguns instantes e tente novamente.',
      }],
    };
  }

  let results = cid10Store.search(query, limit * 3);

  if (!include_subcategories) {
    const onlyCategories = results.filter(e => !e.isSubcategory);
    // Se filtrar zerar os resultados, mantém todos
    if (onlyCategories.length > 0) results = onlyCategories;
  }

  results = results.slice(0, limit);

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `Nenhuma doença/condição encontrada para "${query}" na tabela CID-10.\n\nTente:\n- Código completo: E11, J45, I10\n- Nome em português: diabetes, asma, hipertensão`,
      }],
    };
  }

  const lines = [`## CID-10 — Resultados para "${query}"`, ''];

  for (const entry of results) {
    const subcatLabel = entry.isSubcategory ? ` *(subcategoria de ${entry.parentCode})*` : '';
    lines.push(`- **${entry.code}** — ${entry.description}${subcatLabel}`);
  }

  lines.push('');
  lines.push(`*Use \`get_cid_info\` com um código específico para detalhes e medicamentos relacionados.*`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleGetCidInfo(args: unknown): Promise<ToolResult> {
  const { code_or_name, show_medications } = schemas.get_cid_info.parse(args);

  if (!cid10Store.isLoaded) {
    return {
      content: [{
        type: 'text',
        text: 'Tabela CID-10 ainda sendo carregada. Aguarde alguns instantes.',
      }],
    };
  }

  // Tenta lookup exato por código primeiro, depois busca
  const trimmed = code_or_name.trim().toUpperCase();
  let entry = cid10Store.getByCode(trimmed);

  if (!entry) {
    const results = cid10Store.search(code_or_name, 1);
    entry = results[0];
  }

  if (!entry) {
    return {
      content: [{
        type: 'text',
        text: `"${code_or_name}" não encontrado na tabela CID-10. Use \`search_by_cid\` para encontrar o código correto.`,
      }],
    };
  }

  const lines = [
    `## CID-10 ${entry.code} — ${entry.description}`,
    '',
    `- **Código:** ${entry.code}`,
    `- **Tipo:** ${entry.isSubcategory ? `Subcategoria (pertence a ${entry.parentCode})` : 'Categoria principal'}`,
    entry.descriptionAbbrev ? `- **Abreviação:** ${entry.descriptionAbbrev}` : '',
  ].filter(l => l !== '');

  // Subcategorias (apenas para categorias principais)
  if (!entry.isSubcategory) {
    const subcats = cid10Store.getSubcategories(entry.code);
    if (subcats.length > 0) {
      lines.push('', `### Subcategorias (${subcats.length})`);
      for (const sub of subcats.slice(0, 10)) {
        lines.push(`- **${sub.code}** — ${sub.description}`);
      }
      if (subcats.length > 10) lines.push(`- *... e mais ${subcats.length - 10} subcategorias*`);
    }
  }

  // Medicamentos relacionados via busca ANVISA
  if (show_medications && medicationStore.isReady) {
    const keywords = cid10Store.getSearchKeywordsForEntry(entry);

    if (keywords.length > 0) {
      const searchQuery = keywords.slice(0, 3).join(' ');
      const meds = medicationStore.search(searchQuery, 15);
      const validMeds = meds.filter(m => m.registrationStatus === 'VALIDO');

      if (validMeds.length > 0) {
        lines.push('', `### Medicamentos relacionados na base ANVISA`);
        lines.push(`*Busca por: "${keywords.slice(0, 3).join(', ')}"*`);
        lines.push('');

        // Agrupar por categoria
        const byCategory = new Map<string, typeof validMeds>();
        for (const med of validMeds.slice(0, 12)) {
          if (!byCategory.has(med.category)) byCategory.set(med.category, []);
          byCategory.get(med.category)!.push(med);
        }

        for (const [cat, items] of byCategory) {
          lines.push(`**${cat}:**`);
          for (const med of items.slice(0, 4)) {
            lines.push(`- ${med.nameRaw} (${med.manufacturerRaw})`);
          }
        }

        lines.push('');
        lines.push('*Use `search_by_active_ingredient` ou `search_medications` para busca mais específica.*');
      }
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ============================================================
// Criação e configuração do servidor MCP
// ============================================================

export function createServer(): Server {
  const server = new Server(
    { name: CONFIG.SERVER.NAME, version: CONFIG.SERVER.VERSION },
    { capabilities: { tools: {} } }
  );

  // Listar todas as ferramentas disponíveis
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Roteador de chamadas de ferramentas
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    try {
      switch (name) {
        case 'search_medications':          return await handleSearchMedications(rawArgs);
        case 'get_medication_details':      return await handleGetMedicationDetails(rawArgs);
        case 'get_bula':                    return await handleGetBula(rawArgs);
        case 'list_manufacturers':          return await handleListManufacturers(rawArgs);
        case 'get_manufacturer_medications':return await handleGetManufacturerMedications(rawArgs);
        case 'list_generic_medications':    return await handleListGenericMedications(rawArgs);
        case 'search_by_active_ingredient': return await handleSearchByActiveIngredient(rawArgs);
        case 'check_price':                 return await handleCheckPrice(rawArgs);
        case 'get_medications_by_condition':return await handleGetMedicationsByCondition(rawArgs);
        case 'check_anvisa_registration':   return await handleCheckAnvisaRegistration(rawArgs);
        case 'list_therapeutic_classes':    return await handleListTherapeuticClasses(rawArgs);
        case 'search_by_cid':               return await handleSearchByCid(rawArgs);
        case 'get_cid_info':                return await handleGetCidInfo(rawArgs);
        default:
          throw unknownToolError(name);
      }
    } catch (error) {
      // Erros de validação Zod
      if (error instanceof z.ZodError) {
        return {
          content: [{ type: 'text', text: `Parâmetros inválidos: ${error.issues.map((e) => `${String(e.path.join('.'))}: ${e.message}`).join('; ')}` }],
          isError: true,
        };
      }
      return toToolError(error);
    }
  });

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(`[Server] ${CONFIG.SERVER.NAME} v${CONFIG.SERVER.VERSION} iniciado via stdio.`);
}

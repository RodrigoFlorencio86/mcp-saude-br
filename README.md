# mcp-saude-br

**MCP Server para dados de saúde brasileiros** — alimentado exclusivamente por fontes oficiais (ANVISA, CMED, DATASUS).

Permite que Claude e outros agentes de IA consultem, dentro da conversa: medicamentos registrados, suplementos alimentares, produtos à base de cannabis, preços regulados CMED, bulas oficiais e a Classificação Internacional de Doenças (CID-10).

[![npm](https://img.shields.io/npm/v/mcp-saude-br.svg)](https://www.npmjs.com/package/mcp-saude-br)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## O que você pode perguntar ao Claude

Depois de configurar o MCP (instruções abaixo), basta perguntar em português:

```text
Liste medicamentos genéricos para diabetes
```

```text
Qual o preço máximo da metformina 500mg em São Paulo?
```

```text
Quem fabrica produtos à base de canabidiol no Brasil?
```

```text
Quais fabricantes produzem whey protein?
```

```text
Me dê a bula oficial da dipirona sódica
```

```text
O registro ANVISA 1.0004.0064.003-5 ainda é válido?
```

```text
Quais doenças têm código CID E11? Quais medicamentos existem para tratá-las?
```

---

## Instalação — 1 minuto

Você **não precisa instalar nada manualmente**. O `npx` baixa e executa o servidor automaticamente. Só precisa adicionar uma configuração no seu cliente MCP.

### Claude Desktop

Edite o arquivo de configuração e adicione o bloco `mcpServers`:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "saude-br": {
      "command": "npx",
      "args": ["-y", "mcp-saude-br"]
    }
  }
}
```

Reinicie o Claude Desktop. Na primeira execução, o MCP baixa ~10 MB de dados (leva 5–15 segundos). Os dados ficam em cache local; as próximas inicializações são instantâneas.

### Claude Code

Crie `.mcp.json` na raiz do seu projeto com o mesmo conteúdo acima.

### Outros clientes MCP

Qualquer cliente que suporte o transporte stdio do Model Context Protocol funciona — basta apontar para `npx -y mcp-saude-br`.

---

## O que tem na base

Os números abaixo refletem o estado dos datasets oficiais em **abril de 2026**. Os dados são atualizados automaticamente pelo servidor e por um GitHub Action semanal (explicado mais abaixo) — os números no texto podem mudar ao longo do tempo.

| Dataset | Registros | Fonte oficial |
|---|---|---|
| **Medicamentos ANVISA** (total) | ~42.900 | `dados.anvisa.gov.br/DADOS_ABERTOS_MEDICAMENTOS.csv` |
| Medicamentos com registro **válido** | ~17.200 | ANVISA Open Data |
| Medicamentos **genéricos** | ~8.000 | ANVISA Open Data |
| **Preços CMED** (tabela de conformidade) | ~53.000 apresentações | `dados.anvisa.gov.br/TA_PRECOS_MEDICAMENTOS.csv` |
| **Suplementos alimentares** (total) | ~58.700 | `dados.anvisa.gov.br/CONSULTAS/PRODUTOS/TA_CONSULTA_ALIMENTOS.CSV` |
| Suplementos com registro ativo | ~10.300 | ANVISA Open Data |
| **Produtos à base de cannabis** | ~62 | `dados.anvisa.gov.br/CONSULTAS/PRODUTOS/TA_CONSULTA_PRODUTOS_CANNABIS.CSV` |
| **CID-10** (categorias + subcategorias) | ~12.000 | DATASUS V2008 |
| Fabricantes de medicamentos | ~770 | ANVISA Open Data |
| Fabricantes de suplementos | ~7.300 | ANVISA Open Data |
| Fabricantes de cannabis | ~28 | ANVISA Open Data |
| Princípios ativos únicos | ~4.200 | ANVISA Open Data |
| Classes terapêuticas | ~490 | ANVISA Open Data |

---

## 18 ferramentas disponíveis

### Medicamentos (11)

| Ferramenta | Para quê |
|---|---|
| `search_medications` | Busca por nome, princípio ativo ou condição |
| `get_medication_details` | Ficha completa + preços CMED |
| `get_bula` | Bula oficial (PDF paciente e profissional) |
| `list_manufacturers` | Lista fabricantes com contagem de produtos |
| `get_manufacturer_medications` | Todos os medicamentos de um fabricante |
| `list_generic_medications` | Genéricos, filtráveis por princípio ativo |
| `search_by_active_ingredient` | Medicamentos que contêm um princípio ativo |
| `check_price` | Preços PF/PMC oficiais por estado |
| `get_medications_by_condition` | Medicamentos indicados para uma condição |
| `check_anvisa_registration` | Verifica validade do registro ANVISA |
| `list_therapeutic_classes` | Classes terapêuticas com contagem |

### Suplementos alimentares (3)

| Ferramenta | Para quê |
|---|---|
| `search_supplements` | Busca por nome, marca ou fabricante (whey, vitamina C, etc.) |
| `get_supplement_details` | Ficha completa: marcas, categoria, alegações funcionais |
| `list_supplement_manufacturers` | Lista paginada de fabricantes, com filtro por nome |

### Produtos à base de cannabis (2)

| Ferramenta | Para quê |
|---|---|
| `search_cannabis_products` | Busca por nome, princípio ativo ou fabricante |
| `list_cannabis_manufacturers` | Lista todas as empresas autorizadas |

### Doenças — CID-10 (2)

| Ferramenta | Para quê |
|---|---|
| `search_by_cid` | Busca por código (E11, J45) ou nome em português |
| `get_cid_info` | Subcategorias + medicamentos relacionados na base ANVISA |

---

## Como os dados chegam até você

O MCP usa uma estratégia de **cache em camadas** para ser rápido e resistente a instabilidades dos servidores do governo:

```text
1. GitHub Release (CDN, semanal) — primário
         ↓ falhou?
2. Fontes oficiais (ANVISA/DATASUS) — fallback
         ↓ falhou?
3. Asset estático no pacote (CID-10) — último recurso
```

**Por que isso importa:** em abril de 2026, a ANVISA reorganizou o servidor de dados abertos e removeu o prefixo `/dados/` de todos os CSVs. Versões anteriores do MCP quebraram na inicialização. Com o cache via GitHub Release, esse tipo de mudança só afeta o CI (que republica semanalmente) — o cliente continua funcionando até o próximo ciclo.

### Arquitetura de atualização

```text
   Segunda-feira 03:00 UTC (GitHub Actions)
                    │
                    ▼
       Baixa + valida + gzipa os 5 CSVs
       das fontes oficiais ANVISA/DATASUS
                    │
                    ▼
       Publica como GitHub Release
       (data-YYYY-MM-DD, ~10 MB total)
                    │
                    ▼
       Cliente baixa de /releases/latest/
       na inicialização (5–15s)
```

### Cache local

Depois da primeira execução, os CSVs ficam em `~/.cache` (ou onde `DATA_DIR` apontar) com TTL próprio:

| Dado | TTL local | Atualização upstream |
|---|---|---|
| ANVISA medicamentos | 7 dias | Publicado diariamente |
| CMED preços | 30 dias | Publicado mensalmente |
| CID-10 | 1 ano | Muda raramente (V2008) |
| Cannabis | 7 dias | Publicado semanalmente |
| Suplementos | 7 dias | Publicado semanalmente |

Quando o TTL expira, o servidor tenta atualizar em background — sem bloquear as consultas.

---

## Desenvolvimento local

```bash
git clone https://github.com/RodrigoFlorencio/mcp-saude-br.git
cd mcp-saude-br
npm install
npm run build
npm run inspect        # Abre MCP Inspector no navegador
```

### Scripts

| Comando | Descrição |
|---|---|
| `npm run build` | Compila TypeScript → `dist/` |
| `npm run dev` | Roda via `tsx` sem compilar |
| `npm run inspect` | Abre MCP Inspector (testar tools) |
| `npm run build-release` | Executa localmente o mesmo pipeline do CI (gera `release-output/`) |
| `npm test` | Roda testes com Vitest |

### Exemplos no MCP Inspector

```json
{ "query": "dipirona", "limit": 5 }                           // search_medications
{ "query": "whey protein" }                                   // search_supplements
{ "manufacturer": "VERDEMED" }                                // search_cannabis_products
{ "medication_name": "Metformina", "state": "SP" }            // check_price
{ "code_or_name": "E11" }                                     // get_cid_info
{ "filter": "suplementos", "limit": 20 }                      // list_supplement_manufacturers
```

---

## Estrutura do projeto

```text
src/
├── index.ts                    # Entry point
├── server.ts                   # Servidor MCP + 18 tools
├── config.ts                   # URLs, TTLs, paths
├── data/
│   ├── types.ts                # Tipos TypeScript
│   ├── store.ts                # Medicamentos (5 índices)
│   ├── cid10-store.ts          # CID-10
│   ├── cannabis-store.ts       # Cannabis
│   ├── supplements-store.ts    # Suplementos alimentares
│   └── loader.ts               # Orquestra download + parse + refresh
├── sources/                    # Uma por dataset
│   ├── anvisa-csv.ts
│   ├── cmed.ts
│   ├── cid10.ts
│   ├── anvisa-cannabis.ts
│   ├── anvisa-alimentos.ts
│   ├── bulario.ts              # API Bulário Eletrônico
│   └── consultaremedios.ts     # Scraping controlado
├── http/
│   ├── client.ts               # Axios + gunzip + ICP-Brasil
│   └── queue.ts                # Rate limiting por domínio
└── utils/
    ├── text.ts                 # Normalização PT-BR
    └── errors.ts               # Erros MCP

scripts/
└── build-data-release.ts       # Script do Action semanal

assets/
└── CID10CSV.zip                # Asset estático (fallback CID-10)

.github/workflows/
└── build-data.yml              # Action semanal de republicação
```

---

## Requisitos

- **Node.js ≥ 18** (LTS recomendado — 20 ou 22)
- Conexão com a internet na primeira execução (~10 MB)

Sem dependências nativas — roda em qualquer plataforma onde o Node rode.

---

## Licença

MIT — veja [LICENSE](LICENSE).

---

## Aviso

Este projeto não tem vínculo oficial com ANVISA, CMED, DATASUS ou qualquer órgão do governo. Os dados são obtidos de fontes públicas abertas e podem estar defasados em relação aos portais oficiais. Para decisões clínicas, consulte sempre um profissional de saúde e verifique as fontes originais:

- [ANVISA Open Data](https://dados.anvisa.gov.br)
- [Bulário Eletrônico ANVISA](https://consultas.anvisa.gov.br/#/bulario)
- [CMED — Preços de Medicamentos](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos)
- [Produtos regulados ANVISA — Consultas](https://consultas.anvisa.gov.br/#/)
- [CID-10 DATASUS](http://www2.datasus.gov.br/cid10/V2008/download.htm)

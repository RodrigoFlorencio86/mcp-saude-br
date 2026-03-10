# mcp-saude-br

**MCP Server para dados de medicamentos e doenças brasileiros** — alimentado exclusivamente por fontes oficiais do governo (ANVISA, CMED e DATASUS).

Permite que Claude e outros agentes de IA consultem informações sobre medicamentos registrados no Brasil e a Classificação Internacional de Doenças (CID-10) diretamente na conversa.

---

## Números da base de dados

> Os números abaixo refletem o estado das fontes em **março de 2026**. Os dados são atualizados automaticamente pelo servidor (ANVISA semanalmente, CMED mensalmente, CID-10 anualmente) — o texto deste README não é atualizado a cada ciclo.

| Base | Volume | Fonte |
|------|--------|-------|
| Medicamentos registrados (total) | **42.842** | ANVISA Open Data |
| Medicamentos com registro válido | **17.206** | ANVISA Open Data |
| Medicamentos genéricos | **8.015** | ANVISA Open Data |
| Fabricantes/titulares registrados | **769** | ANVISA Open Data |
| Princípios ativos únicos | **4.177** | ANVISA Open Data |
| Classes terapêuticas | **486** | ANVISA Open Data |
| Códigos CID-10 (categorias + subcategorias) | **~12.000** | DATASUS |

---

## Instalação rápida

Nenhuma instalação necessária. Basta configurar o MCP no seu cliente e o `npx` baixa e executa automaticamente:

**Claude Code** — adicione `.mcp.json` na raiz do seu projeto:

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

**Claude Desktop** — edite `%APPDATA%\Claude\claude_desktop_config.json` (Windows) ou `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac):

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

Na primeira execução, o servidor baixa automaticamente a base ANVISA (~10 MB) e a tabela CID-10 (~1 MB). Isso pode levar 1–2 minutos. Após o download, os dados ficam em cache local.

---

## O que você pode perguntar ao Claude

Após configurar o MCP, pergunte diretamente:

```text
Liste medicamentos genéricos para diabetes
```

```text
Mostre a bula oficial da dipirona
```

```text
Qual o preço máximo da metformina 500mg em São Paulo?
```

```text
Quais medicamentos o laboratório EMS fabrica?
```

```text
O registro ANVISA 1.0004.0064.003-5 ainda é válido?
```

```text
Quais princípios ativos existem para hipertensão?
```

```text
Quais doenças têm código CID E11?
```

```text
Me dê informações sobre asma (CID J45) e os medicamentos disponíveis no Brasil
```

---

## Fontes de dados

| Fonte | Tipo | Dados |
|-------|------|-------|
| **ANVISA Open Data** | CSV oficial | 42.842 medicamentos registrados |
| **CMED/ANVISA** | CSV oficial | Preços PF e PMC por estado |
| **Bulário Eletrônico ANVISA** | API pública | Bulas em PDF (paciente e profissional) |
| **DATASUS (CID-10)** | ZIP/CSV oficial | ~12.000 códigos de doenças e condições |
| **consultaremedios.com.br** | Scraping seletivo¹ | Mapeamento condição → medicamentos |

> ¹ Apenas páginas de categoria permitidas pelo `robots.txt`, com rate limit de 1 req/s e `User-Agent` identificado.

Todos os dados são **abertos do governo federal** (ANVISA/CMED/DATASUS), de uso irrestrito.

---

## Ferramentas disponíveis (13)

### Medicamentos

| Ferramenta | Descrição |
|------------|-----------|
| `search_medications` | Busca por nome, princípio ativo ou fabricante |
| `get_medication_details` | Detalhes completos do medicamento + preços CMED |
| `get_bula` | Bula oficial no Bulário Eletrônico ANVISA (PDF) |
| `list_manufacturers` | Lista fabricantes com contagem de produtos |
| `get_manufacturer_medications` | Todos os medicamentos de um fabricante |
| `list_generic_medications` | Genéricos, filtráveis por princípio ativo |
| `search_by_active_ingredient` | Medicamentos por princípio ativo |
| `check_price` | Preços PF e PMC oficiais por estado (CMED) |
| `get_medications_by_condition` | Medicamentos indicados para uma condição médica |
| `check_anvisa_registration` | Verifica validade do registro ANVISA |
| `list_therapeutic_classes` | Classes terapêuticas com contagem |

### Doenças e CID-10

| Ferramenta | Descrição |
|------------|-----------|
| `search_by_cid` | Busca doenças por código CID-10 (E11, J45) ou nome em português |
| `get_cid_info` | Detalhes de uma doença: subcategorias e medicamentos relacionados na base ANVISA |

---

## Como funciona

```text
Claude / Agente de IA
       │  MCP (stdio)
       ▼
  mcp-saude-br (este servidor)
       │
  Store em memória (42k medicamentos + 12k CIDs, índices em Map)
       │
  ┌────┼──────────────────┐
  │    │                  │
ANVISA  CMED         Bulário / CID-10 / consultaremedios
(CSV)  (CSV)         (HTTP com cache de arquivo)
```

**Estratégia de dados:** O CSV da ANVISA é carregado na inicialização e indexado em Maps para busca em menos de 1ms. A tabela CID-10 e os preços CMED são carregados em background sem bloquear o servidor. Caches locais evitam re-download a cada restart.

| Dado | Cache | Atualização automática |
|------|-------|------------------------|
| ANVISA CSV | 7 dias | Semanal (3h da manhã) |
| CMED preços | 30 dias | Mensal |
| CID-10 | 1 ano | Anual |

---

## Desenvolvimento local

```bash
# Clonar o repositório
git clone https://github.com/RodrigoFlorencio86/mcp-saude-br.git
cd mcp-saude-br

# Instalar dependências
npm install

# Compilar TypeScript
npm run build

# Testar com MCP Inspector (interface web interativa)
npm run inspect
```

### Exemplos no MCP Inspector

```json
{ "query": "dipirona", "limit": 5 }                          // search_medications
{ "active_ingredient": "metformina" }                         // list_generic_medications
{ "medication_name": "Metformina", "state": "SP" }            // check_price
{ "medication_name": "Dipirona Sódica" }                      // get_bula
{ "condition": "diabetes" }                                   // get_medications_by_condition
{ "registration_number": "1.0002.0001.001-9" }               // check_anvisa_registration
{ "query": "E11" }                                            // search_by_cid
{ "code_or_name": "asma" }                                    // get_cid_info
```

### Scripts disponíveis

```bash
npm run build       # Compila TypeScript → dist/
npm run dev         # Executa com tsx (sem compilar)
npm run inspect     # Abre MCP Inspector no browser
npm test            # Roda testes com Vitest
```

---

## Estrutura do projeto

```text
src/
├── index.ts              # Entry point
├── server.ts             # Servidor MCP + registro das 13 tools
├── config.ts             # URLs, TTLs e paths centralizados
├── data/
│   ├── types.ts          # Interfaces TypeScript (Medication, Cid10Entry…)
│   ├── store.ts          # Store em memória com 5 índices de busca
│   ├── cid10-store.ts    # Store CID-10 com índices por código e descrição
│   └── loader.ts         # Orquestra download + parse + refresh periódico
├── sources/
│   ├── anvisa-csv.ts     # Download e parse do CSV ANVISA Open Data
│   ├── cmed.ts           # Download e parse da tabela de preços CMED
│   ├── cid10.ts          # Download e parse da tabela CID-10 (DATASUS)
│   ├── bulario.ts        # Integração com o Bulário Eletrônico ANVISA
│   └── consultaremedios.ts  # Scraping de categorias (condições médicas)
├── http/
│   ├── client.ts         # Axios com retry + suporte a certificados ICP-Brasil
│   └── queue.ts          # Rate limiting por domínio (p-queue)
└── utils/
    ├── text.ts           # Normalização de texto PT-BR (acentos, tokenização)
    └── errors.ts         # Formatação de erros para o protocolo MCP
```

---

## Requisitos

- Node.js >= 18
- Conexão com a internet (para baixar dados na primeira execução)

---

## Licença

MIT — veja [LICENSE](LICENSE).

---

## Aviso

Este projeto não tem vínculo oficial com a ANVISA, CMED, DATASUS ou qualquer órgão do governo. Os dados são obtidos de fontes públicas abertas e podem estar defasados em relação aos portais oficiais. Para decisões clínicas, consulte sempre um profissional de saúde e verifique as fontes originais:

- [ANVISA Open Data](https://dados.anvisa.gov.br)
- [Bulário Eletrônico ANVISA](https://consultas.anvisa.gov.br/#/bulario)
- [CMED — Preços de Medicamentos](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos)
- [CID-10 DATASUS](http://www2.datasus.gov.br/cid10/V2008/download.htm)

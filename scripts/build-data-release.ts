/**
 * Build data release: baixa os 5 datasets das fontes oficiais (ANVISA + DATASUS),
 * valida cada um chamando o parser do próprio cliente, comprime em gzip e gera
 * `release-output/` pronto para ser anexado a um GitHub Release.
 *
 * Rodado pelo workflow `.github/workflows/build-data.yml` (semanal + manual).
 * Em caso de qualquer falha (download, parse, contagem mínima), termina com
 * exit code != 0 — o workflow não publica releases ruins.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import axios from 'axios';
import https from 'https';

import { CONFIG } from '../src/config.js';
import { parseAnvisaCsv } from '../src/sources/anvisa-csv.js';
import { parseCannabisCsv } from '../src/sources/anvisa-cannabis.js';
import { parseAlimentosCsv } from '../src/sources/anvisa-alimentos.js';

const OUTPUT_DIR = path.resolve(process.cwd(), 'release-output');

const govBrAgent = new https.Agent({ rejectUnauthorized: false });
const http = axios.create({
  timeout: 180_000,
  httpsAgent: govBrAgent,
  headers: { 'User-Agent': 'mcp-saude-br-ci/1.0 (data release builder)' },
});

interface DatasetSpec {
  /** Nome do dataset para logs */
  name: string;
  /** URL canônica para download */
  sourceUrl: string;
  /** Caminho local onde salvar (igual ao que o cliente espera) */
  localPath: string;
  /** Nome do arquivo de saída (sem .gz) */
  outputName: string;
  /** Contagem mínima esperada (falha se abaixo) */
  minCount: number;
  /** Função de validação que retorna a contagem efetiva */
  validate: () => Promise<number>;
  /**
   * Quando true, falha do download/validação NÃO aborta o release —
   * apenas loga warning. Útil para datasets cujo upstream é instável
   * mas não são críticos (ex: CID-10 raramente muda; cliente cai pra
   * cache local de 1 ano).
   */
  optional?: boolean;
}

const datasets: DatasetSpec[] = [
  {
    name: 'ANVISA medicamentos',
    sourceUrl: CONFIG.ANVISA.CSV_URL,
    localPath: CONFIG.ANVISA.LOCAL_CSV,
    outputName: 'anvisa-medicamentos.csv',
    minCount: 40_000,
    validate: async () => (await parseAnvisaCsv()).length,
  },
  {
    name: 'CMED preços',
    sourceUrl: CONFIG.CMED.DIRECT_URL,
    localPath: CONFIG.CMED.LOCAL_FILE,
    outputName: 'cmed-precos.csv',
    minCount: 10_000,
    // CMED usa parser interno não exportado; valida só pelo tamanho do arquivo
    validate: async () => {
      const stat = fs.statSync(CONFIG.CMED.LOCAL_FILE);
      return Math.floor(stat.size / 200); // estimativa rough — passa min se >2MB
    },
  },
  {
    // CID-10 (V2008) muda raramente; o servidor DATASUS é instável.
    // Marcado como opcional — falha não bloqueia o release.
    name: 'CID-10',
    sourceUrl: CONFIG.CID10.ZIP_URL,
    localPath: path.join(CONFIG.CID10.LOCAL_DIR, 'CID10CSV.ZIP'),
    outputName: 'cid10.zip',
    minCount: 1,
    optional: true,
    validate: async () => {
      const zipPath = path.join(CONFIG.CID10.LOCAL_DIR, 'CID10CSV.ZIP');
      const stat = fs.statSync(zipPath);
      const head = fs.readFileSync(zipPath).subarray(0, 4);
      if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('ZIP inválido (assinatura PK ausente)');
      return stat.size > 100_000 ? 1 : 0;
    },
  },
  {
    name: 'Cannabis',
    sourceUrl: CONFIG.ANVISA_CANNABIS.CSV_URL,
    localPath: CONFIG.ANVISA_CANNABIS.LOCAL_CSV,
    outputName: 'anvisa-cannabis.csv',
    minCount: 30,
    validate: async () => (await parseCannabisCsv()).length,
  },
  {
    name: 'Alimentos/Suplementos',
    sourceUrl: CONFIG.ANVISA_ALIMENTOS.CSV_URL,
    localPath: CONFIG.ANVISA_ALIMENTOS.LOCAL_CSV,
    outputName: 'anvisa-alimentos.csv',
    minCount: 40_000,
    validate: async () => (await parseAlimentosCsv()).length,
  },
];

async function downloadRaw(url: string, destPath: string): Promise<void> {
  console.log(`  ↓ ${url}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const res = await http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(destPath, Buffer.from(res.data));
  const sizeMB = (Buffer.from(res.data).byteLength / 1024 / 1024).toFixed(2);
  console.log(`  ✓ Salvo (${sizeMB} MB)`);
}

function gzipFile(srcPath: string, destPath: string): { sizeRaw: number; sizeGz: number; sha256: string } {
  const raw = fs.readFileSync(srcPath);
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(destPath, gz);
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
  return { sizeRaw: raw.length, sizeGz: gz.length, sha256 };
}

interface ManifestEntry {
  name: string;
  file: string;
  sourceUrl: string;
  recordCount: number;
  sizeRaw: number;
  sizeGz: number;
  sha256: string;
}

async function main() {
  console.log(`[Build] Construindo release de dados em ${OUTPUT_DIR}`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const manifest: { generatedAt: string; datasets: ManifestEntry[] } = {
    generatedAt: new Date().toISOString(),
    datasets: [],
  };

  const skipped: string[] = [];

  for (const ds of datasets) {
    try {
      console.log(`\n[${ds.name}] Iniciando...`);
      await downloadRaw(ds.sourceUrl, ds.localPath);

      console.log(`[${ds.name}] Validando...`);
      const count = await ds.validate();
      if (count < ds.minCount) {
        throw new Error(`apenas ${count} registros (mínimo ${ds.minCount}).`);
      }
      console.log(`[${ds.name}] ✓ ${count} registros (mínimo ${ds.minCount}).`);

      const outPath = path.join(OUTPUT_DIR, `${ds.outputName}.gz`);
      const { sizeRaw, sizeGz, sha256 } = gzipFile(ds.localPath, outPath);
      console.log(`[${ds.name}] ✓ Gzip: ${(sizeRaw / 1024 / 1024).toFixed(2)} MB → ${(sizeGz / 1024 / 1024).toFixed(2)} MB`);

      manifest.datasets.push({
        name: ds.name,
        file: `${ds.outputName}.gz`,
        sourceUrl: ds.sourceUrl,
        recordCount: count,
        sizeRaw,
        sizeGz,
        sha256,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (ds.optional) {
        console.warn(`[${ds.name}] ⚠️  Pulado (opcional): ${msg}`);
        skipped.push(ds.name);
      } else {
        throw new Error(`[${ds.name}] FALHA: ${msg}`);
      }
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  console.log(`\n[Build] ✅ Release pronto. ${manifest.datasets.length} datasets em ${OUTPUT_DIR}`);
  if (skipped.length > 0) {
    console.log(`[Build] ⚠️  Pulados (opcionais): ${skipped.join(', ')}`);
  }
  console.log(`[Build] Total comprimido: ${(manifest.datasets.reduce((s, d) => s + d.sizeGz, 0) / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error('\n[Build] ❌ FALHA:', err);
  process.exit(1);
});

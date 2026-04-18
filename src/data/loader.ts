import { isLocalCsvFresh, downloadAnvisaCsv, parseAnvisaCsv } from '../sources/anvisa-csv.js';
import { loadCmedPrices } from '../sources/cmed.js';
import { loadCid10 } from '../sources/cid10.js';
import {
  isLocalCannabisFresh,
  downloadCannabisCsv,
  parseCannabisCsv,
} from '../sources/anvisa-cannabis.js';
import {
  isLocalAlimentosFresh,
  downloadAlimentosCsv,
  parseAlimentosCsv,
} from '../sources/anvisa-alimentos.js';
import { medicationStore } from './store.js';
import { cid10Store } from './cid10-store.js';
import { cannabisStore } from './cannabis-store.js';
import { supplementsStore } from './supplements-store.js';

/**
 * Dispara o carregamento de todos os datasets em background. Esta função
 * NÃO bloqueia — retorna imediatamente. O servidor MCP sobe primeiro
 * (via `startServer()`) e responde `initialize`/`tools/list` normalmente
 * enquanto os dados ainda carregam. Tools que dependem de cada store
 * verificam o estado individualmente e respondem com mensagem amigável
 * "carregando..." ou "indisponível" quando o store ainda não está pronto.
 *
 * Decisão de design: NUNCA matar o processo por falha em download. Se
 * a ANVISA cair, o transport stdio permanece up — o usuário só perde
 * acesso ao dataset que falhou, não ao servidor inteiro.
 */
export function loadAllData(): void {
  // ── ANVISA CSV (background) ────────────────────────────────────
  loadMedications().catch(err => {
    console.error('[Loader] Falha ao carregar ANVISA medicamentos:', err.message);
    console.error('[Loader] Tools de medicamentos ficarão indisponíveis até o próximo refresh.');
    medicationStore.markFailed();
  });

  // ── CID-10 (background) ────────────────────────────────────────
  loadCid10()
    .then(entries => {
      if (entries.length > 0) cid10Store.load(entries);
    })
    .catch(err => {
      console.error('[Loader] Aviso: falha ao carregar tabela CID-10:', err.message);
      console.error('[Loader] Funcionalidades CID-10 indisponíveis.');
    });

  // ── CMED preços (background) ───────────────────────────────────
  loadCmedPrices()
    .then(priceMap => {
      if (priceMap.size > 0) {
        medicationStore.loadPrices(priceMap);
      }
    })
    .catch(err => {
      console.error('[Loader] Aviso: falha ao carregar preços CMED:', err.message);
      console.error('[Loader] Servidor operacional, mas dados de preço indisponíveis.');
    });

  // ── Cannabis (background) ──────────────────────────────────────
  loadCannabisProducts()
    .then(products => {
      if (products.length > 0) cannabisStore.load(products);
    })
    .catch(err => {
      console.error('[Loader] Aviso: falha ao carregar produtos cannabis:', err.message);
    });

  // ── Suplementos/Alimentos (background) ─────────────────────────
  loadSupplements()
    .then(supplements => {
      if (supplements.length > 0) supplementsStore.load(supplements);
    })
    .catch(err => {
      console.error('[Loader] Aviso: falha ao carregar suplementos:', err.message);
    });
}

async function loadMedications() {
  if (!isLocalCsvFresh()) {
    console.error('[Loader] CSV ANVISA ausente ou desatualizado. Baixando...');
    await downloadAnvisaCsv();
  } else {
    console.error('[Loader] CSV ANVISA em cache. Carregando localmente...');
  }
  const medications = await parseAnvisaCsv();
  medicationStore.load(medications);
}

async function loadCannabisProducts() {
  if (!isLocalCannabisFresh()) {
    await downloadCannabisCsv();
  } else {
    console.error('[Cannabis] Usando cache local.');
  }
  return parseCannabisCsv();
}

async function loadSupplements() {
  if (!isLocalAlimentosFresh()) {
    await downloadAlimentosCsv();
  } else {
    console.error('[Alimentos] Usando cache local.');
  }
  return parseAlimentosCsv();
}

/**
 * Agenda refresh dos dados usando intervalos seguros para Node.js no Windows
 * setInterval com valores > ~24.8 dias estoura int32; usamos 24h como intervalo base
 */
export function scheduleRefreshes(): void {
  // Verificar a cada 24h se é hora de atualizar
  // Node.js no Windows tem limite de ~24.8 dias para setInterval; usar 1 dia é seguro
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  let daysSinceAnvisaRefresh = 0;
  let daysSinceCmedRefresh = 0;
  let daysSinceCannabisRefresh = 0;
  let daysSinceAlimentosRefresh = 0;

  // Guards para evitar refreshes concorrentes (protege contra overflow de timer)
  let anvisaRefreshing = false;
  let cmedRefreshing = false;
  let cannabisRefreshing = false;
  let alimentosRefreshing = false;

  setInterval(async () => {
    daysSinceAnvisaRefresh++;
    daysSinceCmedRefresh++;
    daysSinceCannabisRefresh++;
    daysSinceAlimentosRefresh++;

    // Refresh ANVISA a cada 7 dias, na hora 3 da manhã
    if (daysSinceAnvisaRefresh >= 7 && !anvisaRefreshing) {
      const hour = new Date().getHours();
      if (hour === 3) {
        anvisaRefreshing = true;
        daysSinceAnvisaRefresh = 0;
        console.error('[Loader] Refresh semanal ANVISA iniciado...');
        try {
          await downloadAnvisaCsv();
          const medications = await parseAnvisaCsv();
          medicationStore.load(medications);
        } catch (err) {
          console.error('[Loader] Falha no refresh ANVISA:', err);
        } finally {
          anvisaRefreshing = false;
        }
      }
    }

    // Refresh CMED a cada 30 dias
    if (daysSinceCmedRefresh >= 30 && !cmedRefreshing) {
      cmedRefreshing = true;
      daysSinceCmedRefresh = 0;
      console.error('[Loader] Refresh mensal CMED iniciado...');
      try {
        const priceMap = await loadCmedPrices();
        if (priceMap.size > 0) medicationStore.loadPrices(priceMap);
      } catch (err) {
        console.error('[Loader] Falha no refresh CMED:', err);
      } finally {
        cmedRefreshing = false;
      }
    }

    // Refresh Cannabis a cada 7 dias
    if (daysSinceCannabisRefresh >= 7 && !cannabisRefreshing) {
      cannabisRefreshing = true;
      daysSinceCannabisRefresh = 0;
      console.error('[Loader] Refresh semanal Cannabis iniciado...');
      try {
        await downloadCannabisCsv();
        const products = await parseCannabisCsv();
        if (products.length > 0) cannabisStore.load(products);
      } catch (err) {
        console.error('[Loader] Falha no refresh Cannabis:', err);
      } finally {
        cannabisRefreshing = false;
      }
    }

    // Refresh Alimentos a cada 7 dias
    if (daysSinceAlimentosRefresh >= 7 && !alimentosRefreshing) {
      alimentosRefreshing = true;
      daysSinceAlimentosRefresh = 0;
      console.error('[Loader] Refresh semanal Alimentos iniciado...');
      try {
        await downloadAlimentosCsv();
        const supplements = await parseAlimentosCsv();
        if (supplements.length > 0) supplementsStore.load(supplements);
      } catch (err) {
        console.error('[Loader] Falha no refresh Alimentos:', err);
      } finally {
        alimentosRefreshing = false;
      }
    }
  }, ONE_DAY_MS);
}

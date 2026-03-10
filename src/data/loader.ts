import { isLocalCsvFresh, downloadAnvisaCsv, parseAnvisaCsv } from '../sources/anvisa-csv.js';
import { loadCmedPrices } from '../sources/cmed.js';
import { loadCid10 } from '../sources/cid10.js';
import { medicationStore } from './store.js';
import { cid10Store } from './cid10-store.js';

/**
 * Orquestra o carregamento completo dos dados:
 * 1. ANVISA CSV (bloqueante — necessário antes de aceitar requisições)
 * 2. CMED preços (não-bloqueante — enriquece em background)
 */
export async function loadAllData(): Promise<void> {
  // ── Fase 1: ANVISA CSV (obrigatório) ──────────────────────────
  try {
    if (!isLocalCsvFresh()) {
      console.error('[Loader] CSV ANVISA ausente ou desatualizado. Baixando...');
      await downloadAnvisaCsv();
    } else {
      console.error('[Loader] CSV ANVISA em cache. Carregando localmente...');
    }

    const medications = await parseAnvisaCsv();
    medicationStore.load(medications);
  } catch (error) {
    console.error('[Loader] ERRO CRÍTICO ao carregar dados ANVISA:', error);
    throw error; // Sem dados ANVISA o servidor não pode funcionar
  }

  // ── Fase 2: CID-10 (background, não-bloqueante) ───────────────
  loadCid10()
    .then(entries => {
      if (entries.length > 0) cid10Store.load(entries);
    })
    .catch(err => {
      console.error('[Loader] Aviso: falha ao carregar tabela CID-10:', err.message);
      console.error('[Loader] Funcionalidades CID-10 indisponíveis.');
    });

  // ── Fase 3: CMED preços (background, não-bloqueante) ──────────
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

  // Guards para evitar refreshes concorrentes (protege contra overflow de timer)
  let anvisaRefreshing = false;
  let cmedRefreshing = false;

  setInterval(async () => {
    daysSinceAnvisaRefresh++;
    daysSinceCmedRefresh++;

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
  }, ONE_DAY_MS);
}

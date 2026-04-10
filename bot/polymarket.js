const axios = require('axios');

class PolymarketFeed {
  constructor(state, config) {
    this.state = state;
    this.config = config;
    this.gammaApi = config.POLYMARKET_GAMMA_API || 'https://gamma-api.polymarket.com';
    this.clobApi = config.POLYMARKET_CLOB_API || 'https://clob.polymarket.com';
    this.cache = {};
    this.cacheTTL = 4000; // 4s cache — Polymarket data is already 3-7s stale
    this.pollInterval = null;
    this.running = false;
    this.slotDuration = config.SLOT_DURATION || 900; // 15-min default
    this._concurrentLimit = 3; // Max concurrent Polymarket fetches
  }

  start() {
    this.running = true;
    this.state.updateConnection('polymarket', false); // Set true once data arrives

    // Poll every 4 seconds — Polymarket lags 3-7s anyway
    this.pollInterval = setInterval(() => this.pollActiveMarkets(), 4000);
    console.log('[PolymarketFeed] Started polling (4s interval)');
  }

  // Get the Polymarket slug for a given Kalshi close time and coin.
  getSlug(closeTimeMs, coin = 'btc') {
    const slotStartSec = Math.floor((closeTimeMs - this.slotDuration * 1000) / 1000);
    const rounded = Math.floor(slotStartSec / this.slotDuration) * this.slotDuration;
    const prefix = this.slotDuration === 300 ? '5m' : '15m';
    const normalizedCoin = String(coin || 'btc').toLowerCase();
    return `${normalizedCoin}-updown-${prefix}-${rounded}`;
  }

  async fetchPrice(closeTimeMs, coin = 'btc') {
    const slug = this.getSlug(closeTimeMs, coin);

    // Check cache
    const cached = this.cache[slug];
    if (cached && Date.now() - cached.fetchedAt < this.cacheTTL) {
      return cached.data;
    }

    try {
      // Get event from Gamma API
      const eventResp = await axios.get(`${this.gammaApi}/events`, {
        params: { slug },
        timeout: 5000,
      });

      if (!eventResp.data || eventResp.data.length === 0) {
        // Only log occasionally to avoid spam
        if (!this._lastSlugWarn || Date.now() - this._lastSlugWarn > 30000) {
          console.log(`[PolymarketFeed] No event found for slug: ${slug}`);
          this._lastSlugWarn = Date.now();
        }
        return null;
      }

      const event = eventResp.data[0];
      const market = event.markets?.[0];

      if (!market || !market.clobTokenIds) {
        if (!this._lastSlugWarn || Date.now() - this._lastSlugWarn > 30000) {
          console.log(`[PolymarketFeed] Event found but no market/tokens for slug: ${slug}`);
          this._lastSlugWarn = Date.now();
        }
        return null;
      }

      const tokenIds = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;

      const upTokenId = tokenIds[0];
      const downTokenId = tokenIds[1];

      // Get live CLOB prices for both UP and DOWN
      const [upBuyResp, upSellResp, downBuyResp, downSellResp] = await Promise.all([
        axios.get(`${this.clobApi}/price`, { params: { token_id: upTokenId, side: 'buy' }, timeout: 5000 }),
        axios.get(`${this.clobApi}/price`, { params: { token_id: upTokenId, side: 'sell' }, timeout: 5000 }),
        axios.get(`${this.clobApi}/price`, { params: { token_id: downTokenId, side: 'buy' }, timeout: 5000 }),
        axios.get(`${this.clobApi}/price`, { params: { token_id: downTokenId, side: 'sell' }, timeout: 5000 }),
      ]);

      const upBuy = parseFloat(upBuyResp.data.price);
      const upSell = parseFloat(upSellResp.data.price);
      const downBuy = parseFloat(downBuyResp.data.price);
      const downSell = parseFloat(downSellResp.data.price);

      const result = {
        slug,
        upBuy,
        upSell,
        upMid: (upBuy + upSell) / 2,
        downBuy,
        downSell,
        downMid: (downBuy + downSell) / 2,
        combinedMid: (upBuy + upSell) / 2 + (downBuy + downSell) / 2,
        upTokenId,
        downTokenId,
        volume: parseFloat(market.volume || 0),
        active: market.active && !market.closed,
        fetchedAt: Date.now(),
      };

      this.cache[slug] = { data: result, fetchedAt: Date.now() };
      this.state.updateConnection('polymarket', true);
      return result;

    } catch (error) {
      // Log errors occasionally to help debug
      if (!this._lastErrLog || Date.now() - this._lastErrLog > 30000) {
        console.log(`[PolymarketFeed] Fetch error for ${slug}: ${error.message}`);
        this._lastErrLog = Date.now();
      }
      // Return cached if available, even stale
      if (cached) return cached.data;
      return null;
    }
  }

  // Poll all active Kalshi markets for Polymarket prices — parallel with concurrency limit
  async pollActiveMarkets() {
    if (!this.running) return;

    const markets = this.state.activeMarkets;
    if (!markets || markets.length === 0) return;

    // Deduplicate by slug (multiple Kalshi markets may map to same Poly slug)
    const slugsSeen = new Set();
    const uniqueCloseTimes = [];
    for (const market of markets) {
      const coin = this.state.getCoinFromTicker ? this.state.getCoinFromTicker(market.ticker).toLowerCase() : 'btc';
      const slug = this.getSlug(market.closeTime, coin);
      if (!slugsSeen.has(slug)) {
        slugsSeen.add(slug);
        uniqueCloseTimes.push({ closeTime: market.closeTime, coin });
      }
    }

    // Fetch all in parallel with concurrency limit
    const results = await this._parallelLimit(
      uniqueCloseTimes.map(item => () => this.fetchPrice(item.closeTime, item.coin)),
      this._concurrentLimit
    );

    // If any fetch succeeded, mark connection as up
    const anySuccess = results.some(r => r !== null);
    this.state.updateConnection('polymarket', anySuccess);
  }

  // Simple concurrency limiter — runs fns with at most `limit` concurrent
  async _parallelLimit(fns, limit) {
    const results = [];
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, fns.length) }, async () => {
      while (idx < fns.length) {
        const i = idx++;
        try {
          results[i] = await fns[i]();
        } catch {
          results[i] = null;
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  // Get cached price for a close time (no network call)
  getCachedPrice(closeTimeMs, coin = 'btc') {
    const slug = this.getSlug(closeTimeMs, coin);
    return this.cache[slug]?.data || null;
  }

  stop() {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

module.exports = PolymarketFeed;

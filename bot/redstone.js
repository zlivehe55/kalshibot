const axios = require('axios');

class RedstoneFeed {
  constructor(state) {
    this.state = state;
    this.pollInterval = null;
    this.running = false;
    this.lastPrice = null;
    this.lastTimestamp = null;

    // RedStone gateway endpoints for direct data package fetching
    this.gateways = [
      'https://oracle-gateway-1.a.redstone.finance',
      'https://oracle-gateway-2.a.redstone.finance',
    ];
  }

  start() {
    this.running = true;
    // Poll every 3 seconds
    this.fetchPrice();
    this.pollInterval = setInterval(() => this.fetchPrice(), 3000);
    console.log('[RedstoneFeed] Started polling (3s interval)');
  }

  async fetchPrice() {
    if (!this.running) return;

    // Try gateway API for fast signed data
    for (const gateway of this.gateways) {
      try {
        const resp = await axios.get(
          `${gateway}/data-packages/latest/redstone-primary-prod`,
          {
            params: { symbol: 'BTC', symbols: 'BTC' },
            timeout: 3000,
          }
        );

        // Response is { BTC: [{ dataPoints: [...], timestampMilliseconds: ... }] }
        const packages = resp.data?.BTC || resp.data?.['BTC'];
        if (packages && packages.length > 0) {
          // Take median of available signers
          const prices = packages
            .map(pkg => {
              if (pkg.dataPoints?.[0]?.value) return pkg.dataPoints[0].value;
              if (pkg.value) return pkg.value;
              return null;
            })
            .filter(p => p !== null);

          if (prices.length > 0) {
            prices.sort((a, b) => a - b);
            const median = prices[Math.floor(prices.length / 2)];
            const timestamp = packages[0].timestampMilliseconds || Date.now();

            this.lastPrice = median;
            this.lastTimestamp = timestamp;
            this.state.updateRedstonePrice(median, timestamp);
            return;
          }
        }
      } catch (err) {
        // Try next gateway
      }
    }

    // Fallback: simple HTTP price API
    try {
      const resp = await axios.get(
        'https://api.redstone.finance/prices?symbol=BTC&provider=redstone&limit=1',
        { timeout: 3000 }
      );

      if (resp.data && resp.data.length > 0) {
        const price = resp.data[0].value;
        const timestamp = resp.data[0].timestamp;
        this.lastPrice = price;
        this.lastTimestamp = timestamp;
        this.state.updateRedstonePrice(price, timestamp);
      }
    } catch (err) {
      // All sources failed, stay with last known price
      this.state.connections.redstone = false;
    }
  }

  stop() {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

module.exports = RedstoneFeed;

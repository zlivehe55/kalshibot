/**
 * BinancePriceFeed Skill
 *
 * Wraps the existing BinanceFeed as an agent skill.
 * Provides real-time BTC spot pricing via WebSocket with REST fallback.
 *
 * Capabilities: get-binance-price, get-volatility, get-price-history
 */

const BaseSkill = require('../../core/base-skill');
const BinanceFeed = require('../../../bot/binance-ws');

class BinancePriceFeed extends BaseSkill {
  constructor() {
    super({
      name: 'binance-price-feed',
      description: 'Real-time BTC spot price from Binance via WebSocket with REST fallback',
      domain: 'market-data',
      capabilities: ['get-binance-price', 'get-volatility', 'get-price-history'],
      dependencies: ['state-manager'],
    });

    this.feeds = new Map();
    this.primarySymbol = 'btcusdt';
  }

  async initialize(context) {
    await super.initialize(context);
    const stateManager = context.registry.get('state-manager');
    const configured = Array.isArray(context.config.SUPPORTED_SPOT_SYMBOLS)
      ? context.config.SUPPORTED_SPOT_SYMBOLS
      : [];
    const symbols = configured.length > 0
      ? configured.map(s => String(s).toLowerCase())
      : ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'dogeusdt'];

    for (const symbol of symbols) {
      this.feeds.set(symbol, new BinanceFeed(stateManager.botState, symbol));
    }
  }

  async start() {
    await super.start();
    for (const feed of this.feeds.values()) {
      feed.start();
    }
  }

  async handleTask(task) {
    switch (task.action) {
      case 'get-binance-price': {
        const stateManager = this.context.registry.get('state-manager');
        const symbol = String(task.params?.symbol || this.primarySymbol).toLowerCase();
        const spot = stateManager.botState.spotPrices?.[symbol] || null;
        return {
          symbol,
          price: spot?.mid || stateManager.botState.btcPrice.binance,
          bid: spot?.bid || stateManager.botState.btcPrice.binanceBid,
          ask: spot?.ask || stateManager.botState.btcPrice.binanceAsk,
          lastUpdate: spot?.lastUpdate || stateManager.botState.btcPrice.lastUpdate,
        };
      }

      case 'get-volatility': {
        const windowSeconds = task.params?.windowSeconds || 300;
        const symbol = String(task.params?.symbol || this.primarySymbol).toLowerCase();
        const feed = this.feeds.get(symbol) || this.feeds.get(this.primarySymbol);
        return { symbol, volatility: feed ? feed.getRecentVolatility(windowSeconds) : 0.0015 };
      }

      case 'get-price-history': {
        const symbol = String(task.params?.symbol || this.primarySymbol).toLowerCase();
        const feed = this.feeds.get(symbol) || this.feeds.get(this.primarySymbol);
        return { symbol, history: feed ? feed.priceHistory : [] };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  /**
   * Direct access to the underlying feed (for skills that need it).
   */
  getFeed() {
    return this.feeds.get(this.primarySymbol) || null;
  }

  getFeedBySymbol(symbol) {
    const key = String(symbol || this.primarySymbol).toLowerCase();
    return this.feeds.get(key) || this.getFeed();
  }

  async stop() {
    for (const feed of this.feeds.values()) {
      feed.stop();
    }
    await super.stop();
  }
}

module.exports = BinancePriceFeed;

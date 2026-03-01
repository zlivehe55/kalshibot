/**
 * 1-Hour Trend Indicator
 *
 * Dual EMA crossover (12min fast / 45min slow) confirmed by 30-min Rate of Change.
 * Provides a BULLISH / BEARISH / NEUTRAL signal used to modulate directional trade edge.
 *
 * - O(1) incremental EMA updates (called every ~1 sec from BinanceFeed.recordPrice)
 * - ROC reads from BinanceFeed.priceHistory (already stored)
 * - Cold start: returns NEUTRAL until 50% of slow EMA period has elapsed (~22 min)
 */

class TrendIndicator {
  constructor(binanceFeed, config = {}) {
    this.binanceFeed = binanceFeed;

    // Configurable periods (in seconds, since we sample once per second)
    this.fastPeriodSec = config.TREND_FAST_PERIOD || 720;    // 12 min
    this.slowPeriodSec = config.TREND_SLOW_PERIOD || 2700;   // 45 min
    this.rocWindowSec  = config.TREND_ROC_WINDOW  || 1800;   // 30 min
    this.rocThreshold  = config.TREND_ROC_THRESHOLD || 0.02; // 0.02%

    // EMA smoothing constants
    this.fastK = 2 / (this.fastPeriodSec + 1);
    this.slowK = 2 / (this.slowPeriodSec + 1);

    // Running EMA state (seeded on first price)
    this.fastEMA = null;
    this.slowEMA = null;

    // Tracking
    this.samplesProcessed = 0;
    this.lastUpdateTime = 0;
  }

  /**
   * Called once per second from BinanceFeed.recordPrice().
   * Updates both EMAs incrementally — O(1).
   */
  update(price) {
    if (this.fastEMA === null) {
      // Seed EMAs with first price
      this.fastEMA = price;
      this.slowEMA = price;
    } else {
      this.fastEMA = price * this.fastK + this.fastEMA * (1 - this.fastK);
      this.slowEMA = price * this.slowK + this.slowEMA * (1 - this.slowK);
    }

    this.samplesProcessed++;
    this.lastUpdateTime = Date.now();
  }

  /**
   * Compute Rate of Change by looking back into BinanceFeed's priceHistory.
   */
  _computeROC() {
    const history = this.binanceFeed.priceHistory;
    if (!history || history.length < 2) return 0;

    const now = Date.now();
    const cutoff = now - this.rocWindowSec * 1000;

    // Find the oldest entry within the ROC window
    let pastPrice = null;
    for (let i = 0; i < history.length; i++) {
      if (history[i].timestamp >= cutoff) {
        pastPrice = history[i].price;
        break;
      }
    }

    if (!pastPrice) return 0;

    const currentPrice = history[history.length - 1].price;
    return ((currentPrice - pastPrice) / pastPrice) * 100;
  }

  /**
   * Returns current trend state.
   */
  getTrend() {
    const warmup = this.samplesProcessed >= this.slowPeriodSec * 0.5;
    const roc = this._computeROC();

    // During warmup, always NEUTRAL
    if (!warmup || this.fastEMA === null || this.slowEMA === null) {
      return {
        trend: 'NEUTRAL',
        strength: 0,
        roc,
        fastEMA: this.fastEMA,
        slowEMA: this.slowEMA,
        warmup: false,
      };
    }

    // EMA crossover direction
    const emaBullish = this.fastEMA > this.slowEMA;
    const emaBearish = this.fastEMA < this.slowEMA;

    // ROC confirmation
    const rocBullish = roc > this.rocThreshold;
    const rocBearish = roc < -this.rocThreshold;

    // Both must agree
    let trend = 'NEUTRAL';
    if (emaBullish && rocBullish) trend = 'BULLISH';
    else if (emaBearish && rocBearish) trend = 'BEARISH';

    // Strength: normalized EMA spread (how far apart the EMAs are as % of price)
    const spread = Math.abs(this.fastEMA - this.slowEMA) / this.slowEMA;
    const strength = Math.min(spread / 0.005, 1.0); // 0.5% spread = full strength

    return {
      trend,
      strength,
      roc,
      fastEMA: this.fastEMA,
      slowEMA: this.slowEMA,
      warmup: true,
    };
  }
}

module.exports = TrendIndicator;

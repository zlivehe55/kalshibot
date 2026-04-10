/**
 * SignalGenerator Skill
 *
 * Generates trading signals by composing probability model, trend analysis,
 * and cross-market price data. This is the analysis "brain" that identifies
 * trading opportunities across three strategies:
 *
 *  1. DIRECTIONAL — Binance spot divergence from Kalshi contract price
 *  2. POLY_ARB    — Polymarket fair value exceeds Kalshi ask
 *  3. DUAL_SIDE   — YES + NO ask < $1 (guaranteed profit)
 *
 * Also generates take-profit signals for open positions.
 *
 * Capabilities: generate-signals, generate-take-profit-signals
 */

const BaseSkill = require('../../core/base-skill');

class SignalGenerator extends BaseSkill {
  constructor() {
    super({
      name: 'signal-generator',
      description: 'Generates trading signals from market data, probability model, and trend analysis',
      domain: 'analysis',
      capabilities: ['generate-signals', 'generate-take-profit-signals'],
      dependencies: ['state-manager', 'binance-price-feed', 'polymarket-price-feed', 'probability-model', 'trend-analysis'],
    });

    // Configured in initialize()
    this.minEdge = 10.0;
    this.minDivergence = 10.0;
    this.kellyFraction = 0.25;
    this.useKelly = true;
    this.maxPositionSize = 25;
    this.hardMaxPositionSize = 1.5;
    this.maxEdgeAcceptance = 30;
    this.disabledCoins = new Set(['DOGE']);
    this.coinEdgeMultipliers = { BTC: 0.75 };
    this.takeProfitAggressivePct = 50;
    this.takeProfitHoldThreshold = 0.90;
    this.tradingWindow = 4 * 60 * 1000;
    this.minContractPrice = 0.48;
    this.maxContractPrice = 0.88;
  }

  async initialize(context) {
    await super.initialize(context);
    const config = context.config;

    this.minEdge = config.MIN_EDGE || 10.0;
    this.minDivergence = config.MIN_DIVERGENCE || 10.0;
    this.kellyFraction = config.KELLY_FRACTION || 0.25;
    this.useKelly = config.USE_KELLY_SIZING !== false;
    this.maxPositionSize = config.MAX_POSITION_SIZE || 25;
    this.hardMaxPositionSize = Math.min(1.5, this.maxPositionSize);
    this.maxEdgeAcceptance = 30;
    this.disabledCoins = new Set(
      (Array.isArray(config.DISABLED_COINS) ? config.DISABLED_COINS : ['DOGE'])
        .map(c => String(c).toUpperCase())
    );
    this.coinEdgeMultipliers = {
      BTC: 0.75,
      ...(config.COIN_EDGE_MULTIPLIERS || {}),
    };
    this.takeProfitAggressivePct = Number.isFinite(config.TAKE_PROFIT_AGGRESSIVE_PCT)
      ? config.TAKE_PROFIT_AGGRESSIVE_PCT
      : 50;
    const holdCents = Number.isFinite(config.TAKE_PROFIT_HOLD_CENTS)
      ? config.TAKE_PROFIT_HOLD_CENTS
      : 90;
    this.takeProfitHoldThreshold = holdCents / 100;
    this.tradingWindow = (config.TRADING_WINDOW || 4) * 60 * 1000;
    this.minContractPrice = (config.MIN_CONTRACT_PRICE || 48) / 100;
    this.maxContractPrice = (config.MAX_CONTRACT_PRICE || 88) / 100;
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'generate-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const { signals, stats } = this._generateSignals(markets, state);
        return { signals, signalStats: stats };
      }

      case 'generate-take-profit-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const takeProfitSignals = this._generateTakeProfitSignals(state.openPositions, markets);
        return { takeProfitSignals };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  _edgeBucket(edge) {
    if (!Number.isFinite(edge)) return 'unknown';
    if (edge < 15) return '0-15';
    if (edge < 30) return '15-30';
    return '30+';
  }

  _isDisabledBucket(state, signalType, edge) {
    const bucket = this._edgeBucket(edge);
    const key = `${signalType}|${bucket}`;
    return !!state?.stats?.edgeBucketStats?.[key]?.disabled;
  }

  _contractsForPrice(priceDecimal, desiredDollars) {
    if (!Number.isFinite(priceDecimal) || priceDecimal <= 0) return 0;
    const maxByHardCap = Math.min(Math.floor(this.hardMaxPositionSize / priceDecimal), 3);
    if (maxByHardCap <= 0) return 0;
    const fromDesired = Math.floor(desiredDollars / priceDecimal);
    return Math.max(1, Math.min(fromDesired, maxByHardCap));
  }

  _generateSignals(kalshiMarkets, state) {
    const signals = [];
    const stats = {
      totalMarkets: kalshiMarkets.length,
      consideredMarkets: 0,
      skippedWindow: 0,
      skippedClosingSoon: 0,
      skippedMissingOpenPrice: 0,
      skippedMissingQuotes: 0,
      skippedPriceRange: 0,
      skippedDisabledCoin: 0,
      skippedEdgeTooHigh: 0,
      skippedDisabledBucket: 0,
      bestEdgeYes: null,
      bestEdgeNo: null,
      bestPolyEdgeYes: null,
      generatedSignals: 0,
      tradingWindowMin: Math.round(this.tradingWindow / 60000),
      minDivergence: this.minDivergence,
      minEdge: this.minEdge,
      adaptiveCap: 0,
    };
    const adaptivePositionCap = this.hardMaxPositionSize;
    stats.adaptiveCap = adaptivePositionCap;
    const now = Date.now();
    const probModel = this.context.registry.get('probability-model');
    const trendSkill = this.context.registry.get('trend-analysis');
    const polySkill = this.context.registry.get('polymarket-price-feed');
    const binanceSkill = this.context.registry.get('binance-price-feed');

    for (const market of kalshiMarkets) {
      stats.consideredMarkets++;
      const timeRemaining = market.closeTime - now;
      const totalDuration = market.closeTime - market.openTime;
      const timeSinceOpen = now - market.openTime;

      if (timeSinceOpen > this.tradingWindow) {
        stats.skippedWindow++;
        continue;
      }
      if (timeRemaining < 30000) {
        stats.skippedClosingSoon++;
        continue;
      }

      const openPrice = state.marketOpenPrices[market.ticker];
      if (!openPrice) {
        stats.skippedMissingOpenPrice++;
        continue;
      }
      if (!market.yesAsk || !market.noAsk) {
        stats.skippedMissingQuotes++;
        continue;
      }

      const yesInRange = market.yesAsk >= this.minContractPrice && market.yesAsk <= this.maxContractPrice;
      const noInRange = market.noAsk >= this.minContractPrice && market.noAsk <= this.maxContractPrice;
      if (!yesInRange && !noInRange) {
        stats.skippedPriceRange++;
      }

      const coin = state.getCoinFromTicker ? state.getCoinFromTicker(market.ticker).toLowerCase() : 'btc';
      const coinUpper = coin.toUpperCase();
      if (this.disabledCoins.has(coinUpper)) {
        stats.skippedDisabledCoin++;
        continue;
      }
      const coinEdgeMult = Number.isFinite(this.coinEdgeMultipliers[coinUpper])
        ? this.coinEdgeMultipliers[coinUpper]
        : 1;
      const spotPrice = state.getSpotPriceForTicker ? state.getSpotPriceForTicker(market.ticker) : state.btcPrice.binance;
      if (!spotPrice) {
        stats.reason = 'no_spot_price';
        continue;
      }
      const spotSymbol = state.getSpotFeedSymbolForTicker
        ? state.getSpotFeedSymbolForTicker(market.ticker)
        : 'btcusdt';
      const binanceFeed = binanceSkill.getFeedBySymbol
        ? binanceSkill.getFeedBySymbol(spotSymbol)
        : binanceSkill.getFeed();

      // Get Polymarket cross-reference
      const poly = polySkill.getCachedPrice(market.closeTime, coin);

      // Calculate model probability
      const prob = probModel.calculateImpliedProbability(spotPrice, openPrice, timeRemaining, totalDuration, binanceFeed);

      // Get trend data
      const trendData = trendSkill.getIndicator() ? trendSkill.getIndicator().getTrend() : {};

      // Update state model for UI
      state.updateModel({
        impliedProbUp: prob.probUp,
        impliedProbDown: prob.probDown,
        spotMove: prob.move,
        spotMovePct: prob.movePct,
        timeRemaining: timeRemaining / 1000,
        volatility: prob.sigma,
        trend: trendData.trend || 'NEUTRAL',
        trendStrength: trendData.strength || 0,
        trendROC: trendData.roc || 0,
        trendWarmup: trendData.warmup || false,
      });

      // ===== STRATEGY 1: DIRECTIONAL =====
      const kalshiYesImplied = market.yesAsk;
      const modelEdgeYes = (prob.probUp - kalshiYesImplied) * 100;
      const modelEdgeNo = (prob.probDown - market.noAsk) * 100;
      if (stats.bestEdgeYes === null || modelEdgeYes > stats.bestEdgeYes) stats.bestEdgeYes = modelEdgeYes;
      if (stats.bestEdgeNo === null || modelEdgeNo > stats.bestEdgeNo) stats.bestEdgeNo = modelEdgeNo;

      const trendMultYes = trendSkill.getTrendMultiplier('yes');
      const trendMultNo = trendSkill.getTrendMultiplier('no');
      const adjustedEdgeYes = modelEdgeYes * trendMultYes * coinEdgeMult;
      const adjustedEdgeNo = modelEdgeNo * trendMultNo * coinEdgeMult;
      const currentTrend = trendData.trend || 'NEUTRAL';

      if (adjustedEdgeYes > this.minDivergence && yesInRange) {
        if (adjustedEdgeYes > this.maxEdgeAcceptance) {
          stats.skippedEdgeTooHigh++;
          continue;
        }
        if (this._isDisabledBucket(state, 'DIRECTIONAL_YES', adjustedEdgeYes)) {
          stats.skippedDisabledBucket++;
          continue;
        }
        const size = this.useKelly ? probModel.kellySize(adjustedEdgeYes / 100, prob.probUp, this.kellyFraction) : 1;
        const positionDollars = Math.min(size * state.balance.available, adaptivePositionCap, state.balance.available);
        const contracts = this._contractsForPrice(market.yesAsk, positionDollars);
        if (contracts <= 0) continue;

        signals.push({
          type: 'DIRECTIONAL_YES', ticker: market.ticker, side: 'yes',
          priceCents: market.yesAskCents || Math.round(market.yesAsk * 100),
          priceDecimal: market.yesAsk, edge: adjustedEdgeYes, contracts,
          modelProb: prob.probUp,
          reason: `Spot +${(prob.movePct || 0).toFixed(3)}% | Model ${(prob.probUp * 100).toFixed(0)}% vs Kalshi ${(kalshiYesImplied * 100).toFixed(0)}% | 1H: ${currentTrend}${trendMultYes !== 1.0 ? ' (' + trendMultYes.toFixed(2) + 'x)' : ''}`,
          closeTime: market.closeTime, executionMode: 'taker',
        });
      }

      if (adjustedEdgeNo > this.minDivergence && noInRange) {
        if (adjustedEdgeNo > this.maxEdgeAcceptance) {
          stats.skippedEdgeTooHigh++;
          continue;
        }
        if (this._isDisabledBucket(state, 'DIRECTIONAL_NO', adjustedEdgeNo)) {
          stats.skippedDisabledBucket++;
          continue;
        }
        const size = this.useKelly ? probModel.kellySize(adjustedEdgeNo / 100, prob.probDown, this.kellyFraction) : 1;
        const positionDollars = Math.min(size * state.balance.available, adaptivePositionCap, state.balance.available);
        const contracts = this._contractsForPrice(market.noAsk, positionDollars);
        if (contracts <= 0) continue;

        signals.push({
          type: 'DIRECTIONAL_NO', ticker: market.ticker, side: 'no',
          priceCents: market.noAskCents || Math.round(market.noAsk * 100),
          priceDecimal: market.noAsk, edge: adjustedEdgeNo, contracts,
          modelProb: prob.probDown,
          reason: `Spot ${(prob.movePct || 0).toFixed(3)}% | Model ${(prob.probDown * 100).toFixed(0)}% vs Kalshi ${(market.noAsk * 100).toFixed(0)}% | 1H: ${currentTrend}${trendMultNo !== 1.0 ? ' (' + trendMultNo.toFixed(2) + 'x)' : ''}`,
          closeTime: market.closeTime, executionMode: 'taker',
        });
      }

      // ===== STRATEGY 2: POLYMARKET ARBITRAGE =====
      if (poly) {
        const polyEdgeYes = (poly.upMid - market.yesAsk) * 100 * coinEdgeMult;
        if (stats.bestPolyEdgeYes === null || polyEdgeYes > stats.bestPolyEdgeYes) stats.bestPolyEdgeYes = polyEdgeYes;
        if (polyEdgeYes > this.minEdge * 1.5 && yesInRange) {
          if (polyEdgeYes > this.maxEdgeAcceptance) {
            stats.skippedEdgeTooHigh++;
            continue;
          }
          if (this._isDisabledBucket(state, 'POLY_ARB_YES', polyEdgeYes)) {
            stats.skippedDisabledBucket++;
            continue;
          }
          const size = this.useKelly ? probModel.kellySize(polyEdgeYes / 100, poly.upMid, this.kellyFraction) : 1;
          const positionDollars = Math.min(size * state.balance.available, adaptivePositionCap, state.balance.available);
          const contracts = this._contractsForPrice(market.yesAsk, positionDollars);
          if (contracts <= 0) continue;

          signals.push({
            type: 'POLY_ARB_YES', ticker: market.ticker, side: 'yes',
            priceCents: market.yesAskCents || Math.round(market.yesAsk * 100),
            priceDecimal: market.yesAsk, edge: polyEdgeYes, contracts,
            modelProb: poly.upMid,
            reason: `Poly UP mid=${(poly.upMid * 100).toFixed(1)}% vs Kalshi ask=${(market.yesAsk * 100).toFixed(1)}%`,
            closeTime: market.closeTime, executionMode: 'taker',
          });
        }
      }

      // ===== STRATEGY 3: DUAL-SIDE ARBITRAGE =====
      const combinedCost = market.yesAsk + market.noAsk;
      if (combinedCost < 0.98) {
        const guaranteedProfit = (1 - combinedCost) * 100;
        const positionDollars = Math.min(adaptivePositionCap, state.balance.available);
        const contracts = this._contractsForPrice(Math.max(market.yesAsk, market.noAsk), positionDollars);
        if (contracts <= 0) continue;

        signals.push({
          type: 'DUAL_SIDE_YES', ticker: market.ticker, side: 'yes',
          priceCents: Math.round(market.yesAsk * 100), priceDecimal: market.yesAsk,
          edge: guaranteedProfit, contracts, modelProb: prob.probUp,
          reason: `Dual-side: YES@${(market.yesAsk * 100).toFixed(0)} + NO@${(market.noAsk * 100).toFixed(0)} = ${(combinedCost * 100).toFixed(0)}c < $1`,
          closeTime: market.closeTime, isDualSide: true, executionMode: 'taker',
        });

        signals.push({
          type: 'DUAL_SIDE_NO', ticker: market.ticker, side: 'no',
          priceCents: Math.round(market.noAsk * 100), priceDecimal: market.noAsk,
          edge: guaranteedProfit, contracts, modelProb: prob.probDown,
          reason: `Dual-side: YES@${(market.yesAsk * 100).toFixed(0)} + NO@${(market.noAsk * 100).toFixed(0)} = ${(combinedCost * 100).toFixed(0)}c < $1`,
          closeTime: market.closeTime, isDualSide: true, executionMode: 'taker',
        });
      }
    }

    signals.sort((a, b) => b.edge - a.edge);
    stats.generatedSignals = signals.length;
    return { signals, stats };
  }

  _generateTakeProfitSignals(openPositions, kalshiMarkets) {
    const signals = [];

    for (const pos of openPositions) {
      const filledContracts = Number(pos.filledContracts || 0);
      if (!Number.isFinite(filledContracts) || filledContracts <= 0) continue;

      const market = kalshiMarkets.find(m => m.ticker === pos.ticker);
      if (!market) continue;

      const now = Date.now();
      const timeRemaining = pos.closeTime - now;
      if (timeRemaining < 30000) continue;

      const currentValue = pos.side === 'yes' ? market.yesBid : market.noBid;
      const entryPrice = pos.priceDecimal;

      if (!currentValue || currentValue <= 0) continue;

      const profitPct = ((currentValue - entryPrice) / entryPrice) * 100;
      // Smart TP:
      // - HOLD mode: if bid is >= 90c, hold for settlement ($1.00 payout edge).
      // - AGGRESSIVE mode: if profit >= 50% and bid < 90c, lock it in immediately.
      if (currentValue >= this.takeProfitHoldThreshold) {
        continue;
      }

      if (profitPct >= this.takeProfitAggressivePct) {
        signals.push({
          type: 'TAKE_PROFIT', orderId: pos.orderId, ticker: pos.ticker,
          side: pos.side, sellPriceCents: Math.round(currentValue * 100),
          sellPriceDecimal: currentValue,
          contracts: filledContracts,
          profitPct,
          reason: `TP aggressive: bought@${(entryPrice * 100).toFixed(0)}c sell@${(currentValue * 100).toFixed(0)}c (+${profitPct.toFixed(1)}%), hold-threshold=${Math.round(this.takeProfitHoldThreshold * 100)}c`,
        });
      }
    }

    return signals;
  }
}

module.exports = SignalGenerator;

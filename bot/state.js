const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const PERSIST_DIR = path.join(__dirname, '..', 'data');
const PERSIST_PATH = path.join(PERSIST_DIR, 'state.json');
const SAVE_DEBOUNCE_MS = 5000;
const MAX_PNL_HISTORY = 500;
const MAX_TRADE_LOG = 500;
const MAX_CLOSED_POSITIONS = 100;
const MAX_INTENT_LOG = 2000;
const COIN_PREFIX_TO_SYMBOL = {
  KXBTC: 'btcusdt',
  KXETH: 'ethusdt',
  KXSOL: 'solusdt',
  KXXRP: 'xrpusdt',
  KXDOGE: 'dogeusdt',
};

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function getCoinFromTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return 'UNKNOWN';
  const prefix = Object.keys(COIN_PREFIX_TO_SYMBOL).find(p => ticker.startsWith(p));
  return prefix ? prefix.replace('KX', '') : 'UNKNOWN';
}

function getSymbolFromTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return null;
  const prefix = Object.keys(COIN_PREFIX_TO_SYMBOL).find(p => ticker.startsWith(p));
  return prefix ? COIN_PREFIX_TO_SYMBOL[prefix] : null;
}

function edgeBucket(edge) {
  const val = Number(edge);
  if (!Number.isFinite(val)) return 'unknown';
  if (val < 15) return '0-15';
  if (val < 30) return '15-30';
  return '30+';
}

class BotState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    // Connection status
    this.connections = {
      binance: false,
      polymarket: false,
      kalshi: false,
      redstone: false,
    };

    // Live BTC price from multiple sources
    this.btcPrice = {
      binance: null,
      binanceBid: null,
      binanceAsk: null,
      redstone: null,
      lastUpdate: null,
    };
    this.spotPrices = {};

    // Market open reference price (for calculating move %)
    this.marketOpenPrices = {};
    this.marketOpenPriceStale = {}; // Flags for open prices set late (discovered after open)

    // Kalshi account
    this.balance = { total: 0, available: 0, reserved: 0 };
    this.startingBalance = 0; // Set once on first balance fetch, used for drawdown calc

    // Active Kalshi markets
    this.activeMarkets = [];

    // Polymarket prices cache
    this.polymarketCache = {};

    // Positions
    this.pendingOrders = [];   // Orders placed but not yet confirmed filled
    this.openPositions = [];   // Confirmed filled positions
    this.closedPositions = [];

    // Trade log (all actions)
    this.tradeLog = [];

    // P&L history for charting
    this.pnlHistory = [];

    // Bot intent (what it's thinking/doing)
    this.intent = {
      status: 'initializing',
      message: 'Starting up...',
      lastSignal: null,
      modelProbability: null,
      currentEdge: null,
      action: null,
    };
    this.intentLog = [];

    // Stats
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      volumeTraded: 0,
      startTime: Date.now(),
      tradesPerHour: 0,
      bestTrade: 0,
      worstTrade: 0,
      avgEdge: 0,
      totalEdge: 0,
      grossWins: 0,
      grossLosses: 0,
      streak: 0,
      strategyStats: {},
      coinStats: {},
      signalTypeStats: {},
      edgeBucketStats: {},
      unrealizedPnL: 0,
    };

    // Strategy model state
    this.model = {
      impliedProbUp: null,
      impliedProbDown: null,
      spotMove: null,
      spotMovePct: null,
      timeRemaining: null,
      volatility: 0.0015,
      // 1H trend indicator
      trend: 'NEUTRAL',
      trendStrength: 0,
      trendROC: 0,
      trendWarmup: false,
    };

    // Persistence
    this._saveTimer = null;
    this._loadState();
  }

  // ===== Persistence =====

  _loadState() {
    try {
      if (!fs.existsSync(PERSIST_PATH)) {
        console.log('[State] No persisted state found, starting fresh');
        return;
      }
      const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
      const saved = JSON.parse(raw);

      if (saved.stats) {
        this.stats = { ...this.stats, ...saved.stats };
        // Ensure strategyStats is always an object (old state may not have it)
        if (!this.stats.strategyStats || typeof this.stats.strategyStats !== 'object') {
          this.stats.strategyStats = {};
        }
        if (!this.stats.coinStats || typeof this.stats.coinStats !== 'object') {
          this.stats.coinStats = {};
        }
        if (!this.stats.signalTypeStats || typeof this.stats.signalTypeStats !== 'object') {
          this.stats.signalTypeStats = {};
        }
        if (!this.stats.edgeBucketStats || typeof this.stats.edgeBucketStats !== 'object') {
          this.stats.edgeBucketStats = {};
        }
      }
      if (Array.isArray(saved.closedPositions)) {
        this.closedPositions = saved.closedPositions.slice(-MAX_CLOSED_POSITIONS);
      }
      if (Array.isArray(saved.tradeLog)) {
        this.tradeLog = saved.tradeLog.slice(0, MAX_TRADE_LOG);
      }
      if (Array.isArray(saved.intentLog)) {
        this.intentLog = saved.intentLog.slice(0, MAX_INTENT_LOG);
      }
      if (Array.isArray(saved.pnlHistory)) {
        this.pnlHistory = saved.pnlHistory.slice(-MAX_PNL_HISTORY);
      }
      if (Array.isArray(saved.pendingOrders)) {
        this.pendingOrders = saved.pendingOrders;
      }
      if (Array.isArray(saved.openPositions)) {
        this.openPositions = saved.openPositions;
      }

      console.log(`[State] Loaded: ${this.stats.totalTrades} trades, P&L: $${this.stats.totalPnL.toFixed(2)}, ${this.pendingOrders.length} pending, ${this.openPositions.length} open positions, uptime since ${new Date(this.stats.startTime).toISOString()}`);
    } catch (err) {
      console.error('[State] Failed to load persisted state:', err.message);
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  _writeToDisk() {
    try {
      if (!fs.existsSync(PERSIST_DIR)) {
        fs.mkdirSync(PERSIST_DIR, { recursive: true });
      }

      const data = {
        _savedAt: new Date().toISOString(),
        stats: { ...this.stats },
        pendingOrders: this.pendingOrders,
        openPositions: this.openPositions,
        closedPositions: this.closedPositions.slice(-MAX_CLOSED_POSITIONS),
        tradeLog: this.tradeLog.slice(0, MAX_TRADE_LOG),
        intentLog: this.intentLog.slice(0, MAX_INTENT_LOG),
        pnlHistory: this.pnlHistory.slice(-MAX_PNL_HISTORY),
      };

      const tmpPath = PERSIST_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, PERSIST_PATH);
    } catch (err) {
      console.error('[State] Failed to save state:', err.message);
    }
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._writeToDisk();
  }

  // ===== Price Updates =====

  updateSpotPrice(symbol, bid, ask) {
    const key = String(symbol || '').toLowerCase();
    const mid = (bid + ask) / 2;
    this.spotPrices[key] = {
      bid,
      ask,
      mid,
      lastUpdate: Date.now(),
    };
    if (key === 'btcusdt') {
      this.btcPrice.binance = mid;
      this.btcPrice.binanceBid = bid;
      this.btcPrice.binanceAsk = ask;
      this.btcPrice.lastUpdate = Date.now();
    }
    this.connections.binance = true;
    this.emit('price:binance', { symbol: key, bid, ask, mid });
  }

  updateBinancePrice(bid, ask) {
    this.updateSpotPrice('btcusdt', bid, ask);
  }

  getSpotPriceForTicker(ticker) {
    const symbol = getSymbolFromTicker(ticker);
    if (!symbol) return this.btcPrice.binance;
    return this.spotPrices[symbol]?.mid || null;
  }

  getSpotFeedSymbolForTicker(ticker) {
    return getSymbolFromTicker(ticker) || 'btcusdt';
  }

  getSupportedCoinSymbols() {
    return Object.values(COIN_PREFIX_TO_SYMBOL);
  }

  getCoinFromTicker(ticker) {
    return getCoinFromTicker(ticker);
  }

  _updateWinLossStatsBucket(statObj, won) {
    statObj.total = (statObj.total || 0) + 1;
    if (won) statObj.wins = (statObj.wins || 0) + 1;
    else statObj.losses = (statObj.losses || 0) + 1;
    statObj.winRate = statObj.total > 0 ? statObj.wins / statObj.total : 0;
  }

  closePosition(orderId, result) {
    const idx = this.openPositions.findIndex(p => p.orderId === orderId);
    if (idx === -1) return;

    const position = this.openPositions.splice(idx, 1)[0];
    const closed = { ...position, ...result, settleTime: Date.now() };
    this.closedPositions.push(closed);

    // Cap closed positions
    if (this.closedPositions.length > MAX_CLOSED_POSITIONS) {
      this.closedPositions = this.closedPositions.slice(-MAX_CLOSED_POSITIONS);
    }

    // Update stats
    this.stats.totalTrades++;
    if (closed.won) this.stats.wins++;
    else this.stats.losses++;
    this.stats.totalPnL += closed.pnl;
    if (closed.pnl > this.stats.bestTrade) this.stats.bestTrade = closed.pnl;
    if (closed.pnl < this.stats.worstTrade) this.stats.worstTrade = closed.pnl;

    // Gross wins/losses
    if (closed.pnl > 0) this.stats.grossWins += closed.pnl;
    else this.stats.grossLosses += Math.abs(closed.pnl);

    // Streak
    if (closed.won) {
      this.stats.streak = this.stats.streak > 0 ? this.stats.streak + 1 : 1;
    } else {
      this.stats.streak = this.stats.streak < 0 ? this.stats.streak - 1 : -1;
    }

    // Per-strategy performance (DIRECTIONAL_YES → DIRECTIONAL)
    const stratKey = (closed.type || 'UNKNOWN').replace(/_YES$|_NO$/, '');
    if (!this.stats.strategyStats[stratKey]) {
      this.stats.strategyStats[stratKey] = { wins: 0, losses: 0 };
    }
    if (closed.won) this.stats.strategyStats[stratKey].wins++;
    else this.stats.strategyStats[stratKey].losses++;

    // Per-coin performance for selective disable decisions.
    const coin = getCoinFromTicker(closed.ticker);
    if (!this.stats.coinStats[coin]) {
      this.stats.coinStats[coin] = { wins: 0, losses: 0, total: 0, winRate: 0 };
    }
    this._updateWinLossStatsBucket(this.stats.coinStats[coin], closed.won);

    // Per-signal-type and per-edge-bucket tracking with auto-disable.
    const signalType = closed.type || 'UNKNOWN';
    if (!this.stats.signalTypeStats[signalType]) {
      this.stats.signalTypeStats[signalType] = { wins: 0, losses: 0, total: 0, winRate: 0 };
    }
    this._updateWinLossStatsBucket(this.stats.signalTypeStats[signalType], closed.won);

    const bucket = edgeBucket(closed.edge);
    const bucketKey = `${signalType}|${bucket}`;
    if (!this.stats.edgeBucketStats[bucketKey]) {
      this.stats.edgeBucketStats[bucketKey] = {
        signalType,
        bucket,
        wins: 0,
        losses: 0,
        total: 0,
        winRate: 0,
        disabled: false,
      };
    }
    const bucketStats = this.stats.edgeBucketStats[bucketKey];
    this._updateWinLossStatsBucket(bucketStats, closed.won);
    if (bucketStats.total >= 20 && bucketStats.winRate < 0.5) {
      bucketStats.disabled = true;
    }

    // Update P&L history
    this.pnlHistory.push({
      timestamp: Date.now(),
      pnl: closed.pnl,
      cumulative: this.stats.totalPnL,
    });

    // Cap P&L history
    if (this.pnlHistory.length > MAX_PNL_HISTORY) {
      this.pnlHistory = this.pnlHistory.slice(-MAX_PNL_HISTORY);
    }

    // Trades per hour
    const hours = (Date.now() - this.stats.startTime) / 3600000;
    this.stats.tradesPerHour = hours > 0 ? this.stats.totalTrades / hours : 0;

    this.emit('position:close', closed);
    this.emit('stats', this.stats);

    // Persist after position close
    this._scheduleSave();
  }

  updateRedstonePrice(price, timestamp) {
    this.btcPrice.redstone = price;
    this.connections.redstone = true;
    this.emit('price:redstone', { price, timestamp });
  }

  // ===== Connection & Market Updates =====

  updateConnection(name, connected) {
    if (this.connections[name] === connected) return; // No change, skip emit
    this.connections[name] = connected;
    this.emit(`connection:${name}`, connected);
  }

  updateKalshiConnection(connected) {
    this.updateConnection('kalshi', connected);
  }

  updateBalance(balance) {
    this.balance = balance;
    // Set starting balance once (first balance fetch after startup)
    if (this.startingBalance === 0 && balance.total > 0) {
      this.startingBalance = balance.total;
    }
    this.emit('balance', balance);
  }

  updateMarkets(markets) {
    this.activeMarkets = markets;
    this.emit('markets', markets);
  }

  updateIntent(intent) {
    this.intent = { ...this.intent, ...intent };
    this.intentLog.unshift({
      timestamp: Date.now(),
      ...this.intent,
    });
    if (this.intentLog.length > MAX_INTENT_LOG) this.intentLog.pop();
    this.emit('intent', this.intent);
  }

  updateModel(model) {
    this.model = { ...this.model, ...model };
    this.emit('model', this.model);
  }

  // ===== Trade & Position Tracking =====

  logTrade(trade) {
    const entry = {
      ...trade,
      timestamp: normalizeTimestamp(trade.timestamp),
    };
    this.tradeLog.unshift(entry);
    if (this.tradeLog.length > MAX_TRADE_LOG) this.tradeLog.pop();
    this.emit('trade', entry);

    // Persist on meaningful trades only
    if (trade.type === 'TRADE' || trade.type === 'SETTLEMENT') {
      this._scheduleSave();
    }
  }

  addPendingOrder(order) {
    this.pendingOrders.push(order);
    this.emit('order:pending', order);
    this._scheduleSave();
  }

  removePendingOrder(orderId) {
    const idx = this.pendingOrders.findIndex(o => o.orderId === orderId);
    if (idx === -1) return;
    const removed = this.pendingOrders.splice(idx, 1)[0];
    this.emit('order:removed', removed);
    this._scheduleSave();
  }

  addPosition(position) {
    this.openPositions.push(position);
    this.emit('position:open', position);
    this._scheduleSave(); // Persist immediately so positions survive restarts
  }


  // ===== Live Stats =====

  emitStats() {
    const hours = (Date.now() - this.stats.startTime) / 3600000;
    this.stats.tradesPerHour = hours > 0 ? this.stats.totalTrades / hours : 0;
    this.emit('stats', this.stats);
  }

  updateUnrealizedPnL(value) {
    this.stats.unrealizedPnL = value;
    this.emit('stats', this.stats);
  }

  // ===== Snapshot =====

  getSnapshot() {
    return {
      connections: this.connections,
      btcPrice: this.btcPrice,
      spotPrices: this.spotPrices,
      balance: this.balance,
      activeMarkets: this.activeMarkets,
      pendingOrders: this.pendingOrders,
      openPositions: this.openPositions,
      closedPositions: this.closedPositions.slice(-50),
      tradeLog: this.tradeLog.slice(0, 50),
      intentLog: this.intentLog.slice(0, 50),
      pnlHistory: this.pnlHistory,
      intent: this.intent,
      stats: this.stats,
      model: this.model,
      startTime: this.stats.startTime,
    };
  }

  getLogsExport() {
    return {
      exportedAt: new Date().toISOString(),
      stats: this.stats,
      balance: this.balance,
      openPositions: this.openPositions,
      pendingOrders: this.pendingOrders,
      tradeLog: this.tradeLog,
      intentLog: this.intentLog,
      pnlHistory: this.pnlHistory,
      model: this.model,
    };
  }
}

module.exports = BotState;

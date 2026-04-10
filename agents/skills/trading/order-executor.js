/**
 * OrderExecutor Skill
 *
 * Handles order placement and lifecycle management.
 * Wraps the existing OrderManager for fill tracking and stale order cancellation.
 *
 * Capabilities: execute-signals, place-order, cancel-order, check-order-status
 */

const BaseSkill = require('../../core/base-skill');
const OrderManager = require('../../../bot/order-manager');

function parseNumeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getOrderFillCount(order) {
  if (order && order.fill_count_fp != null) return parseNumeric(order.fill_count_fp);
  if (order && order.fill_count != null) return parseNumeric(order.fill_count);
  return 0;
}

function getOrderCostCents(order) {
  const makerCost = parseNumeric(order?.maker_fill_cost_dollars);
  const makerFees = parseNumeric(order?.maker_fees_dollars);
  const takerCost = parseNumeric(order?.taker_fill_cost_dollars);
  const takerFees = parseNumeric(order?.taker_fees_dollars);
  if (makerCost || makerFees || takerCost || takerFees) {
    return Math.round((makerCost + makerFees + takerCost + takerFees) * 100);
  }
  return parseNumeric(order?.taker_fill_cost) + parseNumeric(order?.taker_fees);
}

function coinFromTicker(ticker) {
  if (!ticker) return 'UNKNOWN';
  if (ticker.startsWith('KXBTC')) return 'BTC';
  if (ticker.startsWith('KXETH')) return 'ETH';
  if (ticker.startsWith('KXSOL')) return 'SOL';
  if (ticker.startsWith('KXXRP')) return 'XRP';
  if (ticker.startsWith('KXDOGE')) return 'DOGE';
  return 'UNKNOWN';
}

class OrderExecutor extends BaseSkill {
  constructor() {
    super({
      name: 'order-executor',
      description: 'Places orders on Kalshi and manages order lifecycle (fills, cancellations)',
      domain: 'trading',
      capabilities: ['execute-signals', 'place-order', 'cancel-order', 'check-order-status'],
      dependencies: ['state-manager', 'kalshi-market-data', 'analytics-recorder', 'risk-manager'],
    });

    this.orderManager = null;
    this.maxPositionSize = 1.5;
    this.orderCooldownMs = 15000;
    this._lastOrderByTicker = new Map();
    this._orderingTickers = new Set();
    this._activeTickerLocks = new Map();
  }

  async initialize(context) {
    await super.initialize(context);

    const stateManager = context.registry.get('state-manager');
    const kalshiSkill = context.registry.get('kalshi-market-data');
    const analyticsSkill = context.registry.get('analytics-recorder');

    this.orderManager = new OrderManager(
      kalshiSkill.getClient(),
      stateManager.botState,
      analyticsSkill.getDB(),
      context.config
    );

    this.maxPositionSize = Math.min(1.5, context.config.MAX_POSITION_SIZE || 1.5);
    this.orderCooldownMs = context.config.ORDER_COOLDOWN_MS || 15000;
  }

  async start() {
    await super.start();
    this.orderManager.start();
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');
    const analyticsSkill = this.context.registry.get('analytics-recorder');
    const riskSkill = this.context.registry.get('risk-manager');

    switch (task.action) {
      case 'execute-signals': {
        const signals = task.params?.approvedSignals || [];
        const results = [];
        let executedCount = 0;
        const maxPerScan = 1;
        let lastTicker = null;
        this._cleanupExpiredTickerLocks();

        // Global safety: if anything is pending, do not place new orders.
        if (state.pendingOrders.length > 0) {
          return {
            executedSignals: signals.map(s => ({
              signal: s.ticker,
              status: 'blocked',
              reason: 'pending_order_exists',
            })),
            totalExecuted: 0,
          };
        }

        for (const signal of signals) {
          if (executedCount >= maxPerScan) break;
          if (this._isTickerLocked(signal.ticker)) {
            results.push({
              signal: signal.ticker,
              status: 'blocked',
              reason: 'ticker_locked_until_close',
            });
            continue;
          }

          if (this._orderingTickers.has(signal.ticker)) {
            results.push({
              signal: signal.ticker,
              status: 'blocked',
              reason: 'ticker_order_in_flight',
            });
            continue;
          }

          const now = Date.now();
          const lastOrderAt = this._lastOrderByTicker.get(signal.ticker) || 0;
          if (now - lastOrderAt < this.orderCooldownMs) {
            results.push({
              signal: signal.ticker,
              status: 'blocked',
              reason: `cooldown_active_${Math.ceil((this.orderCooldownMs - (now - lastOrderAt)) / 1000)}s`,
            });
            continue;
          }

          // Final risk check before execution
          const riskCheck = await riskSkill.execute({
            action: 'check-risk',
            params: { signal },
          });

          if (!riskCheck.success || !riskCheck.approved) {
            results.push({ signal: signal.ticker, status: 'blocked', reason: riskCheck.reason || 'risk_check_failed' });
            continue;
          }

          if (lastTicker === signal.ticker) await sleep(100);

          this._orderingTickers.add(signal.ticker);
          const result = await this._executeSignal(signal, state, kalshiSkill, analyticsSkill);
          if (result.status !== 'executed') {
            this._orderingTickers.delete(signal.ticker);
          }
          results.push(result);
          if (result.status === 'executed') {
            executedCount++;
            this._lastOrderByTicker.set(signal.ticker, Date.now());
          }
          lastTicker = signal.ticker;
        }

        return { executedSignals: results, totalExecuted: executedCount };
      }

      case 'place-order': {
        const orderData = task.params?.orderData;
        const order = await kalshiSkill.getClient().placeOrder(orderData);
        return { order };
      }

      case 'cancel-order': {
        const orderId = task.params?.orderId;
        await kalshiSkill.getClient().cancelOrder(orderId);
        return { cancelled: true };
      }

      case 'check-order-status': {
        const orderId = task.params?.orderId;
        const order = await kalshiSkill.getClient().getOrder(orderId);
        return { order };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  async _executeSignal(signal, state, kalshiSkill, analyticsSkill) {
    const maxContracts = Math.min(Math.floor(this.maxPositionSize / signal.priceDecimal), 3);
    if (maxContracts <= 0) {
      return { signal: signal.ticker, status: 'blocked', reason: 'price_above_hard_cap' };
    }

    const executionSignal = {
      ...signal,
      contracts: Math.max(1, Math.min(signal.contracts, maxContracts)),
    };
    const cost = executionSignal.priceDecimal * executionSignal.contracts;

    if (cost > this.maxPositionSize) {
      return {
        signal: executionSignal.ticker,
        status: 'blocked',
        reason: `max_position_size_exceeded (${cost.toFixed(2)} > ${this.maxPositionSize.toFixed(2)})`,
      };
    }

    const sameTickerExposure = [
      ...state.pendingOrders.filter(p => p.ticker === executionSignal.ticker),
      ...state.openPositions.filter(p => p.ticker === executionSignal.ticker),
    ];
    if (sameTickerExposure.length > 0) {
      return { signal: executionSignal.ticker, status: 'blocked', reason: 'one_position_per_ticker' };
    }

    const signalId = analyticsSkill.logSignalDirect(executionSignal, true);

    const market = state.activeMarkets.find(m => m.ticker === executionSignal.ticker);
    if (market) {
      analyticsSkill.logMarketSnapshotDirect(market, state.btcPrice.binance, 'pre_execution');
    }

    try {
      const clientOrderId = `bot-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      // Sticky lock before API call; release only after contract close window.
      this._lockTickerUntilClose(executionSignal.ticker, executionSignal.closeTime);
      const orderData = {
        ticker: executionSignal.ticker,
        action: 'buy',
        side: executionSignal.side,
        count: executionSignal.contracts,
        type: 'limit',
        client_order_id: clientOrderId,
      };

      if (executionSignal.side === 'yes') orderData.yes_price = executionSignal.priceCents;
      else orderData.no_price = executionSignal.priceCents;

      state.updateIntent({
        status: 'executing',
        message: `Executing ${executionSignal.type}...`,
        action: `BUY ${executionSignal.side.toUpperCase()} ${executionSignal.ticker} x${executionSignal.contracts} @ ${executionSignal.priceCents}c`,
      });

      console.log(`[OrderExecutor] Executing: ${executionSignal.type} ${executionSignal.ticker} ${executionSignal.side} x${executionSignal.contracts} @ ${executionSignal.priceCents}c | Edge: ${executionSignal.edge.toFixed(1)}%`);

      const order = await kalshiSkill.getClient().placeOrder(orderData);
      const fills = getOrderFillCount(order);
      const costCents = getOrderCostCents(order);

      console.log(`[OrderExecutor] Order ${order.order_id}: ${order.status} | Filled: ${fills}/${executionSignal.contracts}`);

      analyticsSkill.logOrderDirect({
        order_id: order.order_id,
        client_order_id: clientOrderId,
        ticker: executionSignal.ticker,
        side: executionSignal.side,
        action: 'buy',
        price_cents: executionSignal.priceCents,
        count: executionSignal.contracts,
        status: order.status,
        fill_count: fills,
        taker_fill_cost: costCents,
        taker_fees: 0,
        close_time: executionSignal.closeTime,
      }, signalId);

      const pendingOrder = {
        orderId: order.order_id,
        clientOrderId,
        coin: coinFromTicker(executionSignal.ticker),
        ticker: executionSignal.ticker,
        signalType: executionSignal.type,
        side: executionSignal.side,
        contracts: executionSignal.contracts,
        fillCount: fills,
        priceCents: executionSignal.priceCents,
        priceDecimal: executionSignal.priceDecimal,
        reservedCost: cost,
        edge: executionSignal.edge,
        modelProb: executionSignal.modelProb,
        reason: executionSignal.reason,
        placedAt: Date.now(),
        closeTime: executionSignal.closeTime,
        orderStatus: order.status,
        isDualSide: executionSignal.isDualSide || false,
      };

      this.orderManager.addPendingOrder(pendingOrder);

      state.balance.available -= cost;
      if (state.balance.available < 0) state.balance.available = 0;

      state.stats.volumeTraded += cost;
      state.stats.totalEdge += executionSignal.edge;
      state.stats.avgEdge = state.stats.totalEdge / (state.stats.totalTrades + state.openPositions.length || 1);

      state.logTrade({
        type: 'TRADE',
        action: 'BUY',
        side: executionSignal.side,
        ticker: executionSignal.ticker,
        contracts: executionSignal.contracts,
        price: executionSignal.priceCents,
        edge: executionSignal.edge,
        signalType: executionSignal.type,
        reason: executionSignal.reason,
      });

      state.emitStats();

      const timeToSettle = executionSignal.closeTime - Date.now() + 60000;
      if (timeToSettle > 0) {
        const positionManager = this.context.registry.get('position-manager');
        setTimeout(() => positionManager.settlePositionById(pendingOrder.orderId), timeToSettle);
      }

      await kalshiSkill.getClient().fetchBalance();
      return { signal: executionSignal.ticker, status: 'executed', orderId: order.order_id };
    } catch (err) {
      this._orderingTickers.delete(signal.ticker);
      // API failed before a valid order lifecycle; release the lock to avoid deadlock.
      this._activeTickerLocks.delete(signal.ticker);
      const detail = err.response ? `${err.response.status} - ${JSON.stringify(err.response.data)}` : err.message;
      return { signal: signal.ticker, status: 'error', error: detail };
    }
  }

  _isTickerLocked(ticker) {
    const until = this._activeTickerLocks.get(ticker);
    return Number.isFinite(until) && until > Date.now();
  }

  _lockTickerUntilClose(ticker, closeTimeMs) {
    const now = Date.now();
    const releaseAt = Math.max(
      now + 10000,
      (Number.isFinite(closeTimeMs) ? closeTimeMs : now) + 60000
    );
    this._activeTickerLocks.set(ticker, releaseAt);
  }

  _cleanupExpiredTickerLocks() {
    const now = Date.now();
    for (const [ticker, until] of this._activeTickerLocks.entries()) {
      if (!Number.isFinite(until) || until <= now) {
        this._activeTickerLocks.delete(ticker);
        this._orderingTickers.delete(ticker);
      }
    }
  }

  async stop() {
    if (this.orderManager) this.orderManager.stop();
    await super.stop();
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = OrderExecutor;

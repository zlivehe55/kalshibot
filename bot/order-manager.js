/**
 * Order Lifecycle Manager
 *
 * Separates "pending orders" (placed but unconfirmed) from "open positions"
 * (confirmed fills). Polls Kalshi for fill updates and cancels stale orders.
 *
 * Flow:
 *   signal → executeSignal() → pendingOrders
 *   OrderManager poll → detects fills → promotes to openPositions
 *   OrderManager poll → stale timeout → cancels order, removes from pending
 */

function parseNumeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getOrderFillCount(order) {
  // New API shape: fill_count_fp (string decimal); legacy: fill_count (integer)
  if (order && order.fill_count_fp != null) return parseNumeric(order.fill_count_fp);
  if (order && order.fill_count != null) return parseNumeric(order.fill_count);
  return 0;
}

function getOrderCostCents(order) {
  // New API shape reports dollars split by maker/taker.
  const makerCost = parseNumeric(order?.maker_fill_cost_dollars);
  const makerFees = parseNumeric(order?.maker_fees_dollars);
  const takerCost = parseNumeric(order?.taker_fill_cost_dollars);
  const takerFees = parseNumeric(order?.taker_fees_dollars);
  if (makerCost || makerFees || takerCost || takerFees) {
    return Math.round((makerCost + makerFees + takerCost + takerFees) * 100);
  }
  // Legacy fallback in cents.
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

class OrderManager {
  constructor(kalshi, state, db, config = {}) {
    this.kalshi = kalshi;
    this.state = state;
    this.db = db;

    // How often to poll for fill updates (ms)
    this.pollIntervalMs = config.ORDER_POLL_INTERVAL || 5000;
    // How long before an unfilled order is cancelled (ms)
    this.staleTimeoutMs = config.ORDER_STALE_TIMEOUT || 30000;

    this._interval = null;
    this._polling = false;
    this._callbacks = {
      onPositionPromoted: typeof config.onPositionPromoted === 'function' ? config.onPositionPromoted : null,
      onOrderFinalized: typeof config.onOrderFinalized === 'function' ? config.onOrderFinalized : null,
    };
  }

  start() {
    this._interval = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /**
   * Add a newly placed order to the pending queue.
   * Called by engine.executeSignal() after Kalshi returns order confirmation.
   */
  addPendingOrder(orderInfo) {
    this.state.addPendingOrder(orderInfo);

    // If the order was already (partially) filled at placement, process immediately
    if (orderInfo.fillCount > 0) {
      this._processFill(orderInfo, orderInfo.fillCount, 'placement');
    }
  }

  /**
   * Main poll loop — check all pending orders for fills or staleness.
   */
  async poll() {
    if (this._polling) return;
    this._polling = true;

    try {
      const pending = [...this.state.pendingOrders];
      if (pending.length === 0) { this._polling = false; return; }

      for (const order of pending) {
        try {
          await this._checkOrder(order);
        } catch (err) {
          console.error(`[OrderMgr] Error checking order ${order.orderId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[OrderMgr] Poll error: ${err.message}`);
    } finally {
      this._polling = false;
    }
  }

  async _checkOrder(pendingOrder) {
    const kalshiOrder = await this.kalshi.getOrder(pendingOrder.orderId);
    if (!kalshiOrder) return;

    const currentFills = getOrderFillCount(kalshiOrder);
    const prevFills = pendingOrder.fillCount || 0;
    const status = kalshiOrder.status;

    // New fills detected
    if (currentFills > prevFills) {
      this._processFill(pendingOrder, currentFills, 'poll');
    }

    // Order fully executed or cancelled — remove from pending
    if (status === 'executed' || status === 'canceled' || status === 'cancelled') {
      this._finalizePendingOrder(pendingOrder, kalshiOrder);
      return;
    }

    // Check for stale orders (resting with 0 fills past timeout)
    const age = Date.now() - pendingOrder.placedAt;
    if (status === 'resting' && currentFills === 0 && age > this.staleTimeoutMs) {
      await this._cancelStaleOrder(pendingOrder);
      return;
    }

    // Update local fill count
    pendingOrder.fillCount = currentFills;
  }

  /**
   * Process detected fills — promote to openPositions.
   */
  _processFill(pendingOrder, currentFills, source) {
    const prevFills = pendingOrder.fillCount || 0;
    const newFills = currentFills - prevFills;
    if (newFills <= 0) return;

    // Log fill event
    if (this.db) {
      this.db.logFill(
        pendingOrder.orderId,
        pendingOrder.ticker,
        pendingOrder.side,
        currentFills,
        prevFills,
        source
      );
    }

    // Update pending order's tracked fill count
    pendingOrder.fillCount = currentFills;

    // Check if a position already exists for this order (partial fill update)
    const existingPos = this.state.openPositions.find(
      p => p.orderId === pendingOrder.orderId
    );

    if (existingPos) {
      // Update existing position's fill count
      existingPos.filledContracts = currentFills;
      existingPos.totalCost = pendingOrder.priceDecimal * currentFills;
      this.state.emit('position:updated', existingPos);
    } else {
      // Promote to open position
      const position = {
        orderId: pendingOrder.orderId,
        clientOrderId: pendingOrder.clientOrderId,
        coin: pendingOrder.coin || coinFromTicker(pendingOrder.ticker),
        ticker: pendingOrder.ticker,
        type: pendingOrder.signalType,
        side: pendingOrder.side,
        contracts: pendingOrder.contracts,
        filledContracts: currentFills,
        priceCents: pendingOrder.priceCents,
        priceDecimal: pendingOrder.priceDecimal,
        totalCost: pendingOrder.priceDecimal * currentFills,
        edge: pendingOrder.edge,
        modelProb: pendingOrder.modelProb,
        reason: pendingOrder.reason,
        entryTime: pendingOrder.placedAt,
        closeTime: pendingOrder.closeTime,
        status: 'filled',
        isDualSide: pendingOrder.isDualSide || false,
      };

      this.state.addPosition(position);
      if (this._callbacks.onPositionPromoted) {
        this._callbacks.onPositionPromoted({
          orderId: pendingOrder.orderId,
          ticker: pendingOrder.ticker,
          side: pendingOrder.side,
        });
      }

      console.log(
        `[OrderMgr] Promoted to position: ${pendingOrder.ticker} ${pendingOrder.side} ` +
        `x${currentFills} @ ${pendingOrder.priceCents}c (source: ${source})`
      );
    }
  }

  /**
   * Finalize a pending order — remove from pending queue.
   * If it had fills, the position already exists via _processFill.
   * If fully cancelled with 0 fills, just clean up.
   */
  _finalizePendingOrder(pendingOrder, kalshiOrder) {
    const fills = getOrderFillCount(kalshiOrder);
    const costCents = getOrderCostCents(kalshiOrder);

    // Update DB
    if (this.db) {
      this.db.updateOrder(
        pendingOrder.orderId,
        kalshiOrder.status,
        fills,
        costCents,
        0
      );
    }

    // Process any remaining fills
    if (fills > (pendingOrder.fillCount || 0)) {
      this._processFill(pendingOrder, fills, 'finalize');
    }

    // Remove from pending
    this.state.removePendingOrder(pendingOrder.orderId);
    if (this._callbacks.onOrderFinalized) {
      this._callbacks.onOrderFinalized({
        orderId: pendingOrder.orderId,
        ticker: pendingOrder.ticker,
        status: kalshiOrder.status,
        fills,
      });
    }

    if (fills === 0) {
      console.log(
        `[OrderMgr] Order ${pendingOrder.orderId} closed with 0 fills ` +
        `(status: ${kalshiOrder.status})`
      );
    }
  }

  /**
   * Cancel a stale order that hasn't filled.
   */
  async _cancelStaleOrder(pendingOrder) {
    try {
      console.log(
        `[OrderMgr] Cancelling stale order: ${pendingOrder.orderId} ` +
        `(${pendingOrder.ticker} ${pendingOrder.side}, age: ${((Date.now() - pendingOrder.placedAt) / 1000).toFixed(0)}s)`
      );

      await this.kalshi.cancelOrder(pendingOrder.orderId);

      if (this.db) {
        this.db.updateOrder(pendingOrder.orderId, 'canceled', 0, 0, 0);
      }

      this.state.removePendingOrder(pendingOrder.orderId);
      if (this._callbacks.onOrderFinalized) {
        this._callbacks.onOrderFinalized({
          orderId: pendingOrder.orderId,
          ticker: pendingOrder.ticker,
          status: 'canceled',
          fills: 0,
        });
      }

      // Restore the reserved balance
      this.state.balance.available += pendingOrder.reservedCost || 0;

    } catch (err) {
      console.error(`[OrderMgr] Cancel error for ${pendingOrder.orderId}: ${err.message}`);
      // If cancel fails (e.g. already filled), next poll will pick up the new state
    }
  }
}

module.exports = OrderManager;

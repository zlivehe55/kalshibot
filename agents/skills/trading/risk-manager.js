/**
 * RiskManager Skill
 *
 * Evaluates signals against risk constraints before execution.
 * Enforces position limits, balance checks, exposure caps, and
 * session drawdown rules.
 *
 * Capabilities: check-risk, evaluate-signals, check-position-limits, check-balance
 */

const BaseSkill = require('../../core/base-skill');

class RiskManager extends BaseSkill {
  constructor() {
    super({
      name: 'risk-manager',
      description: 'Evaluates trading signals against risk constraints and position limits',
      domain: 'trading',
      capabilities: ['check-risk', 'evaluate-signals', 'check-position-limits', 'check-balance'],
      dependencies: ['state-manager', 'analytics-recorder'],
    });

    this.maxOpenPositions = 10;
    this.maxPerContract = 1;
    this.maxPositionSize = 1.5;
    this.maxAccountRiskPct = 0.30;
    this.disabledCoins = new Set(['DOGE']);
  }

  async initialize(context) {
    await super.initialize(context);
    this.maxOpenPositions = context.config.MAX_TOTAL_OPEN_POSITIONS || 10;
    this.maxPerContract = context.config.MAX_POSITIONS_PER_CONTRACT || 1;
    this.maxPositionSize = Math.min(1.5, context.config.MAX_POSITION_SIZE || 1.5);
    this.maxAccountRiskPct = Number.isFinite(context.config.MAX_ACCOUNT_RISK_PCT)
      ? context.config.MAX_ACCOUNT_RISK_PCT
      : 0.30;
    this.disabledCoins = new Set(
      (Array.isArray(context.config.DISABLED_COINS) ? context.config.DISABLED_COINS : ['DOGE'])
        .map(c => String(c).toUpperCase())
    );
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'evaluate-signals': {
        // Accept ML-scored signals (preferred) or raw signals
        const signals = task.params?.scoredSignals || task.params?.signals || [];
        const approved = [];

        for (const signal of signals) {
          const check = this._checkSignal(signal, state);
          if (check.approved) {
            approved.push(signal);
          } else {
            // Log blocked signal
            const db = this.context.registry.get('analytics-recorder');
            if (db) db.logBlockedSignal(signal, check.reason);
          }
        }

        return { approvedSignals: approved, rejected: signals.length - approved.length };
      }

      case 'check-risk': {
        const signal = task.params?.signal;
        if (!signal) throw new Error('signal required');
        return this._checkSignal(signal, state);
      }

      case 'check-position-limits': {
        return this._getPositionLimits(state);
      }

      case 'check-balance': {
        return {
          available: state.balance.available,
          total: state.balance.total,
          reserved: state.balance.reserved,
        };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  _checkSignal(signal, state) {
    const ticker = String(signal.ticker || '');
    if (ticker.startsWith('KXDOGE') || this.disabledCoins.has('DOGE')) {
      if (ticker.startsWith('KXDOGE')) return { approved: false, reason: 'disabled_coin' };
    }

    // Check total position limits (pending + open)
    const totalExposure = state.openPositions.length + state.pendingOrders.length;
    if (totalExposure >= this.maxOpenPositions) {
      return { approved: false, reason: 'max_positions' };
    }

    // Check per-contract limits
    const existingOnTicker = [
      ...state.openPositions.filter(p => p.ticker === signal.ticker),
      ...state.pendingOrders.filter(p => p.ticker === signal.ticker),
    ];
    if (existingOnTicker.length >= 1) {
      return { approved: false, reason: 'one_position_per_ticker' };
    }

    // Check balance
    const cost = signal.priceDecimal * signal.contracts;
    if (cost > this.maxPositionSize) {
      return { approved: false, reason: 'max_position_size' };
    }
    if (cost > state.balance.available) {
      return { approved: false, reason: 'insufficient_balance' };
    }

    // Strict cumulative ticker exposure cap (no buffer above max position size)
    const existingCost = existingOnTicker.reduce((sum, p) => {
      if (Number.isFinite(p.totalCost)) return sum + p.totalCost;
      if (Number.isFinite(p.reservedCost)) return sum + p.reservedCost;
      if (Number.isFinite(p.priceDecimal) && Number.isFinite(p.filledContracts)) return sum + (p.priceDecimal * p.filledContracts);
      if (Number.isFinite(p.priceDecimal) && Number.isFinite(p.contracts)) return sum + (p.priceDecimal * p.contracts);
      return sum;
    }, 0);
    if (existingCost + cost > this.maxPositionSize) {
      return { approved: false, reason: 'ticker_exposure_cap' };
    }

    // Global account risk budget: stop taking risk beyond N% of starting balance.
    const startBalance = state.startingBalance > 0 ? state.startingBalance : state.balance.total;
    const riskBudget = startBalance * this.maxAccountRiskPct;
    const realizedLoss = Math.max(0, -(state.stats.totalPnL || 0));
    const openRisk = [
      ...state.openPositions,
      ...state.pendingOrders,
    ].reduce((sum, p) => {
      if (Number.isFinite(p.totalCost)) return sum + p.totalCost;
      if (Number.isFinite(p.reservedCost)) return sum + p.reservedCost;
      if (Number.isFinite(p.priceDecimal) && Number.isFinite(p.filledContracts)) return sum + (p.priceDecimal * p.filledContracts);
      if (Number.isFinite(p.priceDecimal) && Number.isFinite(p.contracts)) return sum + (p.priceDecimal * p.contracts);
      return sum;
    }, 0);
    if ((realizedLoss + openRisk + cost) > riskBudget) {
      return { approved: false, reason: 'account_risk_budget' };
    }

    return { approved: true, cost, existingExposure: existingCost };
  }

  _getPositionLimits(state) {
    const totalExposure = state.openPositions.length + state.pendingOrders.length;
    return {
      currentOpen: state.openPositions.length,
      currentPending: state.pendingOrders.length,
      totalExposure,
      maxOpenPositions: this.maxOpenPositions,
      maxPerContract: this.maxPerContract,
      slotsAvailable: Math.max(0, this.maxOpenPositions - totalExposure),
    };
  }
}

module.exports = RiskManager;

#!/usr/bin/env node

/**
 * Kalshibot Server — Agentic Architecture
 *
 * Entry point that creates the MasterAgent (which owns the Orchestrator,
 * SkillRegistry, and all sub-agent skills), wires up the Express/Socket.io
 * UI layer, and manages the bot lifecycle.
 *
 * Architecture:
 *   server.js → MasterAgent → Orchestrator → Skills
 *
 * The legacy BotEngine is preserved at `node kalshi-bot.js` for fallback.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MasterAgent } = require('./agents');

const PORT = process.env.PORT || 3333;
const parseList = (raw, fallback) => {
  const parts = String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
};
const parseCoinMultipliers = (raw, fallback = {}) => {
  const out = { ...fallback };
  const parts = String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [coinRaw, multRaw] = part.split(':').map(x => (x || '').trim());
    const coin = coinRaw.toUpperCase();
    const mult = Number(multRaw);
    if (!coin || !Number.isFinite(mult) || mult < 0) continue;
    out[coin] = mult;
  }
  return out;
};
const DEFAULT_SERIES_TICKERS = ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M'];
const seriesTickers = parseList(process.env.SERIES_TICKERS, [process.env.SERIES_TICKER || DEFAULT_SERIES_TICKERS[0]]);
const effectiveSeriesTickers = seriesTickers.length > 0 ? seriesTickers : DEFAULT_SERIES_TICKERS;

// Build config from env
const config = {
  KALSHI_API_KEY: process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem',
  KALSHI_API_BASE: process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com',

  POLYMARKET_GAMMA_API: 'https://gamma-api.polymarket.com',
  POLYMARKET_CLOB_API: 'https://clob.polymarket.com',

  SERIES_TICKER: process.env.SERIES_TICKER || effectiveSeriesTickers[0],
  SERIES_TICKERS: effectiveSeriesTickers,
  SUPPORTED_SPOT_SYMBOLS: ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'dogeusdt'],
  DISABLED_COINS: parseList(process.env.DISABLED_COINS, ['DOGE']).map(c => c.toUpperCase()),
  COIN_EDGE_MULTIPLIERS: parseCoinMultipliers(process.env.COIN_EDGE_MULTIPLIERS, { BTC: 0.75 }),
  SLOT_DURATION: parseInt(process.env.SLOT_DURATION) || 900, // 15 min

  // Strategy thresholds
  MIN_EDGE: parseFloat(process.env.MIN_EDGE) || 8.0,
  // Backtest-optimized: higher threshold to filter overconfident signals
  MIN_DIVERGENCE: parseFloat(process.env.MIN_DIVERGENCE) || 12.0,
  TRADING_WINDOW: parseInt(process.env.TRADING_WINDOW) || 15, // minutes
  // Backtest-optimized: contracts above 65c have terrible payoff ratio
  MIN_CONTRACT_PRICE: parseInt(process.env.MIN_CONTRACT_PRICE) || 30, // cents
  MAX_CONTRACT_PRICE: parseInt(process.env.MAX_CONTRACT_PRICE) || 70, // cents

  // 15m trend indicator defaults (aligned to 15m contracts)
  TREND_ENABLED: process.env.TREND_ENABLED !== 'false',
  TREND_FAST_PERIOD: parseInt(process.env.TREND_FAST_PERIOD) || 180,     // 3 min
  TREND_SLOW_PERIOD: parseInt(process.env.TREND_SLOW_PERIOD) || 900,     // 15 min
  TREND_ROC_WINDOW: parseInt(process.env.TREND_ROC_WINDOW) || 900,       // 15 min
  TREND_ROC_THRESHOLD: parseFloat(process.env.TREND_ROC_THRESHOLD) || 0.02,
  TREND_BOOST: parseFloat(process.env.TREND_BOOST) || 0.25,
  TREND_PENALTY: parseFloat(process.env.TREND_PENALTY) || 0.40,

  // Position sizing
  // Backtest-optimized: conservative Kelly to survive binary option variance
  USE_KELLY_SIZING: process.env.USE_KELLY_SIZING !== 'false',
  KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION) || 0.08,
  MAX_POSITION_SIZE: Math.min(1.5, parseFloat(process.env.MAX_POSITION_SIZE) || 1.5),
  MAX_POSITIONS_PER_CONTRACT: parseInt(process.env.MAX_POSITIONS_PER_CONTRACT) || 1,
  MAX_TOTAL_OPEN_POSITIONS: parseInt(process.env.MAX_TOTAL_OPEN_POSITIONS) || 10,
  MAX_ACCOUNT_RISK_PCT: Number.isFinite(parseFloat(process.env.MAX_ACCOUNT_RISK_PCT))
    ? parseFloat(process.env.MAX_ACCOUNT_RISK_PCT)
    : 0.30,
};

// Express + Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));

// Create the MasterAgent
const agent = new MasterAgent(config);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), botRunning: agent.running });
});

// Bot control: start/stop
app.post('/api/bot/start', (req, res) => {
  if (agent.running) {
    return res.json({ status: 'already_running' });
  }
  // Respond immediately — start() is long-running (connects to feeds, waits for prices)
  res.json({ status: 'starting' });
  agent.start()
    .then(() => {
      io.emit('bot:status', { running: true });
    })
    .catch((err) => {
      console.error('[Server] Bot start failed:', err.message);
      io.emit('bot:status', { running: false, error: err.message });
    });
});

app.post('/api/bot/stop', (req, res) => {
  if (!agent.running) {
    return res.json({ status: 'already_stopped' });
  }
  agent.stop();
  io.emit('bot:status', { running: false });
  res.json({ status: 'stopped' });
});

app.get('/api/bot/status', (req, res) => {
  res.json({ running: agent.running });
});

// API: get current state
app.get('/api/state', (req, res) => {
  if (agent && agent.state) {
    res.json(agent.state.getSnapshot());
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: download full bot logs/thought process
app.get('/api/logs/download', (req, res) => {
  if (!agent || !agent.state) {
    return res.status(503).json({ error: 'Agent not started' });
  }

  const payload = agent.state.getLogsExport();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"kalshibot-logs-${stamp}.json\"`);
  return res.send(JSON.stringify(payload, null, 2));
});

// API: force save state to disk
app.post('/api/save', (req, res) => {
  if (agent && agent.state) {
    agent.state.saveNow();
    res.json({ status: 'saved' });
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: ML pipeline status
app.get('/api/ml', (req, res) => {
  const mlScorer = agent.registry.get('ml-signal-scorer');
  if (mlScorer) {
    const mlPipeline = require('./lib/ml-pipeline');
    res.json(mlPipeline.describe());
  } else {
    res.json({ trained: false, note: 'ML scorer not initialized' });
  }
});

// API: get agent skill registry status
app.get('/api/skills', (req, res) => {
  res.json({
    skills: agent.registry.describeAll(),
    orchestrator: agent.orchestrator.describe(),
  });
});

// Socket.io: push updates to UI
io.on('connection', (socket) => {
  console.log(`[Server] UI connected: ${socket.id}`);

  // Send full snapshot on connect
  socket.emit('bot:status', { running: agent.running });
  if (agent.state) {
    socket.emit('snapshot', agent.state.getSnapshot());
  }

  // Forward state events to this socket
  const events = [
    'price:binance', 'price:redstone', 'balance', 'markets',
    'intent', 'model', 'trade',
    'order:pending', 'order:removed',
    'position:open', 'position:close', 'position:updated',
    'stats', 'connection:kalshi', 'connection:polymarket', 'connection:binance',
  ];

  const handlers = {};
  for (const event of events) {
    handlers[event] = (data) => socket.emit(event, data);
    if (agent.state) {
      agent.state.on(event, handlers[event]);
    }
  }

  socket.on('disconnect', () => {
    console.log(`[Server] UI disconnected: ${socket.id}`);
    for (const event of events) {
      try {
        if (agent.state) {
          agent.state.removeListener(event, handlers[event]);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});

// Start server, then agent
server.listen(PORT, () => {
  console.log(`\n  KALSHIBOT MISSION CONTROL (Agentic Architecture)`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Skills API: http://localhost:${PORT}/api/skills`);
  console.log(`  Config: ${config.SERIES_TICKERS.join(',')} | MinEdge=${config.MIN_EDGE}% | MinDiv=${config.MIN_DIVERGENCE}% | MaxPos=$${config.MAX_POSITION_SIZE}\n`);

  // Bot does NOT auto-start — user controls via dashboard toggle
  console.log('  Bot is IDLE. Use the dashboard toggle to start trading.\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  if (agent.state) agent.state.saveNow();
  agent.stop();
  server.close();
  process.exit(0);
});

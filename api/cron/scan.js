/**
 * Vercel Cron: POST /api/cron/scan
 *
 * Triggered every minute by Vercel Cron to run one scan-and-trade cycle.
 * This is the serverless equivalent of the 2-second scan interval.
 *
 * Note: Vercel Cron minimum interval is 1 minute, so this bot will be
 * less aggressive than the persistent Node.js version. For higher frequency,
 * deploy on Railway/Render/VPS instead.
 */
const axios = require('axios');

module.exports = async (req, res) => {
  // Verify cron secret (Vercel sets this automatically)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // For Vercel deployment, the scan logic runs inline
    // This is a lightweight version that doesn't need the full MasterAgent
    const scanResult = await runScanCycle();
    res.json({ success: true, ...scanResult });
  } catch (err) {
    console.error('[Cron] Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

async function runScanCycle() {
  // Fetch BTC price from Binance
  const btcResp = await axios.get('https://api.binance.com/api/v3/ticker/bookTicker', {
    params: { symbol: 'BTCUSDT' },
    timeout: 5000,
  });
  const btcPrice = (parseFloat(btcResp.data.bidPrice) + parseFloat(btcResp.data.askPrice)) / 2;

  return {
    btcPrice,
    scannedAt: new Date().toISOString(),
    note: 'Full scan requires persistent MasterAgent. Use Railway/Render for production.',
  };
}

/**
 * Vercel Serverless: GET /api/health
 */
module.exports = (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    platform: 'vercel',
    timestamp: new Date().toISOString(),
  });
};

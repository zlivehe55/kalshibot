require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');

const apiKey = process.env.KALSHI_API_KEY;
const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem';

console.log('API Key:', apiKey);
console.log('Key path:', keyPath);
console.log('Key file exists:', fs.existsSync(keyPath));

const pem = fs.readFileSync(keyPath, 'utf8');
console.log('PEM starts with:', pem.substring(0, 40));
console.log('PEM length:', pem.length);
console.log('PEM lines:', pem.split('\n').length);

// Try signing
const timestampMs = Date.now().toString();
const method = 'GET';
const apiPath = '/trade-api/v2/portfolio/balance';
const message = timestampMs + method + apiPath;

try {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  const signature = sign.sign({
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, 'base64');
  console.log('Signature generated OK, length:', signature.length);

  // Try the actual request
  const baseUrl = 'https://api.elections.kalshi.com';
  axios.get(`${baseUrl}${apiPath}`, {
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': apiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    },
    timeout: 10000,
  }).then(res => {
    console.log('SUCCESS! Balance:', JSON.stringify(res.data));
  }).catch(err => {
    console.log('API Error:', err.response?.status, err.response?.data || err.message);
  });
} catch (e) {
  console.log('Signing error:', e.message);
}

# Troubleshooting Guide

## Common Errors and Solutions

### ❌ Error 401: "Request failed with status code 401"

**Cause**: Authentication is failing with Kalshi API

**Solutions**:
1. **Check your API credentials**:
   ```bash
   cat .env
   # Make sure KALSHI_API_KEY and KALSHI_API_SECRET are correct
   ```

2. **Get fresh credentials**:
   - Go to https://kalshi.com/settings/api
   - Create a new API key
   - Make sure to enable "Trading" permissions
   - Copy BOTH the key and secret to your `.env` file

3. **Format check**:
   ```env
   # .env file should look like this:
   KALSHI_API_KEY=abc123...
   KALSHI_API_SECRET=xyz789...
   
   # NO spaces around the = sign
   # NO quotes around the values
   ```

4. **Restart the bot** after changing `.env`:
   ```bash
   # Stop bot (Ctrl+C)
   # Start again
   npm start
   ```

### ❌ Error 404: "Request failed with status code 404"

**Cause**: The contract ticker doesn't exist on Kalshi yet

**Why this happens**:
- Kalshi creates these contracts dynamically
- The bot is trying to fetch a contract that hasn't been created yet
- This is NORMAL during the first few minutes

**Solution**:
✅ **This is expected behavior** - the bot will automatically skip these contracts and find valid ones. Just wait 1-2 minutes.

The bot discovers contracts like:
- `KXBTC15M-12FEB224500` (future contract, not created yet)
- `KXBTC15M-12FEB230000` (exists, will trade)

### ⚠️ "Error fetching Polymarket price"

**Cause**: Polymarket API integration is temporarily disabled in the code

**Current Status**:
The bot is using **simulated Polymarket prices** for testing. This is intentional and safe.

**To enable real Polymarket data**:
1. Map Kalshi contracts to Polymarket token IDs
2. Update the `fetchPolymarketPrice()` function
3. Uncomment the production code in that function

### 🔧 How to Test Your Setup

Run this test to verify your Kalshi API works:

```bash
# Create test file: test-kalshi.js
cat > test-kalshi.js << 'EOF'
require('dotenv').config();
const axios = require('axios');

async function testKalshi() {
  try {
    const response = await axios.get('https://trading-api.kalshi.com/trade-api/v2/portfolio/balance', {
      headers: {
        'Authorization': `Bearer ${process.env.KALSHI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ SUCCESS! Balance:', response.data);
  } catch (error) {
    console.log('❌ FAILED:', error.response?.status, error.response?.data || error.message);
  }
}

testKalshi();
EOF

# Run the test
node test-kalshi.js
```

**Expected output**:
```
✅ SUCCESS! Balance: { balance: 500000, payout: 0 }
```

If you see 401 error, your API key is wrong.

### 🐛 Enable Debug Mode

Add this to your `.env` to see more details:

```env
DEBUG=true
NODE_ENV=development
```

### 📊 Understanding the Logs

**Normal startup sequence**:
```
[SUCCESS] 🤖 Starting Kalshi Rolling Contracts Bot
[INFO] Testing Kalshi API connection...
[SUCCESS] Balance: $5000.00 ($5000.00 available)
[SUCCESS] ✅ Kalshi API connected successfully
[SUCCESS] 📋 Discovered contract: KXBTC15M-...
[INFO] Bot is running. Press Ctrl+C to stop.
```

**What each error means**:
- `401` = Bad API credentials
- `404` = Contract doesn't exist (normal for future contracts)
- `429` = Rate limited (too many requests)
- `500` = Kalshi server error (try again later)

### 🔑 Getting API Credentials

1. Log in to https://kalshi.com
2. Click your profile → Settings
3. Go to "API Keys" section
4. Click "Create New API Key"
5. **Enable "Trading" permission**
6. Copy both Key and Secret immediately
7. Paste into `.env` file

### 💡 Quick Fixes

**Bot won't start**:
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Check Node version (need 16+)
node --version
```

**Still getting 401 errors**:
```bash
# Regenerate your API key on Kalshi
# Delete the old one
# Create a new one
# Update .env file
```

**No contracts found**:
```bash
# Wait 2-3 minutes for Kalshi to create the next 15min contract
# The bot will auto-discover it
```

### 📞 Need More Help?

Check the Kalshi API documentation:
https://trading-api.kalshi.com/

Or check your API key status:
https://kalshi.com/settings/api
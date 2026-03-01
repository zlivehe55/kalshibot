# KALSHIBOT TRADING RULES

## Rule 1: Entry Conditions

### Directional Entry (Binance Spot Divergence)
- Binance BTC spot price must be live (updated within last 5 seconds)
- Model implied probability must diverge from Kalshi contract price by >= MIN_DIVERGENCE (default 8%)
- Time since market open must be < TRADING_WINDOW (default 10 minutes)
- Time until market close must be > 30 seconds
- Available balance must cover position cost

### Polymarket Arbitrage Entry
- Polymarket price data must be fresh (< 5 seconds old)
- Edge between Polymarket fair value and Kalshi ask must be >= MIN_EDGE (default 5%)
- Same time constraints as directional

### Dual-Side Arbitrage Entry
- Kalshi YES ask + NO ask must be < $0.98 (guaranteed 2%+ profit)
- Both sides must have sufficient liquidity
- Position divided equally between YES and NO

## Rule 2: Position Sizing

### Kelly Criterion
```
kelly_fraction = (b * p - q) / b
where:
  b = payout odds = (1 / (1 - probability)) - 1
  p = estimated win probability
  q = 1 - p

position_size = kelly_fraction * KELLY_FRACTION * available_balance
capped at MAX_POSITION_SIZE
```

### Size Limits
- Maximum single position: MAX_POSITION_SIZE ($25 default)
- Maximum total open positions: MAX_TOTAL_OPEN_POSITIONS (10 default)
- Maximum positions per contract: MAX_POSITIONS_PER_CONTRACT (2 default)
- Never risk more than 25% of available balance on a single trade
- Dual-side trades: split position equally (half YES, half NO)

## Rule 3: Take Profit

### Before Settlement
- If position gains >15% of entry price → SELL
- If position captures >50% of maximum possible gain (entry to $1) → SELL
- If edge reverses (model now favors opposite direction) → SELL
- Always leave at least 30 seconds before close for sell orders to fill

### At Settlement
- If take-profit was not triggered, hold to settlement
- Record result (win/loss) and actual P&L vs expected

## Rule 4: Risk Management

### Per-Trade Risk
- Maximum loss per trade: position cost (binary outcome, max loss is premium paid)
- Never average down on losing positions
- No doubling after losses

### Portfolio Risk
- Maximum total exposure: SUM of all position costs < 50% of total balance
- If cumulative session loss exceeds 10% of starting balance → reduce position sizes by 50%
- If cumulative session loss exceeds 20% → pause trading for 15 minutes

### Operational Risk
- If Binance WebSocket disconnects → pause directional trading (keep arb running)
- If Kalshi API returns errors → stop all new trades, manage existing positions
- If RedStone and Binance both fail → full stop

## Rule 5: Probability Model

### Inputs
- Current BTC price from Binance (primary, ~200ms updates)
- BTC price at market open (reference point)
- Realized volatility from recent Binance price history
- Time remaining in the 15-minute window

### Calculation
```
move = (current_price - open_price) / open_price
sigma = realized_volatility * sqrt(time_remaining / total_duration)
z_score = move / sigma
probability_up = NormalCDF(z_score)
probability_down = 1 - probability_up
```

### Calibration
- Volatility estimated from 15-minute rolling window of 1-second price samples
- Minimum 10 samples required for valid estimate
- Default volatility: 0.15% per 15-minute period if insufficient data

## Rule 6: Order Execution

### Order Type
- Always use LIMIT orders (never market)
- Price set at current best ask for buys, current best bid for sells

### Timing
- Minimum 300ms delay between consecutive orders
- Rate limit: max 1 order per second per contract

### Fill Handling
- Track fill count from order response
- Unfilled orders expire with the contract
- Partially filled positions managed at filled quantity

## Rule 7: Market Selection

### Series
- Primary: KXBTC15M (15-minute Bitcoin rolling contracts on Kalshi)
- Only trade markets with status "active" or "open"

### Discovery
- Poll for new markets every 15 seconds
- Record BTC spot price at market open for each new market
- Clean up expired market references

## Rule 8: Data Priority

### Price Sources (in order of trust)
1. Binance spot WebSocket (fastest, ~200ms latency)
2. RedStone oracle (aggregated, cryptographically signed)
3. Polymarket CLOB prices (lagging 3-7s, used for fair value comparison)

### When Sources Disagree
- Use Binance for probability model (fastest)
- Use Polymarket for cross-market arbitrage signals
- Use RedStone as validation (flag if >1% deviation from Binance)

## Rule 9: Logging & Transparency

- Log every signal detection with: ticker, side, model probability, contract price, edge, action
- Log every trade execution with: order ID, fill status, cost
- Log every settlement with: result, P&L, cost, payout
- Broadcast intent to Mission Control UI in real-time
- Record P&L history for charting

## Rule 10: Shutdown Conditions

### Graceful Stop (SIGINT)
- Stop scanning for new opportunities
- Let existing positions settle naturally
- Log final statistics

### Emergency Stop
- If 5 consecutive trade executions fail → stop trading
- If balance drops below $5 → stop trading
- If API authentication fails (401) → stop immediately

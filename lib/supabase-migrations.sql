-- Kalshibot Supabase Schema
-- Run this in your Supabase SQL Editor to set up tables.
-- Requires pgvector extension for RAG embeddings.

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Bot state (single row, JSON blob)
CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Signals (ML training data)
CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  price_cents INTEGER,
  edge REAL,
  model_prob REAL,
  contracts INTEGER,
  reason TEXT,
  executed BOOLEAN DEFAULT TRUE,
  blocked_reason TEXT,
  outcome_won BOOLEAN,
  outcome_pnl REAL,
  settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_id TEXT UNIQUE,
  client_order_id TEXT,
  signal_id BIGINT REFERENCES signals(id),
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  action TEXT NOT NULL,
  price_cents INTEGER,
  count INTEGER,
  status TEXT,
  fill_count INTEGER DEFAULT 0,
  taker_fill_cost INTEGER DEFAULT 0,
  taker_fees INTEGER DEFAULT 0,
  close_time BIGINT
);

-- Market snapshots
CREATE TABLE IF NOT EXISTS market_snapshots (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker TEXT NOT NULL,
  yes_bid REAL,
  yes_ask REAL,
  no_bid REAL,
  no_ask REAL,
  btc_price REAL,
  time_remaining_s REAL,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ticker ON market_snapshots(ticker);

-- ML features (for model training)
CREATE TABLE IF NOT EXISTS ml_features (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker TEXT,
  signal_type TEXT,
  features JSONB NOT NULL,
  label INTEGER,
  signal_id BIGINT REFERENCES signals(id)
);
CREATE INDEX IF NOT EXISTS idx_ml_features_label ON ml_features(label);

-- ML predictions (feedback loop)
CREATE TABLE IF NOT EXISTS ml_predictions (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signal_id BIGINT REFERENCES signals(id),
  model_version TEXT,
  confidence REAL,
  predicted_outcome INTEGER,
  features_hash TEXT
);

-- RAG embeddings (pgvector)
CREATE TABLE IF NOT EXISTS embeddings (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Similarity search function for RAG
CREATE OR REPLACE FUNCTION match_embeddings(
  query_embedding vector(1536),
  match_count INT DEFAULT 5
)
RETURNS TABLE(id BIGINT, content TEXT, metadata JSONB, similarity REAL)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, e.content, e.metadata,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM embeddings e
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

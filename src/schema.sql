PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  rating   INTEGER NOT NULL CHECK(rating >= 0 AND rating <= 1000),
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,

  p1_id TEXT NOT NULL,
  p2_id TEXT NOT NULL,

  status TEXT NOT NULL CHECK(status IN ('active','cancelled','resolved','timed_out')),
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,

  winner_id TEXT,
  winner_games INTEGER,
  loser_games INTEGER,
  reported_by TEXT,

  p1_rating_before INTEGER,
  p2_rating_before INTEGER,
  p1_rating_after INTEGER,
  p2_rating_after INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sets_active_channel
  ON sets(guild_id, channel_id, status);

CREATE INDEX IF NOT EXISTS idx_sets_active_p1
  ON sets(guild_id, channel_id, p1_id, status);

CREATE INDEX IF NOT EXISTS idx_sets_active_p2
  ON sets(guild_id, channel_id, p2_id, status);
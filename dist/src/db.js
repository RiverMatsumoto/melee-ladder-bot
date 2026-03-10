import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
export function nowSec() {
    return Math.floor(Date.now() / 1000);
}
export function openDb(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
}
export function runMigrations(db, schemaSql) {
    db.exec(schemaSql);
}
export function timeoutSweep(db, ts) {
    db.prepare(`
    UPDATE sets
    SET status='timed_out', ended_at=@ts
    WHERE status='active' AND expires_at <= @ts
  `).run({ ts });
}
export function ensurePlayer(db, guildId, userId, defaultRating, ts) {
    db.prepare(`
    INSERT INTO players (guild_id, user_id, rating, games_played, wins, losses, created_at, updated_at)
    VALUES (@g, @u, @r, 0, 0, 0, @ts, @ts)
    ON CONFLICT(guild_id, user_id) DO NOTHING
  `).run({ g: guildId, u: userId, r: defaultRating, ts });
}
export function getPlayer(db, guildId, userId) {
    return db
        .prepare(`SELECT * FROM players WHERE guild_id=? AND user_id=?`)
        .get(guildId, userId);
}
export function userHasActiveSet(db, guildId, channelId, userId) {
    const row = db.prepare(`
    SELECT 1 FROM sets
    WHERE guild_id=? AND channel_id=? AND status='active'
      AND (p1_id=? OR p2_id=?)
    LIMIT 1
  `).get(guildId, channelId, userId, userId);
    return !!row;
}
export function findActiveSetForUser(db, guildId, channelId, userId) {
    return db.prepare(`
    SELECT * FROM sets
    WHERE guild_id=? AND channel_id=? AND status='active'
      AND (p1_id=? OR p2_id=?)
    ORDER BY started_at DESC
    LIMIT 1
  `).get(guildId, channelId, userId, userId);
}
export function createSet(db, guildId, channelId, p1Id, p2Id, startedAt, expiresAt) {
    const info = db.prepare(`
    INSERT INTO sets (guild_id, channel_id, p1_id, p2_id, status, started_at, expires_at)
    VALUES (@g, @c, @p1, @p2, 'active', @sa, @ea)
  `).run({ g: guildId, c: channelId, p1: p1Id, p2: p2Id, sa: startedAt, ea: expiresAt });
    return Number(info.lastInsertRowid);
}
export function getSetCount(db, guildId, player1Id, player2Id) {
    const row = db
        .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN winner_id=@p1 THEN 1 ELSE 0 END), 0) AS wins,
        COALESCE(SUM(CASE WHEN winner_id=@p2 THEN 1 ELSE 0 END), 0) AS losses
      FROM sets
      WHERE guild_id=@g
        AND status='resolved'
        AND (
          (p1_id=@p1 AND p2_id=@p2) OR
          (p1_id=@p2 AND p2_id=@p1)
        )
    `)
        .get({ g: guildId, p1: player1Id, p2: player2Id });
    return { wins: row.wins, losses: row.losses };
}

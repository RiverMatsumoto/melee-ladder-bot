import "dotenv/config";
import fs from "node:fs";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { applyElo } from "./elo.js";
import {
  createSet,
  ensurePlayer,
  findActiveSetForUser,
  getPlayer,
  nowSec,
  openDb,
  runMigrations,
  timeoutSweep,
  userHasActiveSet,
} from "./db.js";
import { resolveMember } from "./resolve.js";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("DISCORD_TOKEN missing");

const DB_PATH = process.env.DB_PATH ?? "./data/bot.sqlite";
const DEFAULT_RATING = Number(process.env.DEFAULT_RATING ?? "500");
const PREFIX = process.env.PREFIX ?? "!";

const schemaSql = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

const db = openDb(DB_PATH);
runMigrations(db, schemaSql);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

function parseCommand(content: string): { cmd: string; rest: string } | null {
  if (!content.startsWith(PREFIX)) return null;
  const body = content.slice(PREFIX.length).trim();
  if (!body) return null;
  const [cmd, ...rest] = body.split(/\s+/);
  return { cmd: cmd.toLowerCase(), rest: rest.join(" ") };
}

function parseScore(s: string): { w: number; l: number } | null {
  const m = s.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const w = Number(m[1]);
  const l = Number(m[2]);
  if (!Number.isInteger(w) || !Number.isInteger(l)) return null;
  if (w <= 0 || l < 0) return null;
  if (l >= w) return null; // winner must have more wins
  if (w > 9 || l > 9) return null;
  return { w, l };
}

const mention = (id: string) => `<@${id}>`;

client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const parsed = parseCommand(msg.content);
  if (!parsed) return;

  const guildId = msg.guild.id;
  const channelId = msg.channel.id;
  const authorId = msg.author.id;
  const ts = nowSec();

  timeoutSweep(db, ts);

  try {
    if (parsed.cmd === "play") {
      const q = parsed.rest.trim();
      if (!q) {
        await msg.reply(`usage: ${PREFIX}play <DISCORD_USERNAME or @mention>`);
        return;
      }

      const resolved = await resolveMember(msg.guild, q);
      if (!resolved) {
        await msg.reply(`no match for "${q}" (try @mention)`);
        return;
      }
      if ("ambiguous" in resolved) {
        const opts = resolved.ambiguous
          .map((m) => `${m.user.username}${m.nickname ? ` (nick: ${m.nickname})` : ""}`)
          .join(", ");
        await msg.reply(`ambiguous "${q}". matches: ${opts}. try @mention or be more specific.`);
        return;
      }

      const target = resolved;
      if (target.user.bot) {
        await msg.reply("cannot start a set vs a bot");
        return;
      }
      if (target.id === authorId) {
        await msg.reply("cannot start a set vs yourself");
        return;
      }

      if (userHasActiveSet(db, guildId, channelId, authorId)) {
        await msg.reply("you already have an active set in this channel");
        return;
      }
      if (userHasActiveSet(db, guildId, channelId, target.id)) {
        await msg.reply(`${mention(target.id)} already has an active set in this channel`);
        return;
      }

      ensurePlayer(db, guildId, authorId, DEFAULT_RATING, ts);
      ensurePlayer(db, guildId, target.id, DEFAULT_RATING, ts);

      const setId = createSet(db, guildId, channelId, authorId, target.id, ts, ts + 7200);
      await msg.reply(
        `set #${setId} started: ${mention(authorId)} vs ${mention(target.id)}. ` +
          `end with "${PREFIX}win W-L" (winner runs it). timeout in 2h.`,
      );
      return;
    }

    if (parsed.cmd === "cancel") {
      const active = findActiveSetForUser(db, guildId, channelId, authorId);
      if (!active) {
        await msg.reply("no active set to cancel in this channel");
        return;
      }

      db.prepare(`UPDATE sets SET status='cancelled', ended_at=@ts WHERE id=@id AND status='active'`).run({
        ts,
        id: active.id,
      });

      await msg.reply(`cancelled set #${active.id}`);
      return;
    }

    if (parsed.cmd === "win") {
      const score = parseScore(parsed.rest);
      if (!score) {
        await msg.reply(`usage: ${PREFIX}win W-L (example: ${PREFIX}win 3-2)`);
        return;
      }

      const txn = db.transaction(() => {
        timeoutSweep(db, ts);

        const active = findActiveSetForUser(db, guildId, channelId, authorId);
        if (!active) throw new Error("NO_ACTIVE");

        if (active.expires_at <= ts) {
          db.prepare(`UPDATE sets SET status='timed_out', ended_at=@ts WHERE id=@id AND status='active'`).run({
            ts,
            id: active.id,
          });
          throw new Error("TIMED_OUT");
        }

        const winnerId = authorId;
        const loserId = active.p1_id === authorId ? active.p2_id : active.p1_id;

        ensurePlayer(db, guildId, winnerId, DEFAULT_RATING, ts);
        ensurePlayer(db, guildId, loserId, DEFAULT_RATING, ts);

        const winner = getPlayer(db, guildId, winnerId);
        const loser = getPlayer(db, guildId, loserId);
        if (!winner || !loser) throw new Error("PLAYER_MISSING");

        const elo = applyElo(winner.rating, loser.rating, score.w, score.l, 32);

        const p1Before = active.p1_id === winnerId ? winner.rating : loser.rating;
        const p2Before = active.p2_id === winnerId ? winner.rating : loser.rating;
        const p1After = active.p1_id === winnerId ? elo.winnerAfter : elo.loserAfter;
        const p2After = active.p2_id === winnerId ? elo.winnerAfter : elo.loserAfter;

        db.prepare(`
          UPDATE sets
          SET status='resolved',
              ended_at=@ts,
              winner_id=@winner_id,
              winner_games=@wg,
              loser_games=@lg,
              reported_by=@reported_by,
              p1_rating_before=@p1_before,
              p2_rating_before=@p2_before,
              p1_rating_after=@p1_after,
              p2_rating_after=@p2_after
          WHERE id=@id AND status='active'
        `).run({
          ts,
          id: active.id,
          winner_id: winnerId,
          wg: score.w,
          lg: score.l,
          reported_by: authorId,
          p1_before: p1Before,
          p2_before: p2Before,
          p1_after: p1After,
          p2_after: p2After,
        });

        db.prepare(`
          UPDATE players
          SET rating=@r, games_played=games_played+1, wins=wins+1, updated_at=@ts
          WHERE guild_id=@g AND user_id=@u
        `).run({ g: guildId, u: winnerId, r: elo.winnerAfter, ts });

        db.prepare(`
          UPDATE players
          SET rating=@r, games_played=games_played+1, losses=losses+1, updated_at=@ts
          WHERE guild_id=@g AND user_id=@u
        `).run({ g: guildId, u: loserId, r: elo.loserAfter, ts });

        return { setId: active.id, winnerId, loserId, elo };
      });

      try {
        const r = txn();
        await msg.reply(
          `set #${r.setId} resolved: ${mention(r.winnerId)} won ${score.w}-${score.l} vs ${mention(r.loserId)}. ` +
            `ELO: ${r.elo.deltaWinner >= 0 ? "+" : ""}${r.elo.deltaWinner} / ${r.elo.deltaLoser}. ` +
            `new: ${r.elo.winnerAfter} / ${r.elo.loserAfter}`,
        );
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (m === "NO_ACTIVE") await msg.reply("no active set to report in this channel");
        else if (m === "TIMED_OUT") await msg.reply("that set timed out (2h). start a new one.");
        else throw e;
      }
      return;
    }

    if (parsed.cmd === "rating") {
      const targetId = msg.mentions.users.first()?.id ?? authorId;
      ensurePlayer(db, guildId, targetId, DEFAULT_RATING, ts);
      const p = getPlayer(db, guildId, targetId)!;
      await msg.reply(`${mention(targetId)} rating: ${p.rating} (W-L ${p.wins}-${p.losses}, sets ${p.games_played})`);
      return;
    }
  } catch (err) {
    console.error(err);
    await msg.reply("error (check server logs)");
  }
});

client.once(Events.ClientReady, () => {
  console.log(`smashbot logged in as ${client.user?.tag}`);
});

await client.login(TOKEN);
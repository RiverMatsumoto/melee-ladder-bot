import type { Guild, GuildMember } from "discord.js";

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function score(hay: string, needle: string): number {
  const h = norm(hay);
  const n = norm(needle);
  if (!h || !n) return 0;
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 60;
  return 0;
}

export async function resolveMember(
  guild: Guild,
  query: string,
): Promise<GuildMember | { ambiguous: GuildMember[] } | null> {
  const q = query.trim();

  const mention = q.match(/^<@!?(\d+)>$/);
  if (mention) {
    try {
      return await guild.members.fetch(mention[1]);
    } catch {
      return null;
    }
  }

  // populate cache
  await guild.members.fetch().catch(() => {});

  const members = [...guild.members.cache.values()];
  const scored = members
    .map((m) => {
      const u = m.user.username ?? "";
      const g = m.user.globalName ?? "";
      const n = m.nickname ?? "";
      const s = Math.max(score(u, q), score(g, q), score(n, q));
      return { m, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (scored.length === 0) return null;

  const best = scored[0].s;
  const tied = scored.filter((x) => x.s === best).map((x) => x.m);

  if (tied.length === 1) return tied[0];
  return { ambiguous: tied.slice(0, 5) };
}
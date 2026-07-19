import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  type Message,
  type GuildMember,
  EmbedBuilder,
} from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../../data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Types ────────────────────────────────────────────────────────────────────

interface Config {
  prefix: string;
  vouchChannelId: string | null;
  logChannelId: string | null;
  announceChannelId: string | null;
  genChannelId: string | null;
  autorole: { statusText: string; roleId: string } | null;
  boostRoleId: string | null;
  premiumRoleId: string | null;
  genRoleId: string | null;
  lowStockThreshold: number;
  minAccountAgeDays: number;
  vouchTimeoutMinutes: number;
  allowedGuildIds: string[];
  ownerId: string | null;
}

interface BlacklistEntry { id: string; type: "temp" | "perm"; until?: number }
interface Blacklist  { users: BlacklistEntry[] }

// Tiered stocks: each tier has its own named stocks
interface TieredStocks {
  free:    { [name: string]: string[] };
  premium: { [name: string]: string[] };
  boost:   { [name: string]: string[] };
}

interface Cooldowns  { [userId: string]: number }
interface DailyUsage { [userId: string]: { date: string; count: number } }
interface PendingVouch {
  pendingSince: number;
  warned: boolean;
  stockName: string;
  tier: string;
  guildId: string;
  username: string;
}
interface PendingVouches { [userId: string]: PendingVouch }
interface MissCount { [userId: string]: number }
interface GenStats  { total: number; byStock: { [name: string]: number } }

// ─── Tier config ──────────────────────────────────────────────────────────────

type Tier = "boost" | "premium" | "free";
const TIER: Record<Tier, { cooldownMs: number; dailyLimit: number; label: string; emoji: string }> = {
  boost:   { cooldownMs: 5  * 60_000, dailyLimit: 45, label: "Boost",   emoji: "🚀" },
  premium: { cooldownMs: 7  * 60_000, dailyLimit: 30, label: "Premium", emoji: "⭐" },
  free:    { cooldownMs: 10 * 60_000, dailyLimit: 20, label: "Free",    emoji: "👤" },
};
const MISS_DURATIONS = [0, 30, 40, 50, 60];

// ─── Data helpers ─────────────────────────────────────────────────────────────

function readJson<T>(file: string, def: T): T {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return def;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return def; }
}
function writeJson(file: string, data: unknown) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

const DEFAULT_STOCKS: TieredStocks = { free: {}, premium: {}, boost: {} };

const getConfig = (): Config => {
  const def: Config = {
    prefix: "&", vouchChannelId: null, logChannelId: null, announceChannelId: null,
    genChannelId: null, autorole: null, boostRoleId: null, premiumRoleId: null,
    genRoleId: null, lowStockThreshold: 5, minAccountAgeDays: 0, vouchTimeoutMinutes: 3,
    allowedGuildIds: [],
    ownerId: null,
  };
  const cfg = readJson<Config>("config.json", def);
  if (!cfg.allowedGuildIds) cfg.allowedGuildIds = [];
  return cfg;
};

function getStocks(): TieredStocks {
  const raw = readJson<unknown>("stocks.json", DEFAULT_STOCKS);
  // migrate old flat format
  if (raw && typeof raw === "object" && !("free" in raw)) {
    return { free: raw as { [k: string]: string[] }, premium: {}, boost: {} };
  }
  const s = raw as TieredStocks;
  return { free: s.free ?? {}, premium: s.premium ?? {}, boost: s.boost ?? {} };
}

const getBlacklist  = () => readJson<Blacklist>     ("blacklist.json",{ users: [] });
const getCooldowns  = () => readJson<Cooldowns>     ("cooldowns.json",{});
const getDailyUsage = () => readJson<DailyUsage>    ("daily.json",    {});
const getPending    = () => readJson<PendingVouches>("vouches.json",  {});
const getMisses     = () => readJson<MissCount>     ("misses.json",   {});
const getGenStats   = () => readJson<GenStats>      ("genstats.json", { total: 0, byStock: {} });

function todayStr() { return new Date().toISOString().slice(0, 10); }

function getUserTier(member: GuildMember, cfg: Config): Tier {
  if (cfg.boostRoleId   && member.roles.cache.has(cfg.boostRoleId))   return "boost";
  if (cfg.premiumRoleId && member.roles.cache.has(cfg.premiumRoleId)) return "premium";
  return "free";
}

function isAdmin(msg: Message) {
  return msg.member?.permissions.has("ManageGuild") || msg.member?.permissions.has("Administrator") || false;
}

function checkBlacklist(userId: string): { listed: boolean; entry?: BlacklistEntry } {
  const bl = getBlacklist();
  const entry = bl.users.find(u => u.id === userId);
  if (!entry) return { listed: false };
  if (entry.type === "perm") return { listed: true, entry };
  if (entry.type === "temp" && entry.until && Date.now() < entry.until) return { listed: true, entry };
  bl.users = bl.users.filter(u => !(u.id === userId && u.type === "temp" && u.until && Date.now() >= u.until));
  writeJson("blacklist.json", bl);
  return { listed: false };
}

function msToStr(ms: number) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}m ${sec}s`;
}

// ─── Auto-miss blacklist ───────────────────────────────────────────────────────

async function applyMissBlacklist(
  client: Client, userId: string, username: string,
  logChannelId: string | null, guildId: string
): Promise<void> {
  const misses = getMisses();
  const count = (misses[userId] ?? 0) + 1;
  misses[userId] = count;
  writeJson("misses.json", misses);

  const bl = getBlacklist();
  bl.users = bl.users.filter(u => u.id !== userId);
  let durationText: string;
  if (count >= 5) {
    bl.users.push({ id: userId, type: "perm" });
    durationText = "**permanently**";
  } else {
    const mins = MISS_DURATIONS[count] ?? 30;
    bl.users.push({ id: userId, type: "temp", until: Date.now() + mins * 60_000 });
    durationText = `for **${mins} minutes**`;
  }
  writeJson("blacklist.json", bl);

  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("⛔ You Have Been Blacklisted")
      .setDescription(`You have been blacklisted ${durationText} for missing your vouch.\n\n**Miss count:** ${count}${count >= 5 ? " — Permanent ban" : ""}\n\nIf you think this is a mistake, **make a ticket** in the server.`).setTimestamp()] });
  } catch { /* DMs closed */ }

  if (logChannelId) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const ch = guild.channels.cache.get(logChannelId);
      if (ch?.isTextBased()) {
        await ch.send({ embeds: [new EmbedBuilder().setColor(0xff6b6b).setTitle("⛔ Auto Miss-Vouch Blacklist")
          .addFields({ name: "User", value: `<@${userId}> (${username})`, inline: true }, { name: "Miss Count", value: `${count}`, inline: true }, { name: "Duration", value: durationText, inline: true }).setTimestamp()] });
      }
    } catch { /* log error */ }
  }
}

// ─── Low stock alert ──────────────────────────────────────────────────────────

async function checkLowStock(client: Client, stockName: string, tier: string, remaining: number, cfg: Config) {
  if (remaining > cfg.lowStockThreshold || !cfg.logChannelId) return;
  try {
    for (const guild of client.guilds.cache.values()) {
      const ch = guild.channels.cache.get(cfg.logChannelId);
      if (ch?.isTextBased()) {
        await ch.send({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle("⚠️ Low Stock Alert")
          .setDescription(`**[${tier.toUpperCase()}]** Stock **${stockName}** has only **${remaining}** item(s) left!`).setTimestamp()] });
        break;
      }
    }
  } catch { /* ignore */ }
}

// ─── Gen log ──────────────────────────────────────────────────────────────────

async function logGen(client: Client, userId: string, username: string, stockName: string, tier: string, cfg: Config, remaining: number) {
  if (!cfg.logChannelId) return;
  try {
    for (const guild of client.guilds.cache.values()) {
      const ch = guild.channels.cache.get(cfg.logChannelId);
      if (ch?.isTextBased()) {
        await ch.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("📦 Gen Log")
          .addFields(
            { name: "User",  value: `<@${userId}> (${username})`, inline: true },
            { name: "Stock", value: `[${tier.toUpperCase()}] ${stockName}`, inline: true },
            { name: "Left",  value: `${remaining} items`, inline: true }
          ).setTimestamp()] });
        break;
      }
    }
  } catch { /* ignore */ }
}

// ─── Core gen logic ───────────────────────────────────────────────────────────

async function handleGen(
  message: Message,
  client: Client,
  stockTier: Tier,   // which stock pool to pull from
  stockName: string,
  cfg: Config
) {
  if (!message.guild || !message.member) return;

  const userTier = getUserTier(message.member, cfg);
  const prefix = cfg.prefix;

  // Tier access check
  // Boost: can use free + boost (NOT premium)
  // Premium: can use free + premium (NOT boost)
  // Free: can use free only
  const allowed: Record<Tier, Tier[]> = {
    free:    ["free"],
    premium: ["free", "premium"],
    boost:   ["free", "boost"],
  };
  if (!allowed[userTier].includes(stockTier)) {
    const needed = stockTier === "premium" ? "Premium ⭐" : "Boost 🚀";
    return void message.reply(`❌ You need the **${needed}** role to use \`${prefix}${stockTier}\`.`);
  }

  // Account age
  if (cfg.minAccountAgeDays > 0) {
    const accountAge = (Date.now() - message.author.createdTimestamp) / 86_400_000;
    if (accountAge < cfg.minAccountAgeDays)
      return void message.reply(
        `❌ Your account must be at least **${cfg.minAccountAgeDays} day(s)** old.\nYours is **${Math.floor(accountAge)} day(s)** old.`
      );
  }

  // Gen channel
  if (cfg.genChannelId && message.channelId !== cfg.genChannelId)
    return void message.reply(`❌ Use \`${prefix}${stockTier}\` only in <#${cfg.genChannelId}>.`);

  // Gen role — skip check for boost/premium users (they don't need status role)
  const isPrivileged = userTier === "boost" || userTier === "premium";
  if (!isPrivileged && cfg.genRoleId && !message.member.roles.cache.has(cfg.genRoleId))
    return void message.reply(`❌ You need the <@&${cfg.genRoleId}> role.`);

  // Blacklist
  const { listed } = checkBlacklist(message.author.id);
  if (listed) return void message.reply("🚫 You are blacklisted and cannot gen.");

  const { cooldownMs, dailyLimit, label, emoji } = TIER[userTier];

  // Cooldown
  const cooldowns = getCooldowns();
  const lastUsed = cooldowns[message.author.id];
  if (lastUsed && Date.now() - lastUsed < cooldownMs) {
    const left = cooldownMs - (Date.now() - lastUsed);
    return void message.reply(`⏳ Wait **${msToStr(left)}** before genning again.\n${emoji} ${label} cooldown: ${cooldownMs / 60_000} min`);
  }

  // Daily limit
  const daily = getDailyUsage();
  const today = todayStr();
  const todayCount = daily[message.author.id]?.date === today ? daily[message.author.id]!.count : 0;
  if (todayCount >= dailyLimit)
    return void message.reply(`📵 Daily limit reached: **${dailyLimit} gens** (${emoji} ${label}). Come back tomorrow!`);

  // Stock
  const stocks = getStocks();
  const pool = stocks[stockTier];
  if (!pool[stockName]) return void message.reply(`❌ Stock \`${stockName}\` does not exist in **${stockTier}** tier.`);
  if (pool[stockName]!.length === 0) return void message.reply(`❌ **${stockName}** (${stockTier}) is out of stock!`);

  const item = pool[stockName]!.shift()!;
  const remaining = pool[stockName]!.length;
  writeJson("stocks.json", stocks);

  cooldowns[message.author.id] = Date.now();
  writeJson("cooldowns.json", cooldowns);

  daily[message.author.id] = { date: today, count: todayCount + 1 };
  writeJson("daily.json", daily);

  const stats = getGenStats();
  stats.total++;
  stats.byStock[stockName] = (stats.byStock[stockName] ?? 0) + 1;
  writeJson("genstats.json", stats);

  const vouchLine = cfg.vouchChannelId
    ? `\n\n✅ **Vouch here:** <#${cfg.vouchChannelId}>\n⚠️ **No vouch = auto-blacklist**`
    : "";

  try {
    await message.author.send({ embeds: [new EmbedBuilder().setColor(0x57f287)
      .setTitle(`📦 Your item — ${stockName} [${stockTier.toUpperCase()}]`)
      .setDescription(`\`\`\`\n${item}\n\`\`\`${vouchLine}`)
      .addFields({ name: "Your Tier", value: `${emoji} ${label} — ${todayCount + 1}/${dailyLimit} gens today`, inline: true })
      .setFooter({ text: "Enjoy! Remember to vouch." }).setTimestamp()] });

    await message.reply(`✅ Check your DMs, ${message.author}! (**${todayCount + 1}/${dailyLimit}** gens today)`);

    if (cfg.vouchChannelId) {
      const pending = getPending();
      pending[message.author.id] = {
        pendingSince: Date.now(), warned: false,
        stockName, tier: stockTier,
        guildId: message.guild.id, username: message.author.tag,
      };
      writeJson("vouches.json", pending);
    }

    await logGen(client, message.author.id, message.author.tag, stockName, stockTier, cfg, remaining);
    await checkLowStock(client, stockName, stockTier, remaining, cfg);

  } catch {
    // Refund
    pool[stockName]!.unshift(item);
    writeJson("stocks.json", stocks);
    delete cooldowns[message.author.id];
    writeJson("cooldowns.json", cooldowns);
    daily[message.author.id] = { date: today, count: todayCount };
    writeJson("daily.json", daily);
    stats.total--;
    stats.byStock[stockName] = Math.max(0, (stats.byStock[stockName] ?? 1) - 1);
    writeJson("genstats.json", stats);
    await message.reply("❌ Could not DM you. Please open your DMs and try again.");
  }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

export function startBot(): void {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) { logger.warn("DISCORD_TOKEN not set — bot will not start."); return; }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
  });

  client.once("clientReady", () => logger.info(`Bot logged in as ${client.user?.tag}`));

  // ── Auto-leave unauthorized servers ──────────────────────────────────────
  client.on("guildCreate", async (guild) => {
    const cfg = getConfig();
    if (cfg.allowedGuildIds.length > 0 && !cfg.allowedGuildIds.includes(guild.id)) {
      logger.info(`Unauthorized server joined: ${guild.name} (${guild.id}) — leaving.`);
      await guild.leave();
    }
  });

  // ── Status role auto-remove ───────────────────────────────────────────────
  client.on("presenceUpdate", async (_old, newPresence) => {
    try {
      const cfg = getConfig();
      if (!cfg.autorole || !newPresence?.member) return;
      const { statusText, roleId } = cfg.autorole;
      const member = newPresence.member;
      if (!member.roles.cache.has(roleId)) return;
      const activity = newPresence.activities.find(a => a.type === ActivityType.Custom);
      const currentStatus = activity?.state ?? "";
      if (!currentStatus.toLowerCase().includes(statusText.toLowerCase())) {
        await member.roles.remove(roleId);
      }
    } catch { /* ignore */ }
  });

  // ── Vouch interval ────────────────────────────────────────────────────────
  setInterval(() => {
    void (async () => {
      try {
        const pending = getPending();
        const cfg = getConfig();
        const now = Date.now();
        const TIMEOUT_MS = cfg.vouchTimeoutMinutes * 60_000;
        const TWO_MIN = 2 * 60_000;
        let changed = false;

        for (const [userId, data] of Object.entries(pending)) {
          const age = now - data.pendingSince;

          if (age >= TIMEOUT_MS) {
            delete pending[userId];
            changed = true;
            writeJson("vouches.json", pending);
            try { await applyMissBlacklist(client, userId, data.username, cfg.logChannelId, data.guildId); }
            catch (err) { logger.error({ err }, `applyMissBlacklist failed for ${userId}`); }
            continue;
          }

          if (!data.warned && age >= TWO_MIN) {
            try {
              const user = await client.users.fetch(userId);
              const vouchMention = cfg.vouchChannelId ? `<#${cfg.vouchChannelId}>` : "the vouch channel";
              await user.send({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle("⚠️ Vouch Reminder")
                .setDescription(`You received **${data.stockName}** but haven't vouched yet!\n\n✅ **Vouch here:** ${vouchMention}\n\n⛔ **No vouch = auto-blacklist**`).setTimestamp()] });
            } catch { /* DMs closed */ }
            pending[userId]!.warned = true;
            changed = true;
          }
        }
        if (changed) writeJson("vouches.json", pending);
      } catch (err) { logger.error({ err }, "Vouch interval error"); }
    })();
  }, 30_000);

  // ── Message handler ───────────────────────────────────────────────────────
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    const cfg = getConfig();

    // ── Guild whitelist check (owner bypasses) ───────────────────────────
    const isOwner = cfg.ownerId ? message.author.id === cfg.ownerId : false;
    if (!isOwner && message.guild && cfg.allowedGuildIds.length > 0 && !cfg.allowedGuildIds.includes(message.guild.id)) return;

    // ── Vouch channel: strict validation ─────────────────────────────────
    if (cfg.vouchChannelId && message.channelId === cfg.vouchChannelId && message.guild) {
      const pending = getPending();
      const entry = pending[message.author.id];

      if (!entry) {
        try { await message.delete(); } catch { /* no perms */ }
        return;
      }

      const content = message.content.toLowerCase();
      if (!content.startsWith("legit got") || !content.includes(entry.stockName.toLowerCase())) {
        try { await message.delete(); } catch { /* no perms */ }
        try {
          await message.author.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("❌ Wrong Vouch Format")
            .setDescription(`Your message was deleted.\n\nYour vouch must:\n• Start with **legit got**\n• Include the stock name: **${entry.stockName}**\n\nExample: \`legit got ${entry.stockName} from ping me\``).setTimestamp()] });
        } catch { /* DMs closed */ }
        return;
      }

      delete pending[message.author.id];
      writeJson("vouches.json", pending);
      try {
        await message.author.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("✅ Vouch Received!")
          .setDescription("Your vouch is done, thanks for vouching! 🙏\n\nYou're all good — enjoy your item!").setTimestamp()] });
      } catch { /* DMs closed */ }
      return;
    }

    if (!message.guild) return;
    const prefix = cfg.prefix;
    if (!message.content.startsWith(prefix)) return;

    const parts = message.content.slice(prefix.length).trim().split(/\s+/);
    const cmd = parts.shift()?.toLowerCase();
    if (!cmd) return;
    const args = parts;

    // ══════════════════════════════════════════════════════
    //  USER COMMANDS
    // ══════════════════════════════════════════════════════

    // $help — context sensitive
    if (cmd === "help") {
      const member = message.member!;
      const userTier = getUserTier(member, cfg);
      const admin = isAdmin(message);

      const userFields: string[] = [
        `\`${prefix}free <stock>\` — Gen from Free stocks 👤`,
      ];
      if (userTier === "premium") {
        userFields.push(`\`${prefix}premium <stock>\` — Gen from Premium stocks ⭐`);
      }
      if (userTier === "boost") {
        userFields.push(`\`${prefix}boost <stock>\` — Gen from Boost stocks 🚀`);
      }
      userFields.push(
        `\`${prefix}stocklist\` — View all stocks`,
        `\`${prefix}mystats\` — Your stats`,
        `\`${prefix}checkstatus\` — Check status & get role`,
        `\`${prefix}help\` — This message`,
      );

      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("📦 Gen Bot — Commands")
        .addFields({ name: "👤 Your Commands", value: userFields.join("\n") });

      if (admin) {
        embed.addFields(
          {
            name: "📊 Gen Limits",
            value: [
              `🚀 Boost   — 45 gens/day · 5 min cooldown`,
              `⭐ Premium — 30 gens/day · 7 min cooldown`,
              `👤 Free    — 20 gens/day · 10 min cooldown`,
            ].join("\n"),
          },
          {
            name: "🔧 Admin — Stocks",
            value: [
              `\`${prefix}createstock <free|premium|boost> <name>\``,
              `\`${prefix}addstock <free|premium|boost> <name> <item>\``,
              `\`${prefix}addstocks <free|premium|boost> <name>\` *(multi-line)*`,
              `\`${prefix}removestock <free|premium|boost> <name>\``,
              `\`${prefix}clearstock <free|premium|boost> <name>\``,
            ].join("\n"),
          },
          {
            name: "🔧 Admin — Config",
            value: [
              `\`${prefix}setprefix <prefix>\``,
              `\`${prefix}setvouch #channel\``,
              `\`${prefix}setlogchannel #channel\``,
              `\`${prefix}setannouncechannel #channel\``,
              `\`${prefix}setgenchannel #channel\``,
              `\`${prefix}setautorole <status> @role\``,
              `\`${prefix}setgenrole @role\``,
              `\`${prefix}setboostrole @role\``,
              `\`${prefix}setpremiumrole @role\``,
              `\`${prefix}setlowstock <n>\``,
              `\`${prefix}setminage <days>\``,
              `\`${prefix}setvouchtimeout <min>\``,
              `\`${prefix}allowguild <guildId>\``,
              `\`${prefix}denyguild <guildId>\``,
            ].join("\n"),
          },
          {
            name: "🔧 Admin — Users",
            value: [
              `\`${prefix}resetcooldown @user\``,
              `\`${prefix}resetmisses @user\``,
              `\`${prefix}resetdaily @user\``,
              `\`${prefix}vouchpending\``,
              `\`${prefix}blacklist @user [temp <min>]\``,
              `\`${prefix}unblacklist @user\``,
              `\`${prefix}announce <msg>\``,
            ].join("\n"),
          },
        );
      } else {
        embed.addFields({
          name: "📊 Your Tier Limits",
          value: (() => {
            const { cooldownMs, dailyLimit, label, emoji } = TIER[userTier];
            return `${emoji} **${label}** — ${dailyLimit} gens/day · ${cooldownMs / 60_000} min cooldown`;
          })(),
        });
      }

      embed.setFooter({ text: `Prefix: ${prefix}` });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    // $mystats
    if (cmd === "mystats") {
      const member = message.member!;
      const userTier = getUserTier(member, cfg);
      const { cooldownMs, dailyLimit, label, emoji } = TIER[userTier];
      const daily = getDailyUsage();
      const today = todayStr();
      const usedToday = daily[message.author.id]?.date === today ? daily[message.author.id]!.count : 0;
      const lastGen = getCooldowns()[message.author.id];
      const cooldownLeft = lastGen ? Math.max(0, cooldownMs - (Date.now() - lastGen)) : 0;
      const missCount = getMisses()[message.author.id] ?? 0;
      const { listed, entry } = checkBlacklist(message.author.id);

      await message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2)
        .setTitle(`📊 Stats — ${message.author.username}`)
        .addFields(
          { name: "Tier",         value: `${emoji} ${label}`,                                   inline: true },
          { name: "Gens Today",   value: `${usedToday} / ${dailyLimit}`,                        inline: true },
          { name: "Cooldown",     value: cooldownLeft > 0 ? msToStr(cooldownLeft) : "Ready ✅", inline: true },
          { name: "Vouch Misses", value: `${missCount}`,                                        inline: true },
          { name: "Blacklist", inline: true,
            value: listed
              ? entry?.type === "perm" ? "🚫 Permanently blacklisted"
              : `⛔ Temp — expires <t:${Math.floor((entry?.until ?? 0) / 1000)}:R>`
              : "✅ Clean" },
        )
        .setThumbnail(message.author.displayAvatarURL()).setTimestamp()] });
      return;
    }

    // $stocklist
    if (cmd === "stocklist") {
      const stocks = getStocks();
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("📦 All Stocks");

      for (const tier of ["free", "premium", "boost"] as Tier[]) {
        const { emoji, label } = TIER[tier];
        const names = Object.keys(stocks[tier]);
        if (names.length === 0) {
          embed.addFields({ name: `${emoji} ${label} Stocks`, value: "*No stocks created*" });
        } else {
          const lines = names.map(n =>
            `\`${n}\` — **${stocks[tier][n]!.length}** item(s)${stocks[tier][n]!.length === 0 ? " *(out of stock)*" : ""}`
          );
          embed.addFields({ name: `${emoji} ${label} Stocks`, value: lines.join("\n") });
        }
      }

      await message.reply({ embeds: [embed] });
      return;
    }

    // $free <stock>
    if (cmd === "free") {
      const name = args[0]?.toLowerCase();
      if (!name) return void message.reply(`Usage: \`${prefix}free <stock>\``);
      await handleGen(message, client, "free", name, cfg);
      return;
    }

    // $premium <stock>
    if (cmd === "premium") {
      const name = args[0]?.toLowerCase();
      if (!name) return void message.reply(`Usage: \`${prefix}premium <stock>\``);
      await handleGen(message, client, "premium", name, cfg);
      return;
    }

    // $boost <stock>
    if (cmd === "boost") {
      const name = args[0]?.toLowerCase();
      if (!name) return void message.reply(`Usage: \`${prefix}boost <stock>\``);
      await handleGen(message, client, "boost", name, cfg);
      return;
    }

    // $checkstatus
    if (cmd === "checkstatus") {
      if (!cfg.autorole) return void message.reply(`❌ No autorole configured.`);
      const { statusText, roleId } = cfg.autorole;
      const member = message.member!;
      const activity = member.presence?.activities.find(a => a.type === ActivityType.Custom);
      const currentStatus = activity?.state ?? "";
      if (currentStatus.toLowerCase().includes(statusText.toLowerCase())) {
        if (member.roles.cache.has(roleId)) {
          await message.reply("✅ Your status is correct and you already have the role!");
        } else {
          try {
            await member.roles.add(roleId);
            await message.reply("✅ Status correct! You have been given the role.");
          } catch {
            await message.reply("❌ Could not assign the role. Check bot permissions.");
          }
        }
      } else {
        await message.reply(`❌ Status incorrect.\n\nRequired: **"${statusText}"**\n\nSet that as your Discord status then run \`${prefix}checkstatus\` again.`);
      }
      return;
    }

    // ══════════════════════════════════════════════════════
    //  ADMIN COMMANDS
    // ══════════════════════════════════════════════════════

    if (!isAdmin(message)) return;

    function parseTier(val: string | undefined): Tier | null {
      if (val === "free" || val === "premium" || val === "boost") return val;
      return null;
    }

    // $createstock <tier> <name>
    if (cmd === "createstock") {
      const tier = parseTier(args[0]);
      const name = args[1]?.toLowerCase();
      if (!tier || !name) return void message.reply(`Usage: \`${prefix}createstock <free|premium|boost> <name>\``);
      const stocks = getStocks();
      if (stocks[tier][name]) return void message.reply(`❌ \`${name}\` already exists in **${tier}**.`);
      stocks[tier][name] = [];
      writeJson("stocks.json", stocks);
      await message.reply(`✅ Stock \`${name}\` created in **${tier}** tier!`);
      return;
    }

    // $addstock <tier> <name> <item>
    if (cmd === "addstock") {
      const tier = parseTier(args[0]);
      const name = args[1]?.toLowerCase();
      const item = args.slice(2).join(" ");
      if (!tier || !name || !item) return void message.reply(`Usage: \`${prefix}addstock <free|premium|boost> <name> <item>\``);
      const stocks = getStocks();
      if (!stocks[tier][name]) return void message.reply(`❌ \`${name}\` does not exist in **${tier}**.`);
      stocks[tier][name]!.push(item);
      writeJson("stocks.json", stocks);
      await message.reply(`✅ Item added to \`${name}\` [${tier}]! Now has **${stocks[tier][name]!.length}** item(s).`);
      return;
    }

    // $addstocks <tier> <name>  (each line = one item)
    if (cmd === "addstocks") {
      const tier = parseTier(args[0]);
      const name = args[1]?.toLowerCase();
      if (!tier || !name) return void message.reply(`Usage: \`${prefix}addstocks <free|premium|boost> <name>\` then items (one per line)`);
      const stocks = getStocks();
      if (!stocks[tier][name]) return void message.reply(`❌ \`${name}\` does not exist in **${tier}**.`);
      const lines = message.content
        .slice((prefix + "addstocks " + args[0] + " " + name).length)
        .split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) return void message.reply("❌ No items found. Put each item on a new line.");
      stocks[tier][name]!.push(...lines);
      writeJson("stocks.json", stocks);
      await message.reply(`✅ Added **${lines.length}** item(s) to \`${name}\` [${tier}]! Now has **${stocks[tier][name]!.length}** item(s).`);
      return;
    }

    // $removestock <tier> <name>
    if (cmd === "removestock") {
      const tier = parseTier(args[0]);
      const name = args[1]?.toLowerCase();
      if (!tier || !name) return void message.reply(`Usage: \`${prefix}removestock <free|premium|boost> <name>\``);
      const stocks = getStocks();
      if (!stocks[tier][name]) return void message.reply(`❌ \`${name}\` does not exist in **${tier}**.`);
      delete stocks[tier][name];
      writeJson("stocks.json", stocks);
      await message.reply(`✅ Stock \`${name}\` [${tier}] deleted.`);
      return;
    }

    // $clearstock <tier> <name>
    if (cmd === "clearstock") {
      const tier = parseTier(args[0]);
      const name = args[1]?.toLowerCase();
      if (!tier || !name) return void message.reply(`Usage: \`${prefix}clearstock <free|premium|boost> <name>\``);
      const stocks = getStocks();
      if (!stocks[tier][name]) return void message.reply(`❌ \`${name}\` does not exist in **${tier}**.`);
      stocks[tier][name] = [];
      writeJson("stocks.json", stocks);
      await message.reply(`✅ Stock \`${name}\` [${tier}] cleared.`);
      return;
    }

    // $resetcooldown @user
    if (cmd === "resetcooldown") {
      const target = message.mentions.users.first();
      if (!target) return void message.reply(`Usage: \`${prefix}resetcooldown @user\``);
      const c = getCooldowns(); delete c[target.id]; writeJson("cooldowns.json", c);
      await message.reply(`✅ Cooldown reset for **${target.tag}**.`);
      return;
    }

    // $resetmisses @user
    if (cmd === "resetmisses") {
      const target = message.mentions.users.first();
      if (!target) return void message.reply(`Usage: \`${prefix}resetmisses @user\``);
      const m = getMisses(); delete m[target.id]; writeJson("misses.json", m);
      await message.reply(`✅ Miss count reset for **${target.tag}**.`);
      return;
    }

    // $resetdaily @user
    if (cmd === "resetdaily") {
      const target = message.mentions.users.first();
      if (!target) return void message.reply(`Usage: \`${prefix}resetdaily @user\``);
      const d = getDailyUsage(); delete d[target.id]; writeJson("daily.json", d);
      await message.reply(`✅ Daily gen count reset for **${target.tag}**.`);
      return;
    }

    // $vouchpending
    if (cmd === "vouchpending") {
      const pending = getPending();
      const entries = Object.entries(pending);
      if (entries.length === 0) return void message.reply("✅ No pending vouches.");
      const lines = entries.map(([uid, d]) => {
        const age = Math.floor((Date.now() - d.pendingSince) / 60_000);
        return `<@${uid}> — **${d.stockName}** [${d.tier}] — ${age} min ago${d.warned ? " ⚠️" : ""}`;
      });
      await message.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(`⏳ Pending Vouches (${entries.length})`).setDescription(lines.join("\n"))] });
      return;
    }

    // $blacklist @user [temp <min>]
    if (cmd === "blacklist") {
      const target = message.mentions.users.first();
      if (!target) return void message.reply(`Usage: \`${prefix}blacklist @user [temp <minutes>]\``);
      const bl = getBlacklist();
      bl.users = bl.users.filter(u => u.id !== target.id);
      if (args[1]?.toLowerCase() === "temp") {
        const mins = parseInt(args[2] ?? "60", 10);
        bl.users.push({ id: target.id, type: "temp", until: Date.now() + mins * 60_000 });
        writeJson("blacklist.json", bl);
        await message.reply(`✅ **${target.tag}** blacklisted for **${mins} min**.`);
      } else {
        bl.users.push({ id: target.id, type: "perm" });
        writeJson("blacklist.json", bl);
        await message.reply(`✅ **${target.tag}** permanently blacklisted.`);
      }
      return;
    }

    // $unblacklist @user
    if (cmd === "unblacklist") {
      const target = message.mentions.users.first();
      if (!target) return void message.reply(`Usage: \`${prefix}unblacklist @user\``);
      const bl = getBlacklist();
      const before = bl.users.length;
      bl.users = bl.users.filter(u => u.id !== target.id);
      if (bl.users.length === before) return void message.reply(`❌ **${target.tag}** is not blacklisted.`);
      writeJson("blacklist.json", bl);
      await message.reply(`✅ **${target.tag}** removed from blacklist.`);
      return;
    }

    // $setprefix
    if (cmd === "setprefix") {
      const np = args[0];
      if (!np) return void message.reply(`Usage: \`${prefix}setprefix <new>\``);
      const c = getConfig(); c.prefix = np; writeJson("config.json", c);
      await message.reply(`✅ Prefix changed to \`${np}\``);
      return;
    }

    // $setvouch #channel
    if (cmd === "setvouch") {
      const ch = message.mentions.channels.first();
      if (!ch) return void message.reply(`Usage: \`${prefix}setvouch #channel\``);
      const c = getConfig(); c.vouchChannelId = ch.id; writeJson("config.json", c);
      await message.reply(`✅ Vouch channel set to ${ch}`);
      return;
    }

    // $setlogchannel
    if (cmd === "setlogchannel") {
      const ch = message.mentions.channels.first();
      if (!ch) return void message.reply(`Usage: \`${prefix}setlogchannel #channel\``);
      const c = getConfig(); c.logChannelId = ch.id; writeJson("config.json", c);
      await message.reply(`✅ Log channel set to ${ch}`);
      return;
    }

    // $setannouncechannel
    if (cmd === "setannouncechannel") {
      const ch = message.mentions.channels.first();
      if (!ch) return void message.reply(`Usage: \`${prefix}setannouncechannel #channel\``);
      const c = getConfig(); c.announceChannelId = ch.id; writeJson("config.json", c);
      await message.reply(`✅ Announce channel set to ${ch}`);
      return;
    }

    // $setgenchannel
    if (cmd === "setgenchannel") {
      const ch = message.mentions.channels.first();
      if (args[0]?.toLowerCase() === "remove" || args[0]?.toLowerCase() === "none") {
        const c = getConfig(); c.genChannelId = null; writeJson("config.json", c);
        await message.reply(`✅ Gen channel restriction removed.`); return;
      }
      if (!ch) return void message.reply(`Usage: \`${prefix}setgenchannel #channel\` | \`remove\` to disable`);
      const c = getConfig(); c.genChannelId = ch.id; writeJson("config.json", c);
      await message.reply(`✅ Gen channel set to ${ch}`);
      return;
    }

    // $setowner — set bot owner (only usable if no owner set, or by owner)
    if (cmd === "setowner") {
      const c = getConfig();
      if (c.ownerId && c.ownerId !== message.author.id)
        return void message.reply(`❌ Owner already set.`);
      c.ownerId = message.author.id;
      writeJson("config.json", c);
      await message.reply(`✅ You are now the bot owner! Your ID: \`${message.author.id}\``);
      return;
    }

    // $allowguild <guildId>
    if (cmd === "allowguild") {
      const guildId = args[0];
      if (!guildId) return void message.reply(`Usage: \`${prefix}allowguild <guildId>\`\nCurrent server ID: \`${message.guild?.id}\``);
      const c = getConfig();
      if (c.allowedGuildIds.includes(guildId)) return void message.reply(`✅ \`${guildId}\` already allowed.`);
      c.allowedGuildIds.push(guildId);
      writeJson("config.json", c);
      await message.reply(`✅ Server \`${guildId}\` added to whitelist.`);
      return;
    }

    // $denyguild <guildId>
    if (cmd === "denyguild") {
      const guildId = args[0];
      if (!guildId) return void message.reply(`Usage: \`${prefix}denyguild <guildId>\``);
      const c = getConfig();
      c.allowedGuildIds = c.allowedGuildIds.filter(id => id !== guildId);
      writeJson("config.json", c);
      await message.reply(`✅ Server \`${guildId}\` removed from whitelist.`);
      return;
    }

    // $setautorole <status> @role
    if (cmd === "setautorole") {
      const role = message.mentions.roles.first();
      if (!role) return void message.reply(`Usage: \`${prefix}setautorole <status text> @role\``);
      const statusText = message.content.slice((prefix + "setautorole").length).replace(`<@&${role.id}>`, "").trim();
      if (!statusText) return void message.reply(`Usage: \`${prefix}setautorole <status text> @role\``);
      const c = getConfig(); c.autorole = { statusText, roleId: role.id }; writeJson("config.json", c);
      await message.reply(`✅ Autorole set! Status: **"${statusText}"** → ${role}`);
      return;
    }

    // $setgenrole
    if (cmd === "setgenrole") {
      const role = message.mentions.roles.first();
      if (args[0]?.toLowerCase() === "remove" || args[0]?.toLowerCase() === "none") {
        const c = getConfig(); c.genRoleId = null; writeJson("config.json", c);
        await message.reply(`✅ Gen role restriction removed.`); return;
      }
      if (!role) return void message.reply(`Usage: \`${prefix}setgenrole @role\` | \`remove\` to disable`);
      const c = getConfig(); c.genRoleId = role.id; writeJson("config.json", c);
      await message.reply(`✅ Gen role set to ${role}`);
      return;
    }

    // $setboostrole
    if (cmd === "setboostrole") {
      const role = message.mentions.roles.first();
      if (!role) return void message.reply(`Usage: \`${prefix}setboostrole @role\``);
      const c = getConfig(); c.boostRoleId = role.id; writeJson("config.json", c);
      await message.reply(`✅ Boost role set to ${role}! 🚀 45 gens/day · 5 min cooldown`);
      return;
    }

    // $setpremiumrole
    if (cmd === "setpremiumrole") {
      const role = message.mentions.roles.first();
      if (!role) return void message.reply(`Usage: \`${prefix}setpremiumrole @role\``);
      const c = getConfig(); c.premiumRoleId = role.id; writeJson("config.json", c);
      await message.reply(`✅ Premium role set to ${role}! ⭐ 30 gens/day · 7 min cooldown`);
      return;
    }

    // $setlowstock
    if (cmd === "setlowstock") {
      const n = parseInt(args[0] ?? "", 10);
      if (isNaN(n) || n < 1) return void message.reply(`Usage: \`${prefix}setlowstock <number>\``);
      const c = getConfig(); c.lowStockThreshold = n; writeJson("config.json", c);
      await message.reply(`✅ Low stock alert at ≤ **${n}** item(s).`);
      return;
    }

    // $setminage
    if (cmd === "setminage") {
      const n = parseInt(args[0] ?? "", 10);
      if (isNaN(n) || n < 0) return void message.reply(`Usage: \`${prefix}setminage <days>\` (0 to disable)`);
      const c = getConfig(); c.minAccountAgeDays = n; writeJson("config.json", c);
      await message.reply(n === 0 ? `✅ Account age check disabled.` : `✅ Min account age set to **${n} day(s)**.`);
      return;
    }

    // $setvouchtimeout
    if (cmd === "setvouchtimeout") {
      const n = parseInt(args[0] ?? "", 10);
      if (isNaN(n) || n < 1) return void message.reply(`Usage: \`${prefix}setvouchtimeout <minutes>\``);
      const c = getConfig(); c.vouchTimeoutMinutes = n; writeJson("config.json", c);
      await message.reply(`✅ Vouch timeout set to **${n} minutes**.`);
      return;
    }

    // $announce
    if (cmd === "announce") {
      if (!cfg.announceChannelId) return void message.reply(`❌ Set announce channel first: \`${prefix}setannouncechannel #channel\``);
      const text = message.content.slice((prefix + "announce").length).trim();
      if (!text) return void message.reply(`Usage: \`${prefix}announce <message>\``);
      try {
        const ch = message.guild.channels.cache.get(cfg.announceChannelId);
        if (!ch?.isTextBased()) return void message.reply("❌ Announce channel not found.");
        await ch.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("📢 Announcement").setDescription(text).setFooter({ text: `From ${message.author.tag}` }).setTimestamp()] });
        await message.reply("✅ Announcement sent!");
      } catch { await message.reply("❌ Failed to send."); }
      return;
    }
  });

  client.login(token).catch((err: unknown) => {
    logger.error({ err }, "Discord bot failed to login");
  });
}

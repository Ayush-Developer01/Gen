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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Simple logger
const logger = {
  info:  (msg: string) => console.log(`[INFO]  ${new Date().toISOString()} ${msg}`),
  warn:  (msg: string) => console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`),
  error: (msg: string, err?: unknown) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, err ?? ""),
};

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
}

interface BlacklistEntry {
  id: string;
  type: "temp" | "perm";
  until?: number;
}
interface Blacklist  { users: BlacklistEntry[] }
interface Stocks     { [name: string]: string[] }
interface Cooldowns  { [userId: string]: number }
interface DailyUsage { [userId: string]: { date: string; count: number } }
interface PendingVouch {
  pendingSince: number;
  warned: boolean;
  stockName: string;
  guildId: string;
  username: string;
}
interface PendingVouches { [userId: string]: PendingVouch }
interface MissCount      { [userId: string]: number }
interface GenStats        { total: number; byStock: { [name: string]: number } }

// ─── Tier config ──────────────────────────────────────────────────────────────

type Tier = "boost" | "premium" | "free";
const TIER: Record<Tier, { cooldownMs: number; dailyLimit: number; label: string; emoji: string }> = {
  boost:   { cooldownMs: 5  * 60_000, dailyLimit: 45, label: "Boost",   emoji: "🚀" },
  premium: { cooldownMs: 7  * 60_000, dailyLimit: 30, label: "Premium", emoji: "⭐" },
  free:    { cooldownMs: 10 * 60_000, dailyLimit: 20, label: "Free",    emoji: "👤" },
};
const MISS_DURATIONS = [0, 30, 40, 50, 60]; // minutes; index = miss count

// ─── Data helpers ─────────────────────────────────────────────────────────────

function readJson<T>(file: string, def: T): T {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return def;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return def; }
}
function writeJson(file: string, data: unknown) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

const getConfig = (): Config => readJson<Config>("config.json", {
  prefix: "&", vouchChannelId: null, logChannelId: null, announceChannelId: null,
  genChannelId: null, autorole: null, boostRoleId: null, premiumRoleId: null,
  genRoleId: null, lowStockThreshold: 5, minAccountAgeDays: 0, vouchTimeoutMinutes: 3,
});
const getStocks     = () => readJson<Stocks>        ("stocks.json",   {});
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
  client: Client,
  userId: string,
  username: string,
  logChannelId: string | null,
  guildId: string
): Promise<void> {
  const misses = getMisses();
  const count = (misses[userId] ?? 0) + 1;
  misses[userId] = count;
  writeJson("misses.json", misses);

  const bl = getBlacklist();
  bl.users = bl.users.filter(u => u.id !== userId);

  let durationText: string;
  const color = 0xed4245;
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
    await user.send({
      embeds: [new EmbedBuilder()
        .setColor(color)
        .setTitle("⛔ You Have Been Blacklisted")
        .setDescription(
          `You have been blacklisted ${durationText} for missing your vouch.\n\n` +
          `**Miss count:** ${count}${count >= 5 ? " — Permanent ban" : ""}\n\n` +
          `If you think this is a mistake, **make a ticket** in the server.`
        )
        .setTimestamp()
      ],
    });
  } catch { /* DMs closed */ }

  if (logChannelId) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const ch = guild.channels.cache.get(logChannelId);
      if (ch?.isTextBased()) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0xff6b6b)
            .setTitle("⛔ Auto Miss-Vouch Blacklist")
            .addFields(
              { name: "User",       value: `<@${userId}> (${username})`, inline: true },
              { name: "Miss Count", value: `${count}`,                   inline: true },
              { name: "Duration",   value: durationText,                 inline: true },
            )
            .setTimestamp()
          ],
        });
      }
    } catch { /* log channel error */ }
  }
}

// ─── Low stock alert ──────────────────────────────────────────────────────────

async function checkLowStock(client: Client, stockName: string, remaining: number, cfg: Config) {
  if (remaining > cfg.lowStockThreshold || !cfg.logChannelId) return;
  try {
    for (const guild of client.guilds.cache.values()) {
      const ch = guild.channels.cache.get(cfg.logChannelId);
      if (ch?.isTextBased()) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0xfee75c)
            .setTitle("⚠️ Low Stock Alert")
            .setDescription(`Stock **${stockName}** has only **${remaining}** item(s) left!`)
            .setTimestamp()
          ],
        });
        break;
      }
    }
  } catch { /* ignore */ }
}

// ─── Gen log ──────────────────────────────────────────────────────────────────

async function logGen(client: Client, userId: string, username: string, stockName: string, cfg: Config, remaining: number) {
  if (!cfg.logChannelId) return;
  try {
    for (const guild of client.guilds.cache.values()) {
      const ch = guild.channels.cache.get(cfg.logChannelId);
      if (ch?.isTextBased()) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle("📦 Gen Log")
            .addFields(
              { name: "User",  value: `<@${userId}> (${username})`, inline: true },
              { name: "Stock", value: stockName,                     inline: true },
              { name: "Left",  value: `${remaining} items`,          inline: true },
            )
            .setTimestamp()
          ],
        });
        break;
      }
    }
  } catch { /* ignore */ }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

const token = process.env["DISCORD_TOKEN"];
if (!token) {
  logger.error("DISCORD_TOKEN is not set. Exiting.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once("clientReady", () => logger.info(`Bot logged in as ${client.user?.tag}`));

// ── Periodic check: 2-min warning + auto-miss ─────────────────────────────
setInterval(() => {
  void (async () => {
    try {
      const pending = getPending();
      const cfg = getConfig();
      const now = Date.now();
      const TWO_MIN = 2 * 60_000;
      const TIMEOUT_MS = cfg.vouchTimeoutMinutes * 60_000;
      let changed = false;

      for (const [userId, data] of Object.entries(pending)) {
        const age = now - data.pendingSince;

        if (age >= TIMEOUT_MS) {
          delete pending[userId];
          changed = true;
          writeJson("vouches.json", pending);
          try {
            await applyMissBlacklist(client, userId, data.username, cfg.logChannelId, data.guildId);
          } catch (err) {
            logger.error(`applyMissBlacklist failed for ${userId}`, err);
          }
          continue;
        }

        if (!data.warned && age >= TWO_MIN) {
          try {
            const user = await client.users.fetch(userId);
            const vouchMention = cfg.vouchChannelId ? `<#${cfg.vouchChannelId}>` : "the vouch channel";
            await user.send({
              embeds: [new EmbedBuilder()
                .setColor(0xfee75c)
                .setTitle("⚠️ Vouch Reminder")
                .setDescription(
                  `You received an item from **${data.stockName}** but haven't vouched yet!\n\n` +
                  `✅ **Vouch here:** ${vouchMention}\n\n` +
                  `⛔ **You will be automatically blacklisted if you don't vouch.**`
                )
                .setTimestamp()
              ],
            });
          } catch { /* DMs closed */ }
          pending[userId]!.warned = true;
          changed = true;
        }
      }
      if (changed) writeJson("vouches.json", pending);
    } catch (err) {
      logger.error("Vouch interval error", err);
    }
  })();
}, 30_000);

// ── Message handler ───────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const cfg = getConfig();

  // Vouch channel detection — strict validation
  if (cfg.vouchChannelId && message.channelId === cfg.vouchChannelId && message.guild) {
    const pending = getPending();
    const entry = pending[message.author.id];

    // No pending vouch — delete message silently
    if (!entry) {
      try { await message.delete(); } catch { /* no perms */ }
      return;
    }

    // Has pending — must start with "legit got" AND contain the stock name
    const content = message.content.toLowerCase();
    if (!content.startsWith("legit got") || !content.includes(entry.stockName.toLowerCase())) {
      try { await message.delete(); } catch { /* no perms */ }
      try {
        await message.author.send({
          embeds: [new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle("❌ Wrong Vouch Format")
            .setDescription(
              `Your message was deleted because it didn't mention the stock name.\n\n` +
              `Please write your vouch and include: **${entry.stockName}**\n\n` +
              `Example: \`legit got ${entry.stockName} from ping me\``
            )
            .setTimestamp()
          ],
        });
      } catch { /* DMs closed */ }
      return;
    }

    // Correct vouch — clear pending and thank
    delete pending[message.author.id];
    writeJson("vouches.json", pending);
    try {
      await message.author.send({
        embeds: [new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("✅ Vouch Received!")
          .setDescription("Your vouch is done, thanks for vouching! 🙏\n\nYou're all good — enjoy your item!")
          .setTimestamp()
        ],
      });
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

  if (cmd === "help") {
    await message.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📦 Stock Bot — All Commands")
        .addFields(
          {
            name: "👤 User Commands",
            value: [
              `\`${prefix}gen <stock>\` — Get an item from a stock`,
              `\`${prefix}stock <stock>\` — See items left in a stock`,
              `\`${prefix}stocklist\` — List all stocks`,
              `\`${prefix}mystats\` — Your personal stats`,
              `\`${prefix}checkstatus\` — Check status & get autorole`,
              `\`${prefix}help\` — This message`,
            ].join("\n"),
          },
          {
            name: "📊 Gen Limits & Cooldowns",
            value: [
              `🚀 **Boost**   — 45 gens/day · 5 min cooldown`,
              `⭐ **Premium** — 30 gens/day · 7 min cooldown`,
              `👤 **Free**    — 20 gens/day · 10 min cooldown`,
            ].join("\n"),
          },
          {
            name: "⚠️ Vouch Miss Auto-Blacklist",
            value: [
              `Vouch within **3 min** after gen or get blacklisted:`,
              `1st miss → 30 min · 2nd → 40 min`,
              `3rd miss → 50 min · 4th → 60 min`,
              `5th miss → **Permanent blacklist**`,
            ].join("\n"),
          },
          {
            name: "🔧 Admin Commands",
            value: [
              `\`${prefix}createstock <name>\``,
              `\`${prefix}addstock <name> <item>\``,
              `\`${prefix}addstocks <name>\` *(multi-line)*`,
              `\`${prefix}removestock <name>\``,
              `\`${prefix}clearstock <name>\``,
              `\`${prefix}setprefix <prefix>\``,
              `\`${prefix}setvouch #channel\``,
              `\`${prefix}setlogchannel #channel\``,
              `\`${prefix}setannouncechannel #channel\``,
              `\`${prefix}setautorole <status> @role\``,
              `\`${prefix}setgenchannel #channel\``,
              `\`${prefix}setgenrole @role\``,
              `\`${prefix}setboostrole @role\``,
              `\`${prefix}setpremiumrole @role\``,
              `\`${prefix}setlowstock <number>\``,
              `\`${prefix}setminage <days>\``,
              `\`${prefix}setvouchtimeout <minutes>\``,
              `\`${prefix}resetcooldown @user\``,
              `\`${prefix}resetmisses @user\``,
              `\`${prefix}resetdaily @user\``,
              `\`${prefix}vouchpending\``,
              `\`${prefix}blacklist @user [temp <min>]\``,
              `\`${prefix}unblacklist @user\``,
              `\`${prefix}announce <message>\``,
            ].join("\n"),
          },
        )
        .setFooter({ text: `Prefix: ${prefix}` })
      ],
    });
    return;
  }

  if (cmd === "mystats") {
    const member = message.member!;
    const tier = getUserTier(member, cfg);
    const { cooldownMs, dailyLimit, label, emoji } = TIER[tier];
    const daily = getDailyUsage();
    const today = todayStr();
    const usedToday = daily[message.author.id]?.date === today ? daily[message.author.id]!.count : 0;
    const cooldowns = getCooldowns();
    const lastGen = cooldowns[message.author.id];
    const cooldownLeft = lastGen ? Math.max(0, cooldownMs - (Date.now() - lastGen)) : 0;
    const misses = getMisses();
    const missCount = misses[message.author.id] ?? 0;
    const { listed, entry } = checkBlacklist(message.author.id);

    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📊 Stats — ${message.author.username}`)
        .addFields(
          { name: "Tier",         value: `${emoji} ${label}`,                                   inline: true },
          { name: "Gens Today",   value: `${usedToday} / ${dailyLimit}`,                        inline: true },
          { name: "Cooldown",     value: cooldownLeft > 0 ? msToStr(cooldownLeft) : "Ready ✅", inline: true },
          { name: "Vouch Misses", value: `${missCount}`,                                        inline: true },
          {
            name: "Blacklist",
            value: listed
              ? entry?.type === "perm"
                ? "🚫 Permanently blacklisted"
                : `⛔ Temp — expires <t:${Math.floor((entry?.until ?? 0) / 1000)}:R>`
              : "✅ Clean",
            inline: true,
          },
        )
        .setThumbnail(message.author.displayAvatarURL())
        .setTimestamp()
      ],
    });
    return;
  }

  if (cmd === "stocklist") {
    const stocks = getStocks();
    const names = Object.keys(stocks);
    if (names.length === 0) return void message.reply("📦 No stocks have been created yet.");
    const lines = names.map(n =>
      `\`${n}\` — **${stocks[n]!.length}** item(s) ${stocks[n]!.length === 0 ? "*(out of stock)*" : ""}`
    );
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📦 All Stocks")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `${names.length} stocks total` })
      ],
    });
    return;
  }

  if (cmd === "gen") {
    const name = args[0]?.toLowerCase();
    if (!name) return void message.reply(`Usage: \`${prefix}gen <name>\``);

    if (cfg.minAccountAgeDays > 0) {
      const accountAge = (Date.now() - message.author.createdTimestamp) / 86_400_000;
      if (accountAge < cfg.minAccountAgeDays)
        return void message.reply(
          `❌ Your account must be at least **${cfg.minAccountAgeDays} day(s)** old to use \`${prefix}gen\`.\n` +
          `Your account is **${Math.floor(accountAge)} day(s)** old.`
        );
    }

    if (cfg.genChannelId && message.channelId !== cfg.genChannelId)
      return void message.reply(`❌ You can only use \`${prefix}gen\` in <#${cfg.genChannelId}>.`);

    if (cfg.genRoleId && !message.member!.roles.cache.has(cfg.genRoleId))
      return void message.reply(`❌ You need the <@&${cfg.genRoleId}> role to use \`${prefix}gen\`.`);

    const { listed } = checkBlacklist(message.author.id);
    if (listed) return void message.reply("🚫 You are blacklisted and cannot use `gen`.");

    const member = message.member!;
    const tier = getUserTier(member, cfg);
    const { cooldownMs, dailyLimit, label, emoji } = TIER[tier];

    const cooldowns = getCooldowns();
    const lastUsed = cooldowns[message.author.id];
    if (lastUsed && Date.now() - lastUsed < cooldownMs) {
      const left = cooldownMs - (Date.now() - lastUsed);
      return void message.reply(
        `⏳ Cooldown active! Please wait **${msToStr(left)}** before using \`${prefix}gen\` again.\n${emoji} ${label} cooldown: ${cooldownMs / 60_000} min`
      );
    }

    const daily = getDailyUsage();
    const today = todayStr();
    const todayCount = daily[message.author.id]?.date === today ? daily[message.author.id]!.count : 0;
    if (todayCount >= dailyLimit)
      return void message.reply(
        `📵 You've hit your daily limit of **${dailyLimit} gens** (${emoji} ${label}). Come back tomorrow!`
      );

    const stocks = getStocks();
    if (!stocks[name]) return void message.reply(`❌ Stock \`${name}\` does not exist.`);
    if (stocks[name]!.length === 0) return void message.reply(`❌ **${name}** is out of stock!`);

    const item = stocks[name]!.shift()!;
    const remaining = stocks[name]!.length;
    writeJson("stocks.json", stocks);

    cooldowns[message.author.id] = Date.now();
    writeJson("cooldowns.json", cooldowns);

    daily[message.author.id] = { date: today, count: todayCount + 1 };
    writeJson("daily.json", daily);

    const stats = getGenStats();
    stats.total++;
    stats.byStock[name] = (stats.byStock[name] ?? 0) + 1;
    writeJson("genstats.json", stats);

    const vouchLine = cfg.vouchChannelId
      ? `\n\n✅ **Vouch here:** <#${cfg.vouchChannelId}>\n⚠️ **No vouch = auto-blacklist**`
      : "";

    try {
      await message.author.send({
        embeds: [new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle(`📦 Your item from: ${name}`)
          .setDescription(`\`\`\`\n${item}\n\`\`\`${vouchLine}`)
          .addFields({ name: "Your Tier", value: `${emoji} ${label} — ${todayCount + 1}/${dailyLimit} gens today`, inline: true })
          .setFooter({ text: "Enjoy! Remember to vouch." })
          .setTimestamp()
        ],
      });

      await message.reply(`✅ Check your DMs, ${message.author}! (**${todayCount + 1}/${dailyLimit}** gens used today)`);

      if (cfg.vouchChannelId) {
        const pending = getPending();
        pending[message.author.id] = {
          pendingSince: Date.now(),
          warned: false,
          stockName: name,
          guildId: message.guild.id,
          username: message.author.tag,
        };
        writeJson("vouches.json", pending);
      }

      await logGen(client, message.author.id, message.author.tag, name, cfg, remaining);
      await checkLowStock(client, name, remaining, cfg);

    } catch {
      stocks[name]!.unshift(item);
      writeJson("stocks.json", stocks);
      delete cooldowns[message.author.id];
      writeJson("cooldowns.json", cooldowns);
      daily[message.author.id] = { date: today, count: todayCount };
      writeJson("daily.json", daily);
      stats.total--;
      stats.byStock[name] = Math.max(0, (stats.byStock[name] ?? 1) - 1);
      writeJson("genstats.json", stats);
      await message.reply(`❌ Could not DM you. Please open your DMs and try again.`);
    }
    return;
  }

  if (cmd === "stock") {
    const name = args[0]?.toLowerCase();
    if (!name) return void message.reply(`Usage: \`${prefix}stock <name>\``);
    const stocks = getStocks();
    if (!stocks[name]) return void message.reply(`❌ Stock \`${name}\` does not exist.`);
    const count = stocks[name]!.length;
    await message.reply(
      count === 0
        ? `📦 **${name}** is currently **out of stock**.`
        : `📦 **${name}** has **${count}** item(s) available.`
    );
    return;
  }

  if (cmd === "checkstatus") {
    if (!cfg.autorole)
      return void message.reply(`❌ No autorole configured. Ask an admin to use \`${prefix}setautorole\`.`);
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
          await message.reply("✅ Your status is correct! You have been given the role.");
        } catch {
          await message.reply("❌ Could not assign the role. Check bot permissions and role order.");
        }
      }
    } else {
      await message.reply(
        `❌ Your current status is not correct.\n\nRequired text: **"${statusText}"**\n\nSet your Discord status to that text, then try \`${prefix}checkstatus\` again.`
      );
    }
    return;
  }

  // ══════════════════════════════════════════════════════
  //  ADMIN COMMANDS
  // ══════════════════════════════════════════════════════

  if (!isAdmin(message)) return;

  if (cmd === "createstock") {
    const name = args[0]?.toLowerCase();
    if (!name) return void message.reply(`Usage: \`${prefix}createstock <name>\``);
    const stocks = getStocks();
    if (stocks[name]) return void message.reply(`❌ Stock \`${name}\` already exists.`);
    stocks[name] = [];
    writeJson("stocks.json", stocks);
    await message.reply(`✅ Stock \`${name}\` created!`);
    return;
  }

  if (cmd === "addstock") {
    const name = args[0]?.toLowerCase();
    const item = args.slice(1).join(" ");
    if (!name || !item) return void message.reply(`Usage: \`${prefix}addstock <name> <item>\``);
    const stocks = getStocks();
    if (!stocks[name]) return void message.reply(`❌ Stock \`${name}\` does not exist.`);
    stocks[name]!.push(item);
    writeJson("stocks.json", stocks);
    await message.reply(`✅ Item added to \`${name}\`! Now has **${stocks[name]!.length}** item(s).`);
    return;
  }

  if (cmd === "addstocks") {
    const name = args[0]?.toLowerCase();
    if (!name) return void message.reply(`Usage: \`${prefix}addstocks <name>\` then paste items (one per line)`);
    const stocks = getStocks();
    if (!stocks[name]) return void message.reply(`❌ Stock \`${name}\` does not exist.`);
    const lines = message.content
      .slice((prefix + "addstocks " + name).length)
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return void message.reply("❌ No items found. Put each item on a new line.");
    stocks[name]!.push(...lines);
    writeJson("stocks.json", stocks);
    await message.reply(`✅ Added **${lines.length}** item(s) to \`${name}\`! Now has **${stocks[name]!.length}** item(s).`);
    return;
  }

  if (cmd === "removestock") {
    const name = args[0]?.toLowerCase();
    if (!name) return void message.reply(`Usage: \`${prefix}removestock <name>\``);
    const stocks = getStocks();
    if (!stocks[name]) return void message.reply(`❌ Stock \`${name}\` does not exist.`);
    delete stocks[name];
    writeJson("stocks.json", stocks);
    await message.reply(`✅ Stock \`${name}\` has been deleted.`);
    return;
  }

  if (cmd === "clearstock") {
    const name = args[0]?.toLowerCase();
    if (!name) return void message.reply(`Usage: \`${prefix}clearstock <name>\``);
    const stocks = getStocks();
    if (!stocks[name]) return void message.reply(`❌ Stock \`${name}\` does not exist.`);
    stocks[name] = [];
    writeJson("stocks.json", stocks);
    await message.reply(`✅ Stock \`${name}\` has been cleared (0 items).`);
    return;
  }

  if (cmd === "resetcooldown") {
    const target = message.mentions.users.first();
    if (!target) return void message.reply(`Usage: \`${prefix}resetcooldown @user\``);
    const cooldowns = getCooldowns();
    delete cooldowns[target.id];
    writeJson("cooldowns.json", cooldowns);
    await message.reply(`✅ Cooldown reset for **${target.tag}**.`);
    return;
  }

  if (cmd === "resetmisses") {
    const target = message.mentions.users.first();
    if (!target) return void message.reply(`Usage: \`${prefix}resetmisses @user\``);
    const misses = getMisses();
    delete misses[target.id];
    writeJson("misses.json", misses);
    await message.reply(`✅ Vouch miss count reset for **${target.tag}**.`);
    return;
  }

  if (cmd === "resetdaily") {
    const target = message.mentions.users.first();
    if (!target) return void message.reply(`Usage: \`${prefix}resetdaily @user\``);
    const daily = getDailyUsage();
    delete daily[target.id];
    writeJson("daily.json", daily);
    await message.reply(`✅ Daily gen count reset for **${target.tag}**.`);
    return;
  }

  if (cmd === "vouchpending") {
    const pending = getPending();
    const entries = Object.entries(pending);
    if (entries.length === 0) return void message.reply("✅ No users have a pending vouch right now.");
    const lines = entries.map(([uid, d]) => {
      const age = Math.floor((Date.now() - d.pendingSince) / 60_000);
      return `<@${uid}> — **${d.stockName}** — ${age} min ago${d.warned ? " ⚠️ warned" : ""}`;
    });
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`⏳ Pending Vouches (${entries.length})`)
        .setDescription(lines.join("\n"))
      ],
    });
    return;
  }

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

  if (cmd === "setprefix") {
    const np = args[0];
    if (!np) return void message.reply(`Usage: \`${prefix}setprefix <new_prefix>\``);
    const c = getConfig(); c.prefix = np; writeJson("config.json", c);
    await message.reply(`✅ Prefix changed to \`${np}\``);
    return;
  }

  if (cmd === "setvouch") {
    const ch = message.mentions.channels.first();
    if (!ch) return void message.reply(`Usage: \`${prefix}setvouch #channel\``);
    const c = getConfig(); c.vouchChannelId = ch.id; writeJson("config.json", c);
    await message.reply(`✅ Vouch channel set to ${ch}`);
    return;
  }

  if (cmd === "setlogchannel") {
    const ch = message.mentions.channels.first();
    if (!ch) return void message.reply(`Usage: \`${prefix}setlogchannel #channel\``);
    const c = getConfig(); c.logChannelId = ch.id; writeJson("config.json", c);
    await message.reply(`✅ Log channel set to ${ch}`);
    return;
  }

  if (cmd === "setannouncechannel") {
    const ch = message.mentions.channels.first();
    if (!ch) return void message.reply(`Usage: \`${prefix}setannouncechannel #channel\``);
    const c = getConfig(); c.announceChannelId = ch.id; writeJson("config.json", c);
    await message.reply(`✅ Announce channel set to ${ch}`);
    return;
  }

  if (cmd === "setgenchannel") {
    const ch = message.mentions.channels.first();
    if (args[0]?.toLowerCase() === "remove" || args[0]?.toLowerCase() === "none") {
      const c = getConfig(); c.genChannelId = null; writeJson("config.json", c);
      await message.reply(`✅ Gen channel restriction removed. \`${prefix}gen\` can be used anywhere.`);
      return;
    }
    if (!ch) return void message.reply(`Usage: \`${prefix}setgenchannel #channel\` | \`${prefix}setgenchannel remove\` to disable`);
    const c = getConfig(); c.genChannelId = ch.id; writeJson("config.json", c);
    await message.reply(`✅ Gen channel set to ${ch}! \`${prefix}gen\` will only work in that channel.`);
    return;
  }

  if (cmd === "setgenrole") {
    const role = message.mentions.roles.first();
    if (args[0]?.toLowerCase() === "remove" || args[0]?.toLowerCase() === "none") {
      const c = getConfig(); c.genRoleId = null; writeJson("config.json", c);
      await message.reply(`✅ Gen role restriction removed. Anyone can now use \`${prefix}gen\`.`);
      return;
    }
    if (!role) return void message.reply(`Usage: \`${prefix}setgenrole @role\` | \`${prefix}setgenrole remove\` to disable`);
    const c = getConfig(); c.genRoleId = role.id; writeJson("config.json", c);
    await message.reply(`✅ Gen role set to ${role}! Only members with this role can use \`${prefix}gen\`.`);
    return;
  }

  if (cmd === "setautorole") {
    const role = message.mentions.roles.first();
    if (!role) return void message.reply(`Usage: \`${prefix}setautorole <status text> @role\``);
    const statusText = message.content
      .slice((prefix + "setautorole").length)
      .replace(`<@&${role.id}>`, "").trim();
    if (!statusText) return void message.reply(`Usage: \`${prefix}setautorole <status text> @role\``);
    const c = getConfig(); c.autorole = { statusText, roleId: role.id }; writeJson("config.json", c);
    await message.reply(`✅ Autorole set! Status: **"${statusText}"** → ${role}`);
    return;
  }

  if (cmd === "setboostrole") {
    const role = message.mentions.roles.first();
    if (!role) return void message.reply(`Usage: \`${prefix}setboostrole @role\``);
    const c = getConfig(); c.boostRoleId = role.id; writeJson("config.json", c);
    await message.reply(`✅ Boost role set to ${role}! 🚀 45 gens/day · 5 min cooldown`);
    return;
  }

  if (cmd === "setpremiumrole") {
    const role = message.mentions.roles.first();
    if (!role) return void message.reply(`Usage: \`${prefix}setpremiumrole @role\``);
    const c = getConfig(); c.premiumRoleId = role.id; writeJson("config.json", c);
    await message.reply(`✅ Premium role set to ${role}! ⭐ 30 gens/day · 7 min cooldown`);
    return;
  }

  if (cmd === "setlowstock") {
    const n = parseInt(args[0] ?? "", 10);
    if (isNaN(n) || n < 1) return void message.reply(`Usage: \`${prefix}setlowstock <number>\``);
    const c = getConfig(); c.lowStockThreshold = n; writeJson("config.json", c);
    await message.reply(`✅ Low stock alert will trigger when a stock has ≤ **${n}** item(s).`);
    return;
  }

  if (cmd === "setminage") {
    const n = parseInt(args[0] ?? "", 10);
    if (isNaN(n) || n < 0) return void message.reply(`Usage: \`${prefix}setminage <days>\` (0 to disable)`);
    const c = getConfig(); c.minAccountAgeDays = n; writeJson("config.json", c);
    await message.reply(n === 0 ? `✅ Account age check disabled.` : `✅ Minimum account age set to **${n} day(s)**.`);
    return;
  }

  if (cmd === "setvouchtimeout") {
    const n = parseInt(args[0] ?? "", 10);
    if (isNaN(n) || n < 1) return void message.reply(`Usage: \`${prefix}setvouchtimeout <minutes>\``);
    const c = getConfig(); c.vouchTimeoutMinutes = n; writeJson("config.json", c);
    await message.reply(`✅ Vouch timeout set to **${n} minutes**.`);
    return;
  }

  if (cmd === "announce") {
    if (!cfg.announceChannelId)
      return void message.reply(`❌ No announce channel set. Use \`${prefix}setannouncechannel #channel\` first.`);
    const text = message.content.slice((prefix + "announce").length).trim();
    if (!text) return void message.reply(`Usage: \`${prefix}announce <message>\``);
    try {
      const ch = message.guild.channels.cache.get(cfg.announceChannelId);
      if (!ch?.isTextBased()) return void message.reply("❌ Announce channel not found or not a text channel.");
      await ch.send({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("📢 Announcement")
          .setDescription(text)
          .setFooter({ text: `From ${message.author.tag}` })
          .setTimestamp()
        ],
      });
      await message.reply("✅ Announcement sent!");
    } catch {
      await message.reply("❌ Failed to send announcement. Check bot permissions.");
    }
    return;
  }
});

client.login(token).catch((err: unknown) => {
  logger.error("Discord bot failed to login", err);
  process.exit(1);
});

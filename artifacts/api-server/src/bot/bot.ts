import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  type Message,
  type GuildMember,
} from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../../data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Config {
  prefix: string;
  vouchChannelId: string | null;
  autorole: { statusText: string; roleId: string } | null;
  boostRoleId: string | null;
  premiumRoleId: string | null;
}

interface BlacklistEntry {
  id: string;
  type: "temp" | "perm";
  until?: number;
}

interface Blacklist {
  users: BlacklistEntry[];
}

interface Stocks {
  [name: string]: string[];
}

interface Cooldowns {
  [userId: string]: number;
}

interface DailyUsage {
  [userId: string]: { date: string; count: number };
}

interface PendingVouch {
  pendingSince: number; // ms timestamp of gen
  warned: boolean;      // 2-min warning sent?
  stockName: string;
  guildId: string;
}

interface PendingVouches {
  [userId: string]: PendingVouch;
}

interface MissCount {
  [userId: string]: number;
}

// ─── Tier config ──────────────────────────────────────────────────────────────

type Tier = "boost" | "premium" | "free";

const TIER_SETTINGS: Record<Tier, { cooldownMs: number; dailyLimit: number; label: string }> = {
  boost:   { cooldownMs: 5  * 60 * 1000, dailyLimit: 45, label: "🚀 Boost"   },
  premium: { cooldownMs: 7  * 60 * 1000, dailyLimit: 30, label: "⭐ Premium" },
  free:    { cooldownMs: 10 * 60 * 1000, dailyLimit: 20, label: "👤 Free"    },
};

// Progressive blacklist durations (minutes). Index = miss count (1-based).
// Index 0 unused; index 5+ = permanent.
const MISS_DURATIONS: number[] = [0, 30, 40, 50, 60];

// ─── Data helpers ─────────────────────────────────────────────────────────────

function readJson<T>(file: string, defaultVal: T): T {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) return defaultVal;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return defaultVal;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

const getConfig        = (): Config         => readJson<Config>        ("config.json",   { prefix: "&", vouchChannelId: null, autorole: null, boostRoleId: null, premiumRoleId: null });
const getStocks        = (): Stocks         => readJson<Stocks>        ("stocks.json",   {});
const getBlacklist     = (): Blacklist      => readJson<Blacklist>     ("blacklist.json",{ users: [] });
const getCooldowns     = (): Cooldowns      => readJson<Cooldowns>     ("cooldowns.json",{});
const getDailyUsage    = (): DailyUsage     => readJson<DailyUsage>    ("daily.json",    {});
const getPendingVouches= (): PendingVouches => readJson<PendingVouches>("vouches.json",  {});
const getMissCount     = (): MissCount      => readJson<MissCount>     ("misses.json",   {});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getUserTier(member: GuildMember, config: Config): Tier {
  if (config.boostRoleId   && member.roles.cache.has(config.boostRoleId))   return "boost";
  if (config.premiumRoleId && member.roles.cache.has(config.premiumRoleId)) return "premium";
  return "free";
}

function isAdmin(message: Message): boolean {
  return (
    message.member?.permissions.has("ManageGuild") ||
    message.member?.permissions.has("Administrator") ||
    false
  );
}

function checkBlacklist(userId: string): boolean {
  const bl = getBlacklist();
  const entry = bl.users.find((u) => u.id === userId);
  if (!entry) return false;
  if (entry.type === "perm") return true;
  if (entry.type === "temp" && entry.until && Date.now() < entry.until) return true;
  bl.users = bl.users.filter(
    (u) => !(u.id === userId && u.type === "temp" && u.until && Date.now() >= u.until)
  );
  writeJson("blacklist.json", bl);
  return false;
}

/** Apply progressive blacklist for vouch miss. Returns duration string for messaging. */
async function applyMissBlacklist(
  client: Client,
  userId: string,
  username: string
): Promise<void> {
  const misses = getMissCount();
  const prev = misses[userId] ?? 0;
  const newCount = prev + 1;
  misses[userId] = newCount;
  writeJson("misses.json", misses);

  const bl = getBlacklist();
  bl.users = bl.users.filter((u) => u.id !== userId);

  let durationText: string;
  if (newCount >= 5) {
    bl.users.push({ id: userId, type: "perm" });
    durationText = "**permanently**";
  } else {
    const minutes = MISS_DURATIONS[newCount] ?? 30;
    bl.users.push({ id: userId, type: "temp", until: Date.now() + minutes * 60 * 1000 });
    durationText = `for **${minutes} minutes**`;
  }
  writeJson("blacklist.json", bl);

  // DM the user
  try {
    const user = await client.users.fetch(userId);
    const config = getConfig();
    const ticketNote = config.vouchChannelId
      ? `\n\nIf you think this is a mistake, make a ticket in the server.`
      : `\n\nIf you think this is a mistake, make a ticket in the server.`;
    await user.send({
      embeds: [
        {
          color: 0xed4245,
          title: "⛔ You Have Been Blacklisted",
          description:
            `You have been blacklisted ${durationText} for missing your vouch.\n\n` +
            `**Miss count:** ${newCount}${newCount >= 5 ? " (max — permanent ban)" : ""}\n` +
            `**Blacklisted:** ${durationText}` +
            ticketNote,
          footer: { text: `Username: ${username}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch {
    // User has DMs closed — nothing we can do
  }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

export function startBot(): void {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_TOKEN not set — Discord bot will not start.");
    return;
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

  client.once("ready", () => {
    logger.info(`Discord bot logged in as ${client.user?.tag}`);
  });

  // ── Periodic vouch reminder check (every 30s) ─────────────────────────────
  setInterval(async () => {
    const pending = getPendingVouches();
    const now = Date.now();
    const TWO_MIN = 2 * 60 * 1000;
    let changed = false;

    for (const [userId, data] of Object.entries(pending)) {
      if (!data.warned && now - data.pendingSince >= TWO_MIN) {
        // Send 2-minute reminder DM
        try {
          const user = await client.users.fetch(userId);
          const config = getConfig();
          const vouchMention = config.vouchChannelId
            ? `<#${config.vouchChannelId}>`
            : "the vouch channel";
          await user.send({
            embeds: [
              {
                color: 0xfee75c,
                title: "⚠️ Vouch Reminder",
                description:
                  `You received an item from **${data.stockName}** but haven't vouched yet.\n\n` +
                  `✅ **Vouch here:** ${vouchMention}\n\n` +
                  `⛔ **If you don't vouch, you will be blacklisted.**`,
                footer: { text: "Please vouch as soon as possible!" },
                timestamp: new Date().toISOString(),
              },
            ],
          });
        } catch {
          // DMs closed
        }
        pending[userId]!.warned = true;
        changed = true;
      }
    }
    if (changed) writeJson("vouches.json", pending);
  }, 30_000);

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const config = getConfig();

    // ── Vouch channel monitoring ───────────────────────────────────────────
    if (
      config.vouchChannelId &&
      message.channelId === config.vouchChannelId &&
      message.guild
    ) {
      const pending = getPendingVouches();
      if (pending[message.author.id]) {
        delete pending[message.author.id];
        writeJson("vouches.json", pending);
        // Silent clear — vouch received
      }
      return;
    }

    if (!message.guild) return;

    const prefix = config.prefix;
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();
    if (!command) return;

    // ── &help ─────────────────────────────────────────────────────────────────
    if (command === "help") {
      await message.channel.send({
        embeds: [
          {
            color: 0x5865f2,
            title: "📦 Stock Bot — Command List",
            fields: [
              {
                name: "👤 User Commands",
                value: [
                  `\`${prefix}gen <stock>\` — Get an item from a stock`,
                  `\`${prefix}stock <stock>\` — See how many items are left`,
                  `\`${prefix}checkstatus\` — Check your status & get your role`,
                  `\`${prefix}help\` — Show this message`,
                ].join("\n"),
              },
              {
                name: "📊 Gen Limits & Cooldowns",
                value: [
                  `🚀 **Boost**   — 45/day · 5 min cooldown`,
                  `⭐ **Premium** — 30/day · 7 min cooldown`,
                  `👤 **Free**    — 20/day · 10 min cooldown`,
                ].join("\n"),
              },
              {
                name: "⚠️ Vouch Miss Blacklist",
                value: [
                  `1st miss → 30 min blacklist`,
                  `2nd miss → 40 min blacklist`,
                  `3rd miss → 50 min blacklist`,
                  `4th miss → 60 min blacklist`,
                  `5th miss → **Permanent blacklist**`,
                ].join("\n"),
              },
              {
                name: "🔧 Admin Commands",
                value: [
                  `\`${prefix}createstock <name>\` — Create a new stock`,
                  `\`${prefix}addstock <name> <item>\` — Add item to a stock`,
                  `\`${prefix}setprefix <prefix>\` — Change bot prefix`,
                  `\`${prefix}setvouch #channel\` — Set vouch channel`,
                  `\`${prefix}setautorole <status> @role\` — Autorole on status`,
                  `\`${prefix}setboostrole @role\` — Set Boost role`,
                  `\`${prefix}setpremiumrole @role\` — Set Premium role`,
                  `\`${prefix}missvouch @user\` — Mark vouch miss (auto-blacklist)`,
                  `\`${prefix}blacklist @user [temp <min>]\` — Blacklist a user`,
                  `\`${prefix}unblacklist @user\` — Remove from blacklist`,
                ].join("\n"),
              },
            ],
            footer: { text: `Current prefix: ${prefix}` },
          },
        ],
      });
      return;
    }

    // ── &createstock <name> ───────────────────────────────────────────────────
    if (command === "createstock") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const name = args[0]?.toLowerCase();
      if (!name)
        return void message.reply(`Usage: \`${prefix}createstock <name>\``);
      const stocks = getStocks();
      if (stocks[name])
        return void message.reply(`❌ Stock \`${name}\` already exists.`);
      stocks[name] = [];
      writeJson("stocks.json", stocks);
      await message.reply(`✅ Stock \`${name}\` has been created!`);
      return;
    }

    // ── &addstock <name> <item> ───────────────────────────────────────────────
    if (command === "addstock") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const name = args[0]?.toLowerCase();
      const item = args.slice(1).join(" ");
      if (!name || !item)
        return void message.reply(`Usage: \`${prefix}addstock <name> <item>\``);
      const stocks = getStocks();
      if (!stocks[name])
        return void message.reply(
          `❌ Stock \`${name}\` does not exist. Create it first with \`${prefix}createstock\`.`
        );
      stocks[name].push(item);
      writeJson("stocks.json", stocks);
      await message.reply(
        `✅ Item added to \`${name}\`! Stock now has **${stocks[name].length}** item(s).`
      );
      return;
    }

    // ── &stock <name> ─────────────────────────────────────────────────────────
    if (command === "stock") {
      const name = args[0]?.toLowerCase();
      if (!name) return void message.reply(`Usage: \`${prefix}stock <name>\``);
      const stocks = getStocks();
      if (!stocks[name])
        return void message.reply(`❌ Stock \`${name}\` does not exist.`);
      const count = stocks[name].length;
      await message.reply(
        count === 0
          ? `📦 **${name}** is currently **out of stock**.`
          : `📦 **${name}** has **${count}** item(s) available.`
      );
      return;
    }

    // ── &gen <name> ───────────────────────────────────────────────────────────
    if (command === "gen") {
      const name = args[0]?.toLowerCase();
      if (!name) return void message.reply(`Usage: \`${prefix}gen <name>\``);

      if (checkBlacklist(message.author.id))
        return void message.reply("🚫 You are blacklisted and cannot use `gen`.");

      const member = message.member!;
      const tier = getUserTier(member, config);
      const { cooldownMs, dailyLimit, label } = TIER_SETTINGS[tier];

      // Cooldown check
      const cooldowns = getCooldowns();
      const lastUsed = cooldowns[message.author.id];
      if (lastUsed && Date.now() - lastUsed < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - (Date.now() - lastUsed)) / 1000);
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        return void message.reply(
          `⏳ Cooldown active! Wait **${mins}m ${secs}s** before using \`${prefix}gen\` again.\n${label} tier cooldown: ${cooldownMs / 60000} min`
        );
      }

      // Daily limit check
      const daily = getDailyUsage();
      const today = todayStr();
      const userDaily = daily[message.author.id];
      const todayCount = userDaily?.date === today ? userDaily.count : 0;
      if (todayCount >= dailyLimit) {
        return void message.reply(
          `📵 You have reached your daily limit of **${dailyLimit} gens** (${label} tier). Come back tomorrow!`
        );
      }

      // Stock check
      const stocks = getStocks();
      if (!stocks[name])
        return void message.reply(`❌ Stock \`${name}\` does not exist.`);
      if (stocks[name].length === 0)
        return void message.reply(`❌ **${name}** is out of stock!`);

      const item = stocks[name].shift()!;
      writeJson("stocks.json", stocks);

      cooldowns[message.author.id] = Date.now();
      writeJson("cooldowns.json", cooldowns);

      daily[message.author.id] = { date: today, count: todayCount + 1 };
      writeJson("daily.json", daily);

      const vouchLine = config.vouchChannelId
        ? `\n\n✅ **Vouch here:** <#${config.vouchChannelId}>\n⚠️ **No vouch = blacklist**`
        : "";

      try {
        await message.author.send({
          embeds: [
            {
              color: 0x57f287,
              title: `📦 Your item from: ${name}`,
              description: `\`\`\`\n${item}\n\`\`\`${vouchLine}`,
              fields: [
                {
                  name: "Your Tier",
                  value: `${label} — ${todayCount + 1}/${dailyLimit} gens used today`,
                  inline: true,
                },
              ],
              footer: { text: "Enjoy! Remember to vouch." },
              timestamp: new Date().toISOString(),
            },
          ],
        });
        await message.reply(
          `✅ Check your DMs, ${message.author}! (**${todayCount + 1}/${dailyLimit}** gens used today)`
        );

        // Register pending vouch (2-min reminder will fire from interval)
        if (config.vouchChannelId) {
          const pending = getPendingVouches();
          pending[message.author.id] = {
            pendingSince: Date.now(),
            warned: false,
            stockName: name,
            guildId: message.guild.id,
          };
          writeJson("vouches.json", pending);
        }
      } catch {
        // Refund everything
        stocks[name].unshift(item);
        writeJson("stocks.json", stocks);
        delete cooldowns[message.author.id];
        writeJson("cooldowns.json", cooldowns);
        daily[message.author.id] = { date: today, count: todayCount };
        writeJson("daily.json", daily);
        await message.reply(
          `❌ Could not DM you, ${message.author}. Please open your DMs and try again.`
        );
      }
      return;
    }

    // ── &missvouch @user ──────────────────────────────────────────────────────
    if (command === "missvouch") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const target = message.mentions.users.first();
      if (!target)
        return void message.reply(`Usage: \`${prefix}missvouch @user\``);

      // Clear pending vouch entry if exists
      const pending = getPendingVouches();
      delete pending[target.id];
      writeJson("vouches.json", pending);

      const misses = getMissCount();
      const currentMisses = (misses[target.id] ?? 0) + 1;

      await applyMissBlacklist(client, target.id, target.tag);

      const bl = getBlacklist();
      const entry = bl.users.find((u) => u.id === target.id);
      let resultMsg: string;
      if (entry?.type === "perm") {
        resultMsg = `🚫 **${target.tag}** has been **permanently blacklisted** (miss #${currentMisses}).`;
      } else {
        const minutes = MISS_DURATIONS[currentMisses] ?? 30;
        resultMsg = `⛔ **${target.tag}** has been blacklisted for **${minutes} min** (miss #${currentMisses}).`;
      }
      await message.reply(resultMsg);
      return;
    }

    // ── &checkstatus ──────────────────────────────────────────────────────────
    if (command === "checkstatus") {
      if (!config.autorole)
        return void message.reply(
          `❌ No autorole configured yet. Ask an admin to set it up with \`${prefix}setautorole\`.`
        );

      const { statusText, roleId } = config.autorole;
      const member = message.member!;
      const customActivity = member.presence?.activities.find(
        (a) => a.type === ActivityType.Custom
      );
      const currentStatus = customActivity?.state ?? "";

      if (currentStatus.toLowerCase().includes(statusText.toLowerCase())) {
        if (member.roles.cache.has(roleId)) {
          await message.reply("✅ Your status is correct and you already have the role!");
        } else {
          try {
            await member.roles.add(roleId);
            await message.reply("✅ Your status is correct! You have been given the role.");
          } catch {
            await message.reply(
              "❌ Could not assign the role. Make sure the bot has **Manage Roles** permission and its role is above the target role."
            );
          }
        }
      } else {
        await message.reply(
          `❌ Your current status is not correct.\n\nYour status must contain: **"${statusText}"**\n\nPlease update your Discord status and try \`${prefix}checkstatus\` again.`
        );
      }
      return;
    }

    // ── &setprefix ────────────────────────────────────────────────────────────
    if (command === "setprefix") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const newPrefix = args[0];
      if (!newPrefix)
        return void message.reply(`Usage: \`${prefix}setprefix <new_prefix>\``);
      const c = getConfig(); c.prefix = newPrefix;
      writeJson("config.json", c);
      await message.reply(`✅ Prefix changed to \`${newPrefix}\``);
      return;
    }

    // ── &setvouch #channel ────────────────────────────────────────────────────
    if (command === "setvouch") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const channel = message.mentions.channels.first();
      if (!channel)
        return void message.reply(`Usage: \`${prefix}setvouch #channel\``);
      const c = getConfig(); c.vouchChannelId = channel.id;
      writeJson("config.json", c);
      await message.reply(`✅ Vouch channel set to ${channel}`);
      return;
    }

    // ── &setautorole <status> @role ───────────────────────────────────────────
    if (command === "setautorole") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const role = message.mentions.roles.first();
      if (!role)
        return void message.reply(`Usage: \`${prefix}setautorole <status text> @role\``);
      const statusText = message.content
        .slice((prefix + "setautorole").length)
        .replace(`<@&${role.id}>`, "")
        .trim();
      if (!statusText)
        return void message.reply(`Usage: \`${prefix}setautorole <status text> @role\``);
      const c = getConfig();
      c.autorole = { statusText, roleId: role.id };
      writeJson("config.json", c);
      await message.reply(
        `✅ Autorole configured! Members with **"${statusText}"** in their status will get ${role} via \`${prefix}checkstatus\`.`
      );
      return;
    }

    // ── &setboostrole @role ───────────────────────────────────────────────────
    if (command === "setboostrole") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const role = message.mentions.roles.first();
      if (!role)
        return void message.reply(`Usage: \`${prefix}setboostrole @role\``);
      const c = getConfig(); c.boostRoleId = role.id;
      writeJson("config.json", c);
      await message.reply(`✅ Boost role set to ${role}! 🚀 45 gens/day · 5 min cooldown`);
      return;
    }

    // ── &setpremiumrole @role ─────────────────────────────────────────────────
    if (command === "setpremiumrole") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const role = message.mentions.roles.first();
      if (!role)
        return void message.reply(`Usage: \`${prefix}setpremiumrole @role\``);
      const c = getConfig(); c.premiumRoleId = role.id;
      writeJson("config.json", c);
      await message.reply(`✅ Premium role set to ${role}! ⭐ 30 gens/day · 7 min cooldown`);
      return;
    }

    // ── &blacklist @user [temp <minutes>] ─────────────────────────────────────
    if (command === "blacklist") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const target = message.mentions.users.first();
      if (!target)
        return void message.reply(`Usage: \`${prefix}blacklist @user [temp <minutes>]\``);
      const bl = getBlacklist();
      bl.users = bl.users.filter((u) => u.id !== target.id);
      if (args[1]?.toLowerCase() === "temp") {
        const minutes = parseInt(args[2] ?? "60", 10);
        bl.users.push({ id: target.id, type: "temp", until: Date.now() + minutes * 60 * 1000 });
        writeJson("blacklist.json", bl);
        await message.reply(`✅ **${target.tag}** blacklisted for **${minutes} min**.`);
      } else {
        bl.users.push({ id: target.id, type: "perm" });
        writeJson("blacklist.json", bl);
        await message.reply(`✅ **${target.tag}** permanently blacklisted.`);
      }
      return;
    }

    // ── &unblacklist @user ────────────────────────────────────────────────────
    if (command === "unblacklist") {
      if (!isAdmin(message))
        return void message.reply("❌ You need **Manage Server** permission.");
      const target = message.mentions.users.first();
      if (!target)
        return void message.reply(`Usage: \`${prefix}unblacklist @user\``);
      const bl = getBlacklist();
      const before = bl.users.length;
      bl.users = bl.users.filter((u) => u.id !== target.id);
      if (bl.users.length === before)
        return void message.reply(`❌ **${target.tag}** is not blacklisted.`);
      writeJson("blacklist.json", bl);
      await message.reply(`✅ **${target.tag}** removed from blacklist.`);
      return;
    }
  });

  client.login(token).catch((err: unknown) => {
    logger.error({ err }, "Discord bot failed to login");
  });
}

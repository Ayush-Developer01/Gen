import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  type Message,
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

const getConfig = (): Config =>
  readJson<Config>("config.json", {
    prefix: "&",
    vouchChannelId: null,
    autorole: null,
  });

const getStocks = (): Stocks => readJson<Stocks>("stocks.json", {});
const getBlacklist = (): Blacklist =>
  readJson<Blacklist>("blacklist.json", { users: [] });
const getCooldowns = (): Cooldowns => readJson<Cooldowns>("cooldowns.json", {});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COOLDOWN_MS = 5 * 60 * 1000;

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
  if (entry.type === "temp" && entry.until && Date.now() < entry.until)
    return true;
  // Expired — remove
  bl.users = bl.users.filter(
    (u) =>
      !(u.id === userId && u.type === "temp" && u.until && Date.now() >= u.until)
  );
  writeJson("blacklist.json", bl);
  return false;
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

  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    const config = getConfig();
    const prefix = config.prefix;
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();
    if (!command) return;

    // ── &help ────────────────────────────────────────────────────────────────
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
                  `\`${prefix}gen <stock>\` — Get an item (5 min cooldown)`,
                  `\`${prefix}stock <stock>\` — See how many items are left`,
                  `\`${prefix}checkstatus\` — Check your status & get your role`,
                  `\`${prefix}help\` — Show this message`,
                ].join("\n"),
              },
              {
                name: "🔧 Admin Commands",
                value: [
                  `\`${prefix}createstock <name>\` — Create a new stock`,
                  `\`${prefix}addstock <name> <item>\` — Add an item to a stock`,
                  `\`${prefix}setprefix <prefix>\` — Change the bot prefix`,
                  `\`${prefix}setvouch #channel\` — Set the vouch channel`,
                  `\`${prefix}setautorole <status text> @role\` — Give role when status matches`,
                  `\`${prefix}blacklist @user [temp <minutes>]\` — Blacklist a user`,
                  `\`${prefix}unblacklist @user\` — Remove user from blacklist`,
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
        return void message.reply(
          "❌ You need **Manage Server** permission to use this."
        );
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
        return void message.reply(
          "❌ You need **Manage Server** permission to use this."
        );
      const name = args[0]?.toLowerCase();
      const item = args.slice(1).join(" ");
      if (!name || !item)
        return void message.reply(
          `Usage: \`${prefix}addstock <name> <item>\``
        );
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
      if (!name)
        return void message.reply(`Usage: \`${prefix}stock <name>\``);
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
      if (!name)
        return void message.reply(`Usage: \`${prefix}gen <name>\``);

      if (checkBlacklist(message.author.id))
        return void message.reply(
          "🚫 You are blacklisted and cannot use `gen`."
        );

      const cooldowns = getCooldowns();
      const lastUsed = cooldowns[message.author.id];
      if (lastUsed && Date.now() - lastUsed < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastUsed)) / 1000);
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        return void message.reply(
          `⏳ Cooldown active! Please wait **${mins}m ${secs}s** before using \`${prefix}gen\` again.`
        );
      }

      const stocks = getStocks();
      if (!stocks[name])
        return void message.reply(`❌ Stock \`${name}\` does not exist.`);
      if (stocks[name].length === 0)
        return void message.reply(`❌ **${name}** is out of stock!`);

      const item = stocks[name].shift()!;
      writeJson("stocks.json", stocks);

      cooldowns[message.author.id] = Date.now();
      writeJson("cooldowns.json", cooldowns);

      const config = getConfig();
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
              footer: { text: "Enjoy! Remember to vouch." },
              timestamp: new Date().toISOString(),
            },
          ],
        });
        await message.reply(`✅ Check your DMs, ${message.author}!`);
      } catch {
        // DMs closed — refund item & cooldown
        stocks[name].unshift(item);
        writeJson("stocks.json", stocks);
        delete cooldowns[message.author.id];
        writeJson("cooldowns.json", cooldowns);
        await message.reply(
          `❌ Could not DM you, ${message.author}. Please open your DMs and try again.`
        );
      }
      return;
    }

    // ── &checkstatus ─────────────────────────────────────────────────────────
    if (command === "checkstatus") {
      const config = getConfig();

      if (!config.autorole) {
        return void message.reply(
          "❌ No autorole has been configured yet. Ask an admin to set it up with `" +
            prefix +
            "setautorole`."
        );
      }

      const { statusText, roleId } = config.autorole;
      const member = message.member;
      if (!member) return;

      // Fetch fresh presence
      const presence = member.presence;
      const customActivity = presence?.activities.find(
        (a) => a.type === ActivityType.Custom
      );
      const currentStatus = customActivity?.state ?? "";

      if (currentStatus.toLowerCase().includes(statusText.toLowerCase())) {
        // Status matches — give role
        if (member.roles.cache.has(roleId)) {
          await message.reply(
            "✅ Your status is correct and you already have the role!"
          );
        } else {
          try {
            await member.roles.add(roleId);
            await message.reply(
              `✅ Your status is correct! You have been given the role.`
            );
          } catch {
            await message.reply(
              "❌ Could not assign the role. Make sure the bot has the **Manage Roles** permission and the role is below the bot's role."
            );
          }
        }
      } else {
        // Status does not match
        await message.reply(
          `❌ Your current status is not correct.\n\nYour status must contain: **"${statusText}"**\n\nPlease set your Discord status to the required text and try again.`
        );
      }
      return;
    }

    // ── &setprefix <prefix> ───────────────────────────────────────────────────
    if (command === "setprefix") {
      if (!isAdmin(message))
        return void message.reply(
          "❌ You need **Manage Server** permission to use this."
        );
      const newPrefix = args[0];
      if (!newPrefix)
        return void message.reply(
          `Usage: \`${prefix}setprefix <new_prefix>\``
        );
      const config = getConfig();
      config.prefix = newPrefix;
      writeJson("config.json", config);
      await message.reply(`✅ Prefix changed to \`${newPrefix}\``);
      return;
    }

    // ── &setvouch #channel ────────────────────────────────────────────────────
    if (command === "setvouch") {
      if (!isAdmin(message))
        return void message.reply(
          "❌ You need **Manage Server** permission to use this."
        );
      const channel = message.mentions.channels.first();
      if (!channel)
        return void message.reply(`Usage: \`${prefix}setvouch #channel\``);
      const config = getConfig();
      config.vouchChannelId = channel.id;
      writeJson("config.json", config);
      await message.reply(`✅ Vouch channel set to ${channel}`);
      return;
    }

    // ── &setautorole <status text> @role ──────────────────────────────────────
    if (command === "setautorole") {
      if (!isAdmin(message))
        return void message.reply(
          "❌ You need **Manage Server** permission to use this."
        );
      const role = message.mentions.roles.first();
      if (!role)
        return void message.reply(
          `Usage: \`${prefix}setautorole <status text> @role\``
        );
      const statusText = message.content
        .slice((prefix + "setautorole").length)
        .replace(`<@&${role.id}>`, "")
        .trim();
      if (!statusText)
        return void message.reply(
          `Usage: \`${prefix}setautorole <status text> @role\``
        );
      const config = getConfig();
      config.autorole = { statusText, roleId: role.id };
      writeJson("config.json", config);
      await message.reply(
        `✅ Autorole configured!\nUsers who type \`${prefix}checkstatus\` with **"${statusText}"** in their status will receive ${role}.`
      );
      return;
    }

    // ── &blacklist @user [temp <minutes>] ─────────────────────────────────────
    if (command === "blacklist") {
      if (!isAdmin(message))
        return void message.reply(
          "❌ You need **Manage Server** permission to use this."
        );
      const target = message.mentions.users.first();
      if (!target)
        return void message.reply(
          `Usage: \`${prefix}blacklist @user [temp <minutes>]\``
        );
      const bl = getBlacklist();
      bl.users = bl.users.filter((u) => u.id !== target.id);

      if (args[1]?.toLowerCase() === "temp") {
        const minutes = parseInt(args[2] ?? "60", 10);
        bl.users.push({
          id: target.id,
          type: "temp",
          until: Date.now() + minutes * 60 * 1000,
        });
        writeJson("blacklist.json", bl);
        await message.reply(
          `✅ **${target.tag}** has been temporarily blacklisted for **${minutes} minute(s)**.`
        );
      } else {
        bl.users.push({ id: target.id, type: "perm" });
        writeJson("blacklist.json", bl);
        await message.reply(
          `✅ **${target.tag}** has been permanently blacklisted.`
        );
      }
      return;
    }

    // ── &unblacklist @user ────────────────────────────────────────────────────
    if (command === "unblacklist") {
      if (!isAdmin(message))
        return void message.reply(
          "❌ You need **Manage Server** permission to use this."
        );
      const target = message.mentions.users.first();
      if (!target)
        return void message.reply(`Usage: \`${prefix}unblacklist @user\``);
      const bl = getBlacklist();
      const before = bl.users.length;
      bl.users = bl.users.filter((u) => u.id !== target.id);
      if (bl.users.length === before)
        return void message.reply(
          `❌ **${target.tag}** is not in the blacklist.`
        );
      writeJson("blacklist.json", bl);
      await message.reply(
        `✅ **${target.tag}** has been removed from the blacklist.`
      );
      return;
    }
  });

  client.login(token).catch((err: unknown) => {
    logger.error({ err }, "Discord bot failed to login");
  });
}

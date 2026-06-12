import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ComponentType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import pg from "pg";

// Prevent any single failed Discord API call from crashing the whole bot
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (bot kept alive):", err?.message ?? err);
});

// =================== DATABASE SETUP ===================

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_users (
      discord_id VARCHAR(32) PRIMARY KEY,
      username VARCHAR(100) NOT NULL DEFAULT '',
      balance INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      earn_count INTEGER NOT NULL DEFAULT 0,
      earn_window_start TIMESTAMP,
      last_daily TIMESTAMP,
      daily_streak INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      joined_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS daily_streak INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS total_earned INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS joined_at TIMESTAMP NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS last_hunt TIMESTAMP`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS crates INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS hunt_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS hunt_window_start TIMESTAMP`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS last_adventure TIMESTAMP`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS luck_boost_until TIMESTAMP`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS daily_boost INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS duel_shield INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS cf_guard INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS quests_completed_total INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS quest_bonus_claimed_at TIMESTAMP`);
  await pool.query(`ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS quest_reroll_used_at TIMESTAMP`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_quests (
      discord_id VARCHAR(32) NOT NULL,
      quest_slot INTEGER NOT NULL,
      quest_key VARCHAR(64) NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      claimed BOOLEAN NOT NULL DEFAULT FALSE,
      generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (discord_id, quest_slot)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_logs (
      id SERIAL PRIMARY KEY,
      discord_id VARCHAR(32) NOT NULL,
      username VARCHAR(100) NOT NULL DEFAULT '',
      action VARCHAR(200) NOT NULL,
      result TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS animal_inventory (
      discord_id VARCHAR(32) NOT NULL,
      animal_key VARCHAR(32) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (discord_id, animal_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key VARCHAR(64) PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id VARCHAR(32) PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`DELETE FROM processed_messages WHERE created_at < NOW() - INTERVAL '10 minutes'`);

  const settingsRows = await pool.query("SELECT key, value FROM bot_settings WHERE key IN ('currency_emoji', 'log_channel_id', 'games_enabled')");
  for (const row of settingsRows.rows) {
    if (row.key === 'currency_emoji') currencyEmoji = row.value;
    if (row.key === 'log_channel_id') logChannelId = row.value;
    if (row.key === 'games_enabled') gamesEnabled = row.value !== 'false';
  }

  console.log("✅ Database ready");
}

async function setCurrencyEmoji(emoji) {
  await pool.query(
    `INSERT INTO bot_settings (key, value) VALUES ('currency_emoji', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [emoji]
  );
  currencyEmoji = emoji;
}

// =================== LOGGING + LOCK ===================

let logChannelId = null;
let discordClient = null;

const processingUsers = new Set();

function acquireLock(userId) {
  if (processingUsers.has(userId)) return false;
  processingUsers.add(userId);
  return true;
}

function releaseLock(userId) {
  processingUsers.delete(userId);
}

async function logAction(userId, username, action, result) {
  try {
    await pool.query(
      `INSERT INTO bot_logs (discord_id, username, action, result) VALUES ($1, $2, $3, $4)`,
      [userId, username, action, result]
    );
  } catch (_) {}

  if (logChannelId && discordClient) {
    try {
      const ch = discordClient.channels.cache.get(logChannelId);
      if (ch) {
        await ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(BRAND_COLOR)
              .setTitle("📋 Action Log")
              .addFields(
                { name: "User", value: `${username} (${userId})`, inline: true },
                { name: "Action", value: action, inline: true },
                { name: "Result", value: result }
              )
              .setFooter({ text: new Date().toUTCString() }),
          ],
        });
      }
    } catch (_) {}
  }
}

async function setLogChannel(channelId) {
  await pool.query(
    `INSERT INTO bot_settings (key, value) VALUES ('log_channel_id', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [channelId]
  );
  logChannelId = channelId;
}

function parseAmount(raw, balance, max = 1_000_000) {
  const amount = parseInt(raw ?? "");
  if (!raw || isNaN(amount)) return { error: "Please enter a valid number." };
  if (amount <= 0) return { error: "Amount must be greater than 0." };
  if (amount > max) return { error: `Maximum bet is **${max.toLocaleString()} ${currencyEmoji}**.` };
  if (amount > balance) return { error: `You only have **${balance} ${currencyEmoji}**.` };
  return { amount };
}

async function getOrCreateUser(discordId, username) {
  await pool.query(
    `INSERT INTO discord_users (discord_id, username)
     VALUES ($1, $2)
     ON CONFLICT (discord_id) DO UPDATE SET username = $2`,
    [discordId, username]
  );
  const { rows } = await pool.query(
    "SELECT * FROM discord_users WHERE discord_id = $1",
    [discordId]
  );
  return rows[0];
}

async function getUserRank(discordId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) + 1 AS rank FROM discord_users WHERE balance > (SELECT balance FROM discord_users WHERE discord_id = $1)`,
    [discordId]
  );
  return parseInt(rows[0].rank);
}

async function incrementMessageCount(discordId, username) {
  await pool.query(
    `INSERT INTO discord_users (discord_id, username, message_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (discord_id) DO UPDATE
     SET username = $2, message_count = discord_users.message_count + 1`,
    [discordId, username]
  );
  updateQuestProgress(discordId, username, 'message').catch(() => {});
}

// =================== CONSTANTS ===================

const PREFIX = "!";
const EARN_AMOUNT = 150;
const EARN_REQUIRED_MESSAGES = 50;
const EARN_WINDOW_HOURS = 12;
const EARN_MAX_PER_WINDOW = 2;
const DAILY_BASE_AMOUNT = 10;
const DAILY_STREAK_BONUS_EVERY = 3;
const DAILY_STREAK_BONUS = 1;
const DAILY_STREAK_MAX_BONUS = 10;
const MAX_BET = 50_000;

let currencyEmoji = "R$";

// ── Everdale brand palette ──
const BRAND_COLOR    = 0x111827;
const SECONDARY_COLOR = 0x1F2937;
const GOLD_COLOR     = 0xC9A227;
const SUCCESS_COLOR  = 0x22C55E;
const ERROR_COLOR    = 0xEF4444;
const WARN_COLOR     = 0xF59E0B;
const ROBUX_COLOR    = 0xC9A227;

const DIVIDER    = "━━━━━━━━━━━━━━━━━━━━";
const EVD_FOOTER = "Everdale • Premium Economy System";
const RARITY_BADGE = { Common: "◇", Rare: "◆", Epic: "✦", Legendary: "✧" };

let gamesEnabled = true;

const pendingDuels = new Map();

// =================== ANIMALS ===================

const ANIMALS = {
  // Common (10)
  dog:      { key: "dog",      name: "Dog",      emoji: "🐶", rarity: "Common",    value: 25 },
  cat:      { key: "cat",      name: "Cat",      emoji: "🐱", rarity: "Common",    value: 25 },
  rabbit:   { key: "rabbit",   name: "Rabbit",   emoji: "🐰", rarity: "Common",    value: 25 },
  hamster:  { key: "hamster",  name: "Hamster",  emoji: "🐹", rarity: "Common",    value: 25 },
  mouse:    { key: "mouse",    name: "Mouse",    emoji: "🐭", rarity: "Common",    value: 25 },
  turtle:   { key: "turtle",   name: "Turtle",   emoji: "🐢", rarity: "Common",    value: 25 },
  bird:     { key: "bird",     name: "Bird",     emoji: "🐦", rarity: "Common",    value: 25 },
  fish:     { key: "fish",     name: "Fish",     emoji: "🐟", rarity: "Common",    value: 25 },
  frog:     { key: "frog",     name: "Frog",     emoji: "🐸", rarity: "Common",    value: 25 },
  chick:    { key: "chick",    name: "Chick",    emoji: "🐥", rarity: "Common",    value: 25 },
  // Rare (8)
  fox:      { key: "fox",      name: "Fox",      emoji: "🦊", rarity: "Rare",      value: 50 },
  wolf:     { key: "wolf",     name: "Wolf",     emoji: "🐺", rarity: "Rare",      value: 50 },
  panda:    { key: "panda",    name: "Panda",    emoji: "🐼", rarity: "Rare",      value: 50 },
  raccoon:  { key: "raccoon",  name: "Raccoon",  emoji: "🦝", rarity: "Rare",      value: 50 },
  otter:    { key: "otter",    name: "Otter",    emoji: "🦦", rarity: "Rare",      value: 50 },
  koala:    { key: "koala",    name: "Koala",    emoji: "🐨", rarity: "Rare",      value: 50 },
  hedgehog: { key: "hedgehog", name: "Hedgehog", emoji: "🦔", rarity: "Rare",      value: 50 },
  sloth:    { key: "sloth",    name: "Sloth",    emoji: "🦥", rarity: "Rare",      value: 50 },
  // Epic (5)
  lion:     { key: "lion",     name: "Lion",     emoji: "🦁", rarity: "Epic",      value: 100 },
  tiger:    { key: "tiger",    name: "Tiger",    emoji: "🐯", rarity: "Epic",      value: 100 },
  eagle:    { key: "eagle",    name: "Eagle",    emoji: "🦅", rarity: "Epic",      value: 100 },
  elephant: { key: "elephant", name: "Elephant", emoji: "🐘", rarity: "Epic",      value: 100 },
  rhino:    { key: "rhino",    name: "Rhino",    emoji: "🦏", rarity: "Epic",      value: 100 },
  // Legendary (2)
  dragon:   { key: "dragon",   name: "Dragon",   emoji: "🐉", rarity: "Legendary", value: 250 },
  unicorn:  { key: "unicorn",  name: "Unicorn",  emoji: "🦄", rarity: "Legendary", value: 250 },
};

const RARITY_COLOR = {
  Common:    0x6B7280,
  Rare:      0x3B82F6,
  Epic:      0x8B5CF6,
  Legendary: 0xC9A227,
};

const RARITY_TABLE = [
  { rarity: "Common",    chance: 0.68, keys: ["dog", "cat", "rabbit", "hamster", "mouse", "turtle", "bird", "fish", "frog", "chick"] },
  { rarity: "Rare",      chance: 0.24, keys: ["fox", "wolf", "panda", "raccoon", "otter", "koala", "hedgehog", "sloth"] },
  { rarity: "Epic",      chance: 0.08, keys: ["lion", "tiger", "eagle", "elephant", "rhino"] },
  { rarity: "Legendary", chance: 0.01, keys: ["dragon", "unicorn"] },
];

const HUNT_MAX_PER_WINDOW = 2;
const HUNT_WINDOW_HOURS = 20;
const HUNT_WINDOW_MS = HUNT_WINDOW_HOURS * 60 * 60 * 1000;

const ADVENTURE_COOLDOWN_HOURS = 12;
const ADVENTURE_COOLDOWN_MS = ADVENTURE_COOLDOWN_HOURS * 60 * 60 * 1000;
const ADVENTURE_RESPONSE_MS = 30000;

const ADVENTURE_SCENARIOS = [
  {
    emoji: "🌲",
    title: "Enchanted Forest",
    description: "You step into a glowing forest filled with strange sounds and hidden paths...",
    choices: ["Follow a glowing trail", "Climb a tree", "Enter a hidden cave", "Search the ground carefully"],
  },
  {
    emoji: "🕳️",
    title: "Dark Cave",
    description: "You enter a deep cave. You hear water dripping and something moving...",
    choices: ["Go deeper into the cave", "Light a torch", "Follow the sound", "Leave carefully"],
  },
  {
    emoji: "🏜️",
    title: "Endless Desert",
    description: "You are walking through a hot desert. You spot something in the distance...",
    choices: ["Walk toward the object", "Dig in the sand", "Rest under a rock", "Change direction"],
  },
  {
    emoji: "🌊",
    title: "Open Ocean",
    description: "You are sailing across the ocean when something unusual appears...",
    choices: ["Dive into the water", "Follow the movement", "Cast a net", "Stay on the boat"],
  },
  {
    emoji: "🏔️",
    title: "Frozen Mountains",
    description: "You climb a snowy mountain and notice something shining...",
    choices: ["Climb higher", "Investigate the shine", "Enter a small cave", "Set up camp"],
  },
];

const ADVENTURE_OUTCOMES = ["crate", "animal", "gain", "lose", "nothing"];

const LUCKY_RARITY_TABLE = [
  { rarity: "Common",    chance: 0.50, keys: ["dog", "cat", "rabbit", "hamster", "mouse", "turtle", "bird", "fish", "frog", "chick"] },
  { rarity: "Rare",      chance: 0.30, keys: ["fox", "wolf", "panda", "raccoon", "otter", "koala", "hedgehog", "sloth"] },
  { rarity: "Epic",      chance: 0.15, keys: ["lion", "tiger", "eagle", "elephant", "rhino"] },
  { rarity: "Legendary", chance: 0.05, keys: ["dragon", "unicorn"] },
];

function rollAnimal(lucky = false) {
  const table = lucky ? LUCKY_RARITY_TABLE : RARITY_TABLE;
  const roll = Math.random();
  let acc = 0;
  for (const tier of table) {
    acc += tier.chance;
    if (roll < acc) {
      const key = tier.keys[Math.floor(Math.random() * tier.keys.length)];
      return ANIMALS[key];
    }
  }
  return ANIMALS.dog;
}

function isLuckyActive(user) {
  return user.luck_boost_until && new Date(user.luck_boost_until).getTime() > Date.now();
}

// =================== SHOP ===================

const SHOP_ITEMS = {
  wildCrate1: {
    key: "wildCrate1", name: "Wild Crate", qty: 1,
    emoji: "🎁", price: 40, category: "crates",
    description: "Contains a random pet. Open with `!crate`.",
  },
  wildCrate5: {
    key: "wildCrate5", name: "Wild Crate ×5", qty: 5,
    emoji: "🎁", price: 180, category: "crates",
    description: "5 Wild Crates at a 10% discount!",
  },
  luckBoost: {
    key: "luckBoost", name: "Luck Boost", qty: 1,
    emoji: "🍀", price: 100, category: "boosts",
    description: "Boosts rare drop rates for **1 hour**.\nCommon 50% • Rare 30% • Epic 15% • Legendary 5%",
    durationMs: 60 * 60 * 1000,
  },
  cfGuard: {
    key: "cfGuard", name: "Coinflip Guard", qty: 1,
    emoji: "🔒", price: 100, category: "protection",
    description: "Get **50% refund** on your next coinflip loss (1 use).",
  },
};

function findAnimalByName(input) {
  if (!input) return null;
  const q = input.toLowerCase().trim();
  for (const a of Object.values(ANIMALS)) {
    if (a.key === q || a.name.toLowerCase() === q || a.emoji === input.trim()) return a;
  }
  return null;
}

// =================== HELPERS ===================

function checkHuntWindow(user) {
  if (!user.hunt_window_start) return { inWindow: false, huntCount: 0 };
  const inWindow = Date.now() - new Date(user.hunt_window_start).getTime() < HUNT_WINDOW_MS;
  return { inWindow, huntCount: inWindow ? user.hunt_count : 0 };
}

function checkEarnWindow(user) {
  if (!user.earn_window_start) return { inWindow: false, earnCount: 0 };
  const windowMs = EARN_WINDOW_HOURS * 60 * 60 * 1000;
  const inWindow = Date.now() - new Date(user.earn_window_start).getTime() < windowMs;
  return { inWindow, earnCount: inWindow ? user.earn_count : 0 };
}

function progressBar(current, max, length = 18) {
  const pct = Math.min(current / max, 1);
  const filled = Math.floor(pct * length);
  const empty = length - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const percent = Math.floor(pct * 100);
  return { bar, percent };
}

function formatTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function isAdmin(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function hasSoriRole(member) {
  if (!member?.roles?.cache) return false;
  return member.roles.cache.some((r) => r.name.toLowerCase() === "sori");
}

function rankMedal(i) {
  return ["🥇", "🥈", "🥉"][i] ?? `\`#${i + 1}\``;
}

function parseDuration(str) {
  if (!str) return null;
  const trimmed = String(str).trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed) * 60 * 1000;
  const re = /(\d+)\s*([hms])/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(trimmed))) {
    matched = true;
    const n = parseInt(m[1]);
    if (m[2] === "h") total += n * 60 * 60 * 1000;
    if (m[2] === "m") total += n * 60 * 1000;
    if (m[2] === "s") total += n * 1000;
  }
  return matched ? total : null;
}

function streakBonus(streak) {
  return Math.min(Math.floor(streak / DAILY_STREAK_BONUS_EVERY) * DAILY_STREAK_BONUS, DAILY_STREAK_MAX_BONUS);
}

function avatarUrl(user) {
  return user.displayAvatarURL({ size: 64, extension: "png" });
}

function embed(color) {
  return new EmbedBuilder().setColor(color).setFooter({ text: EVD_FOOTER }).setTimestamp();
}

function errorEmbed(title, description) {
  return embed(ERROR_COLOR).setTitle(`✗  ${title}`).setDescription(description);
}

function successEmbed(title, description) {
  return embed(SUCCESS_COLOR).setTitle(`${title}`).setDescription(description);
}

async function setGamesEnabled(enabled) {
  await pool.query(
    `INSERT INTO bot_settings (key, value) VALUES ('games_enabled', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
    [String(enabled)]
  );
  gamesEnabled = enabled;
}

function gamesDisabledEmbed() {
  return embed(WARN_COLOR)
    .setTitle("⚠️  Games Disabled")
    .setDescription("Game commands are currently disabled by administrators.");
}

// =================== DAILY QUESTS ===================

const QUEST_POOL = [
  // Easy (reward 100–150 coins)
  { key: 'hunt_3',      type: 'hunt',      desc: 'Hunt 3 times',                  target: 3,    difficulty: 'Easy',   reward: { type: 'coins',   amount: 150 } },
  { key: 'cf_play_3',   type: 'cf_play',   desc: 'Play coinflip 3 times',          target: 3,    difficulty: 'Easy',   reward: { type: 'coins',   amount: 150 } },
  { key: 'earn_500',    type: 'earn',      desc: 'Earn 500 coins',                 target: 500,  difficulty: 'Easy',   reward: { type: 'coins',   amount: 100 } },
  { key: 'crate_1',     type: 'crate',     desc: 'Open 1 Wild Crate',              target: 1,    difficulty: 'Easy',   reward: { type: 'coins',   amount: 100 } },
  { key: 'cf_win_1',    type: 'cf_win',    desc: 'Win 1 coinflip',                 target: 1,    difficulty: 'Easy',   reward: { type: 'coins',   amount: 100 } },
  { key: 'duel_play_1', type: 'duel_play', desc: 'Participate in 1 duel',          target: 1,    difficulty: 'Easy',   reward: { type: 'coins',   amount: 100 } },
  { key: 'pet_1',       type: 'pet',       desc: 'Obtain any pet',                 target: 1,    difficulty: 'Easy',   reward: { type: 'coins',   amount: 100 } },
  { key: 'shop_1',      type: 'shop',      desc: 'Purchase an item from the shop', target: 1,    difficulty: 'Easy',   reward: { type: 'coins',   amount: 150 } },
  { key: 'daily_1',     type: 'daily',     desc: 'Claim your daily reward',        target: 1,    difficulty: 'Easy',   reward: { type: 'coins',   amount: 100 } },
  { key: 'msg_25',      type: 'message',   desc: 'Send 25 messages',               target: 25,   difficulty: 'Easy',   reward: { type: 'coins',   amount: 100 } },
  // Medium (reward 150–300 coins or special item)
  { key: 'hunt_5',      type: 'hunt',      desc: 'Hunt 5 times',                   target: 5,    difficulty: 'Medium', reward: { type: 'coins',   amount: 250 } },
  { key: 'earn_1000',   type: 'earn',      desc: 'Earn 1,000 coins',               target: 1000, difficulty: 'Medium', reward: { type: 'coins',   amount: 200 } },
  { key: 'crate_2',     type: 'crate',     desc: 'Open 2 Wild Crates',             target: 2,    difficulty: 'Medium', reward: { type: 'coins',   amount: 200 } },
  { key: 'adv_2',       type: 'adventure', desc: 'Complete 2 adventures',          target: 2,    difficulty: 'Medium', reward: { type: 'coins',   amount: 250 } },
  { key: 'cf_win_3',    type: 'cf_win',    desc: 'Win 3 coinflips',                target: 3,    difficulty: 'Medium', reward: { type: 'cfguard', amount: 1 } },
  { key: 'duel_win_1',  type: 'duel_win',  desc: 'Win 1 duel',                     target: 1,    difficulty: 'Medium', reward: { type: 'coins',   amount: 300 } },
  { key: 'msg_50',      type: 'message',   desc: 'Send 50 messages',               target: 50,   difficulty: 'Medium', reward: { type: 'coins',   amount: 200 } },
  // Hard (reward 300–500 coins or rare item)
  { key: 'hunt_10',     type: 'hunt',      desc: 'Hunt 10 times',                  target: 10,   difficulty: 'Hard',   reward: { type: 'crate',   amount: 1 } },
  { key: 'earn_5000',   type: 'earn',      desc: 'Earn 5,000 coins',               target: 5000, difficulty: 'Hard',   reward: { type: 'coins',   amount: 500 } },
  { key: 'crate_5',     type: 'crate',     desc: 'Open 5 Wild Crates',             target: 5,    difficulty: 'Hard',   reward: { type: 'luck',    amount: 1 } },
  { key: 'adv_5',       type: 'adventure', desc: 'Complete 5 adventures',          target: 5,    difficulty: 'Hard',   reward: { type: 'luck',    amount: 1 } },
  { key: 'rare_pet_1',  type: 'rare_pet',  desc: 'Obtain a Rare+ pet',             target: 1,    difficulty: 'Hard',   reward: { type: 'crate',   amount: 1 } },
];

const QUEST_BONUS_REWARD = { type: 'crate', amount: 1 };
const DIFF_EMOJI = { Easy: '🟢', Medium: '🟡', Hard: '🔴' };

function rewardLabel(reward) {
  if (reward.type === 'coins')   return `**${reward.amount.toLocaleString()} ${currencyEmoji}**`;
  if (reward.type === 'crate')   return `**${reward.amount}x 🎁 Wild Crate**`;
  if (reward.type === 'luck')    return `**🍀 Luck Boost**`;
  if (reward.type === 'cfguard') return `**🔒 Coinflip Guard**`;
  return `**${reward.amount}**`;
}

async function getOrGenerateQuests(userId, username) {
  const { rows } = await pool.query(
    'SELECT * FROM daily_quests WHERE discord_id=$1 ORDER BY quest_slot ASC',
    [userId]
  );
  if (rows.length === 3) {
    const age = Date.now() - new Date(rows[0].generated_at).getTime();
    if (age < 24 * 60 * 60 * 1000) return rows;
  }
  return generateDailyQuests(userId, username);
}

async function generateDailyQuests(userId, username) {
  await getOrCreateUser(userId, username);
  const easy     = QUEST_POOL.filter(q => q.difficulty === 'Easy');
  const medium   = QUEST_POOL.filter(q => q.difficulty === 'Medium');
  const hard     = QUEST_POOL.filter(q => q.difficulty === 'Hard');
  const pick     = arr => arr[Math.floor(Math.random() * arr.length)];
  const chosen   = [pick(easy), pick(medium), pick(hard)];
  await pool.query('DELETE FROM daily_quests WHERE discord_id=$1', [userId]);
  for (let i = 0; i < chosen.length; i++) {
    await pool.query(
      `INSERT INTO daily_quests (discord_id, quest_slot, quest_key, progress, completed, claimed, generated_at)
       VALUES ($1, $2, $3, 0, false, false, NOW())`,
      [userId, i, chosen[i].key]
    );
  }
  const { rows } = await pool.query('SELECT * FROM daily_quests WHERE discord_id=$1 ORDER BY quest_slot ASC', [userId]);
  return rows;
}

async function updateQuestProgress(userId, username, eventType, amount = 1) {
  try {
    const rows = await getOrGenerateQuests(userId, username);
    for (const row of rows) {
      if (row.completed) continue;
      const def = QUEST_POOL.find(q => q.key === row.quest_key);
      if (!def || def.type !== eventType) continue;
      const newProgress = Math.min(Number(row.progress) + amount, def.target);
      const nowComplete = newProgress >= def.target;
      await pool.query(
        'UPDATE daily_quests SET progress=$1, completed=$2 WHERE discord_id=$3 AND quest_slot=$4',
        [newProgress, nowComplete, userId, row.quest_slot]
      );
    }
  } catch (err) {
    console.error('Quest progress update error:', err);
  }
}

async function handleQuests(message) {
  const userId   = message.author.id;
  const username = message.author.username;
  const user     = await getOrCreateUser(userId, username);
  const rows     = await getOrGenerateQuests(userId, username);

  const bonusClaimed = user.quest_bonus_claimed_at &&
    Date.now() - new Date(user.quest_bonus_claimed_at).getTime() < 24 * 60 * 60 * 1000;

  const resets   = new Date(new Date(rows[0].generated_at).getTime() + 24 * 60 * 60 * 1000);
  const resetsIn = Math.max(0, resets.getTime() - Date.now());

  const questLines = rows.map(row => {
    const def = QUEST_POOL.find(q => q.key === row.quest_key);
    if (!def) return '';
    const statusEmoji = row.claimed ? '✅' : row.completed ? '🎁' : DIFF_EMOJI[def.difficulty];
    const prog = `${Math.min(Number(row.progress), def.target)}/${def.target}`;
    const note = row.claimed ? ' *(claimed)*' : row.completed ? ' — `!claimquest`' : '';
    return `${statusEmoji} **${def.desc}**\nProgress: \`${prog}\` · Reward: ${rewardLabel(def.reward)}${note}`;
  });

  const completedCount = rows.filter(r => r.completed).length;
  const claimedCount   = rows.filter(r => r.claimed).length;
  const allClaimed     = rows.every(r => r.claimed);

  let bonusLine = '';
  if (allClaimed && !bonusClaimed)     bonusLine = '\n\n🏆 **All quests claimed!** Use `!claimquest` for your **Daily Master** bonus!';
  else if (bonusClaimed)               bonusLine = '\n\n✅ **Daily Master bonus claimed!** See you tomorrow!';
  else if (completedCount === 3)       bonusLine = '\n\n🏆 All quests complete! Claim with `!claimquest`.';

  await message.reply({
    embeds: [
      embed(GOLD_COLOR)
        .setTitle('📜 DAILY QUESTS')
        .setDescription(questLines.join('\n\n') + bonusLine)
        .addFields(
          { name: 'Progress',            value: `**${completedCount}/3** complete · **${claimedCount}/3** claimed`, inline: true },
          { name: 'Resets In',           value: formatTime(resetsIn), inline: true },
          { name: 'Total Quests Done',   value: `**${(user.quests_completed_total || 0).toLocaleString()}**`, inline: true }
        )
        .setFooter({ text: 'Quests reset every 24 hours • Everdale Premium Economy System' }),
    ],
  });
}

async function handleClaimQuest(message) {
  const userId   = message.author.id;
  const username = message.author.username;
  if (!acquireLock(userId)) {
    await message.reply({ embeds: [errorEmbed('Please Wait', 'You have a command in progress.')] });
    return;
  }
  try {
    const user = await getOrCreateUser(userId, username);
    const rows = await getOrGenerateQuests(userId, username);

    const claimable   = rows.filter(r => r.completed && !r.claimed);
    const allClaimed  = rows.every(r => r.claimed);
    const bonusClaimed = user.quest_bonus_claimed_at &&
      Date.now() - new Date(user.quest_bonus_claimed_at).getTime() < 24 * 60 * 60 * 1000;

    // Bonus claim when all 3 are claimed
    if (claimable.length === 0 && allClaimed && !bonusClaimed) {
      await pool.query(
        'UPDATE discord_users SET crates = crates + $1, quest_bonus_claimed_at = NOW() WHERE discord_id=$2',
        [QUEST_BONUS_REWARD.amount, userId]
      );
      logAction(userId, username, 'Quest Bonus', `Daily Master bonus: +${QUEST_BONUS_REWARD.amount} crate`);
      await message.reply({
        embeds: [
          embed(GOLD_COLOR)
            .setTitle('🏆 DAILY MASTER')
            .setDescription(
              `You completed **all 3 daily quests!**\n\n` +
              `**Bonus Reward:** ${rewardLabel(QUEST_BONUS_REWARD)} added to your inventory!\n\n` +
              `*Open your crate with \`!crate\`*`
            )
            .setFooter({ text: 'Come back tomorrow for new quests • Everdale Premium Economy System' }),
        ],
      });
      return;
    }

    if (claimable.length === 0) {
      const hasIncomplete = rows.some(r => !r.completed);
      const msg = hasIncomplete
        ? 'You have no completed quests to claim yet.\nCheck your progress with `!quests`.'
        : bonusClaimed
          ? 'All rewards including the Daily Master bonus have been claimed!\nNew quests arrive in less than 24 hours.'
          : 'Nothing to claim right now. Check `!quests` for details.';
      await message.reply({ embeds: [errorEmbed('Nothing to Claim', msg)] });
      return;
    }

    let totalCoins = 0, totalCrates = 0, luckGranted = false, cfGuardGranted = false;
    const rewardLines = [];

    for (const row of claimable) {
      const def = QUEST_POOL.find(q => q.key === row.quest_key);
      if (!def) continue;
      await pool.query('UPDATE daily_quests SET claimed=true WHERE discord_id=$1 AND quest_slot=$2', [userId, row.quest_slot]);
      if (def.reward.type === 'coins')   totalCoins    += def.reward.amount;
      if (def.reward.type === 'crate')   totalCrates   += def.reward.amount;
      if (def.reward.type === 'luck')    luckGranted    = true;
      if (def.reward.type === 'cfguard') cfGuardGranted = true;
      rewardLines.push(`✅ **${def.desc}** → ${rewardLabel(def.reward)}`);
    }

    if (totalCoins > 0)  await pool.query('UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id=$2', [totalCoins, userId]);
    if (totalCrates > 0) await pool.query('UPDATE discord_users SET crates = crates + $1 WHERE discord_id=$2', [totalCrates, userId]);
    if (luckGranted)     await pool.query("UPDATE discord_users SET luck_boost_until = GREATEST(COALESCE(luck_boost_until, NOW()), NOW()) + INTERVAL '1 hour' WHERE discord_id=$1", [userId]);
    if (cfGuardGranted)  await pool.query('UPDATE discord_users SET cf_guard = cf_guard + 1 WHERE discord_id=$1', [userId]);
    await pool.query('UPDATE discord_users SET quests_completed_total = quests_completed_total + $1 WHERE discord_id=$2', [claimable.length, userId]);

    logAction(userId, username, 'Quest Claim', `Claimed ${claimable.length} quest(s): ${totalCoins} coins, ${totalCrates} crates`);

    const summaryParts = [rewardLines.join('\n')];
    if (totalCoins > 0)    summaryParts.push(`\n💰 **+${totalCoins.toLocaleString()} ${currencyEmoji}** added to your balance!`);
    if (totalCrates > 0)   summaryParts.push(`🎁 **+${totalCrates} Wild Crate${totalCrates !== 1 ? 's' : ''}** added! Open with \`!crate\``);
    if (luckGranted)       summaryParts.push(`🍀 **Luck Boost** activated for 1 hour!`);
    if (cfGuardGranted)    summaryParts.push(`🔒 **Coinflip Guard** added!`);

    const freshRows = await pool.query('SELECT * FROM daily_quests WHERE discord_id=$1', [userId]);
    const nowAllClaimed = freshRows.rows.every(r => r.claimed);
    if (nowAllClaimed && !bonusClaimed) {
      summaryParts.push('\n🏆 All quests claimed! Use `!claimquest` again for your **Daily Master** bonus!');
    }

    await message.reply({
      embeds: [
        embed(SUCCESS_COLOR)
          .setTitle('🎁 QUEST REWARDS CLAIMED')
          .setDescription(summaryParts.join('\n'))
          .setFooter({ text: 'Everdale Premium Economy System' }),
      ],
    });
  } finally {
    releaseLock(userId);
  }
}

async function handleRerollQuest(message) {
  const userId   = message.author.id;
  const username = message.author.username;
  if (!acquireLock(userId)) {
    await message.reply({ embeds: [errorEmbed('Please Wait', 'You have a command in progress.')] });
    return;
  }
  try {
    const user = await getOrCreateUser(userId, username);
    const today = new Date().toDateString();
    const lastReroll = user.quest_reroll_used_at ? new Date(user.quest_reroll_used_at).toDateString() : null;

    if (lastReroll === today) {
      await message.reply({ embeds: [errorEmbed('Reroll Used', 'You have already used your free reroll today.\nYou get **1 free reroll** per day.')] });
      return;
    }

    const rows = await getOrGenerateQuests(userId, username);
    const unclaimed = rows.filter(r => !r.claimed);
    if (unclaimed.length === 0) {
      await message.reply({ embeds: [errorEmbed('Nothing to Reroll', 'All quests are already claimed.')] });
      return;
    }

    const incomplete  = unclaimed.filter(r => !r.completed);
    const target      = incomplete.length > 0 ? incomplete[0] : unclaimed[0];
    const currentDiff = QUEST_POOL.find(q => q.key === target.quest_key)?.difficulty ?? 'Easy';
    const candidates  = QUEST_POOL.filter(q => q.difficulty === currentDiff && q.key !== target.quest_key);
    const newQuest    = candidates[Math.floor(Math.random() * candidates.length)] ?? QUEST_POOL[0];

    await pool.query(
      'UPDATE daily_quests SET quest_key=$1, progress=0, completed=false, claimed=false WHERE discord_id=$2 AND quest_slot=$3',
      [newQuest.key, userId, target.quest_slot]
    );
    await pool.query('UPDATE discord_users SET quest_reroll_used_at=NOW() WHERE discord_id=$1', [userId]);

    await message.reply({
      embeds: [
        embed(BRAND_COLOR)
          .setTitle('🔄 Quest Rerolled')
          .setDescription(
            `Your **${currentDiff}** quest has been replaced!\n\n` +
            `${DIFF_EMOJI[currentDiff]} **New Quest:** ${newQuest.desc}\n` +
            `Reward: ${rewardLabel(newQuest.reward)}\n\n` +
            `*You get 1 free reroll per day.*`
          )
          .setFooter({ text: 'Everdale Premium Economy System' }),
      ],
    });
  } finally {
    releaseLock(userId);
  }
}

// =================== COMMANDS ===================

async function handleEarn(message) {
  if (!acquireLock(message.author.id)) {
    await message.reply({ embeds: [errorEmbed("Please Wait", "You have a command in progress. Try again in a moment.")] });
    return;
  }
  try {
  const user = await getOrCreateUser(message.author.id, message.author.username);
  const { inWindow, earnCount } = checkEarnWindow(user);
  const currentEarnCount = inWindow ? earnCount : 0;

  if (inWindow && currentEarnCount >= EARN_MAX_PER_WINDOW) {
    const windowMs = EARN_WINDOW_HOURS * 60 * 60 * 1000;
    const remaining = windowMs - (Date.now() - new Date(user.earn_window_start).getTime());
    await message.reply({
      embeds: [
        embed(WARN_COLOR)
          .setTitle("⏳ Earn Limit Reached")
          .setDescription(
            `You've already earned **${EARN_MAX_PER_WINDOW}x** this window.\n\n` +
            `Next earn available in **${formatTime(remaining)}**`
          )
          .setFooter({ text: `${EARN_MAX_PER_WINDOW} earns per ${EARN_WINDOW_HOURS} hours` }),
      ],
    });
    return;
  }

  if (user.message_count < EARN_REQUIRED_MESSAGES) {
    const needed = EARN_REQUIRED_MESSAGES - user.message_count;
    const { bar, percent } = progressBar(user.message_count, EARN_REQUIRED_MESSAGES);
    await message.reply({
      embeds: [
        embed(WARN_COLOR)
          .setTitle("📊 Not Enough Messages")
          .setDescription(
            `You need **${needed} more messages** to earn.\n\n` +
            `\`${bar}\` **${percent}%**\n` +
            `\`${user.message_count} / ${EARN_REQUIRED_MESSAGES} messages\``
          )
          .setFooter({ text: "Keep chatting to unlock your next earn!" }),
      ],
    });
    return;
  }

  const now = new Date();
  const isFirstEarn = currentEarnCount === 0;
  const newMessageCount = isFirstEarn ? user.message_count - EARN_REQUIRED_MESSAGES : 0;
  const newEarnCount = currentEarnCount + 1;
  const newBalance = user.balance + EARN_AMOUNT;
  const newTotalEarned = (user.total_earned || 0) + EARN_AMOUNT;
  const newWindowStart = !inWindow || currentEarnCount === 0 ? now : new Date(user.earn_window_start);

  await pool.query(
    `UPDATE discord_users SET balance=$1, message_count=$2, earn_count=$3, earn_window_start=$4, total_earned=$5 WHERE discord_id=$6`,
    [newBalance, newMessageCount, newEarnCount, newWindowStart, newTotalEarned, message.author.id]
  );

  logAction(message.author.id, message.author.username, "Earn", `+${EARN_AMOUNT} coins → Balance: ${newBalance}`);
  updateQuestProgress(message.author.id, message.author.username, 'earn', EARN_AMOUNT).catch(() => {});

  const { bar } = progressBar(newMessageCount, EARN_REQUIRED_MESSAGES);
  const earnsLeft = EARN_MAX_PER_WINDOW - newEarnCount;
  const windowMs = EARN_WINDOW_HOURS * 60 * 60 * 1000;
  const resetsIn = windowMs - (Date.now() - newWindowStart.getTime());
  const claimsLine = earnsLeft > 0
    ? `**${earnsLeft}x** claim left • resets in ${formatTime(resetsIn)}`
    : `Limit reached • resets in ${formatTime(resetsIn)}`;

  await message.reply({
    embeds: [
      embed(SUCCESS_COLOR)
        .setTitle("EARN REWARD")
        .addFields(
          { name: "Earned", value: `+**${EARN_AMOUNT} ${currencyEmoji}**`, inline: true },
          { name: "Balance", value: `**${newBalance.toLocaleString()} ${currencyEmoji}**`, inline: true },
          { name: "Claims", value: earnsLeft > 0 ? `**${earnsLeft}x** this window` : `Limit · ${formatTime(resetsIn)}`, inline: true },
          { name: "Progress", value: `\`${bar}\`  \`${newMessageCount} / ${EARN_REQUIRED_MESSAGES}\`` }
        ),
    ],
  });
  } finally { releaseLock(message.author.id); }
}

async function handleDaily(message) {
  if (!acquireLock(message.author.id)) {
    await message.reply({ embeds: [errorEmbed("Please Wait", "You have a command in progress. Try again in a moment.")] });
    return;
  }
  try {
  const user = await getOrCreateUser(message.author.id, message.author.username);
  const cooldownMs = 24 * 60 * 60 * 1000;
  const streakWindowMs = 48 * 60 * 60 * 1000;

  if (user.last_daily) {
    const elapsed = Date.now() - new Date(user.last_daily).getTime();
    if (elapsed < cooldownMs) {
      await message.reply({
        embeds: [
          embed(WARN_COLOR)
            .setTitle("⏳ Already Claimed")
            .setDescription(`Come back in **${formatTime(cooldownMs - elapsed)}**`)
            .setFooter({ text: `Current streak: ${user.daily_streak} day${user.daily_streak !== 1 ? "s" : ""}` }),
        ],
      });
      return;
    }
  }

  let newStreak = 1;
  if (user.last_daily) {
    const elapsed = Date.now() - new Date(user.last_daily).getTime();
    newStreak = elapsed < streakWindowMs ? (user.daily_streak || 0) + 1 : 1;
  }

  const bonus = streakBonus(newStreak);
  const totalClaim = DAILY_BASE_AMOUNT + bonus;
  const newBalance = user.balance + totalClaim;
  const newTotalEarned = (user.total_earned || 0) + totalClaim;

  await pool.query(
    "UPDATE discord_users SET balance=$1, last_daily=$2, daily_streak=$3, total_earned=$4 WHERE discord_id=$5",
    [newBalance, new Date(), newStreak, newTotalEarned, message.author.id]
  );

  logAction(message.author.id, message.author.username, "Daily Claim", `+${totalClaim} coins (streak ${newStreak}) → Balance: ${newBalance}`);
  updateQuestProgress(message.author.id, message.author.username, 'daily').catch(() => {});

  const nextMilestone = (Math.floor(newStreak / DAILY_STREAK_BONUS_EVERY) + 1) * DAILY_STREAK_BONUS_EVERY;
  const streakLine = bonus > 0
    ? `🔥 Streak bonus: **+${bonus} ${currencyEmoji}** (${newStreak} day streak!)`
    : `🔥 Streak: **${newStreak} day${newStreak !== 1 ? "s" : ""}** — next bonus at **${nextMilestone} days**`;

  const streakDesc = bonus > 0
    ? `🔥 **${newStreak}-day streak** — +${bonus} ${currencyEmoji} bonus`
    : `🔥 **${newStreak}-day streak** — next bonus at **${nextMilestone} days**`;

  await message.reply({
    embeds: [
      embed(SUCCESS_COLOR)
        .setTitle("DAILY REWARD")
        .setDescription(streakDesc)
        .addFields(
          { name: "Reward", value: `+**${totalClaim} ${currencyEmoji}**`, inline: true },
          { name: "Balance", value: `**${newBalance.toLocaleString()} ${currencyEmoji}**`, inline: true },
          { name: "Streak", value: `**${newStreak}** day${newStreak !== 1 ? "s" : ""}`, inline: true }
        ),
    ],
  });
  } finally { releaseLock(message.author.id); }
}

async function handleProfile(message, args) {
  let target = message.mentions.users.first() ?? message.author;
  const user = await getOrCreateUser(target.id, target.username);
  const rank = await getUserRank(target.id);
  const { inWindow, earnCount } = checkEarnWindow(user);
  const currentEarnCount = inWindow ? earnCount : 0;
  const { bar, percent } = progressBar(Math.min(user.message_count, EARN_REQUIRED_MESSAGES), EARN_REQUIRED_MESSAGES);
  const bonus = streakBonus(user.daily_streak || 0);

  const { rows: invRows } = await pool.query(
    "SELECT COUNT(*) AS unique_pets FROM animal_inventory WHERE discord_id=$1 AND quantity > 0",
    [target.id]
  );
  const uniquePets = parseInt(invRows[0]?.unique_pets || 0);
  const totalPetTypes = Object.keys(ANIMALS).length;
  const collPct = Math.floor((uniquePets / totalPetTypes) * 100);

  const dailyStatus = user.last_daily
    ? (() => {
        const elapsed = Date.now() - new Date(user.last_daily).getTime();
        return elapsed < 24 * 60 * 60 * 1000
          ? `⏳ ${formatTime(24 * 60 * 60 * 1000 - elapsed)}`
          : "✅ Ready";
      })()
    : "✅ Ready";

  const earnsReady = user.message_count >= EARN_REQUIRED_MESSAGES && currentEarnCount < EARN_MAX_PER_WINDOW;

  await message.reply({
    embeds: [
      embed(BRAND_COLOR)
        .setAuthor({ name: target.username, iconURL: avatarUrl(target) })
        .setTitle("EVERDALE PROFILE")
        .setThumbnail(avatarUrl(target))
        .addFields(
          { name: "Balance", value: `**${user.balance.toLocaleString()} ${currencyEmoji}**`, inline: true },
          { name: "Rank", value: `**#${rank}**`, inline: true },
          { name: "Total Earned", value: `**${(user.total_earned || 0).toLocaleString()} ${currencyEmoji}**`, inline: true },
          { name: "Daily Streak", value: `**${user.daily_streak || 0}** day${(user.daily_streak || 0) !== 1 ? "s" : ""}${bonus > 0 ? ` *(+${bonus} bonus)*` : ""}`, inline: true },
          { name: "Daily", value: dailyStatus, inline: true },
          { name: "Crates", value: `**${user.crates || 0}** 🎁`, inline: true },
          { name: "Message Progress", value: `\`${bar}\` ${percent}%\n${earnsReady ? "✅ Ready to \`!earn\`" : currentEarnCount >= EARN_MAX_PER_WINDOW && inWindow ? "⏳ Earn limit reached" : `${Math.max(0, EARN_REQUIRED_MESSAGES - user.message_count)} msgs needed`}` },
          { name: "Pet Collection", value: `**${uniquePets}/${totalPetTypes}** unique *(${collPct}%)*`, inline: true },
          { name: "Member Since", value: `${new Date(user.joined_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, inline: true }
        ),
    ],
  });
}

async function handleCoinFlip(message, args) {
  if (!gamesEnabled) { await message.reply({ embeds: [gamesDisabledEmbed()] }); return; }
  const user = await getOrCreateUser(message.author.id, message.author.username);
  const { amount, error } = parseAmount(args[0], user.balance, MAX_BET);
  if (error) {
    await message.reply({ embeds: [errorEmbed("Invalid Amount", `${error}\nUsage: \`!cf <amount>\``)] });
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cf_heads_${message.author.id}_${amount}`).setLabel("Heads").setEmoji("🪙").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`cf_tails_${message.author.id}_${amount}`).setLabel("Tails").setEmoji("🪙").setStyle(ButtonStyle.Primary)
  );

  const reply = await message.reply({
    embeds: [
      embed(GOLD_COLOR)
        .setTitle("🪙 COIN FLIP")
        .setDescription(`**${amount.toLocaleString()} ${currencyEmoji}** on the line.\nPick a side — **30 seconds** to choose.`),
    ],
    components: [row],
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === message.author.id,
    time: 30000,
    max: 1,
  });

  collector.on("collect", async (interaction) => { try {
    const userChoice = interaction.customId.includes("_heads_") ? "Heads" : "Tails";
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("d_h").setLabel("Heads").setEmoji("🪙").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId("d_t").setLabel("Tails").setEmoji("🪙").setStyle(ButtonStyle.Primary).setDisabled(true)
    );

    await interaction.update({
      embeds: [
        embed(GOLD_COLOR).setTitle("🪙 Flipping...").setDescription(`You chose **${userChoice}**.\n\n*The coin is in the air...*`),
      ],
      components: [disabledRow],
    });

    await new Promise((r) => setTimeout(r, 3000));

    const fresh = await getOrCreateUser(message.author.id, message.author.username);
    if (fresh.balance < amount) {
      await reply.edit({ embeds: [errorEmbed("Insufficient Balance", "Your balance changed — bet cancelled.")], components: [] });
      return;
    }

    const luckyWin = hasSoriRole(message.member);
    const coinResult = luckyWin
      ? userChoice
      : (Math.random() < 0.40 ? userChoice : (userChoice === "Heads" ? "Tails" : "Heads"));
    const won = coinResult === userChoice;
    let newBalance;
    let cfGuardUsed = false;
    if (won) {
      const { rows: wr } = await pool.query(
        "UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id=$2 RETURNING balance",
        [amount, message.author.id]
      );
      newBalance = wr[0].balance;
    } else {
      if ((fresh.cf_guard || 0) > 0) {
        cfGuardUsed = true;
        const refund = Math.floor(amount / 2);
        const loss = amount - refund;
        const { rows: lr } = await pool.query(
          "UPDATE discord_users SET balance = GREATEST(0, balance - $1), cf_guard = cf_guard - 1 WHERE discord_id=$2 RETURNING balance",
          [loss, message.author.id]
        );
        newBalance = lr[0].balance;
      } else {
        const { rows: lr } = await pool.query(
          "UPDATE discord_users SET balance = GREATEST(0, balance - $1) WHERE discord_id=$2 RETURNING balance",
          [amount, message.author.id]
        );
        newBalance = lr[0].balance;
      }
    }
    logAction(message.author.id, message.author.username, "Coin Flip", `${won ? "Won" : "Lost"} ${amount} coins (chose ${userChoice}) → Balance: ${newBalance}`);
    updateQuestProgress(message.author.id, message.author.username, 'cf_play').catch(() => {});
    if (won) updateQuestProgress(message.author.id, message.author.username, 'cf_win').catch(() => {});

    const cfChange = won ? `+${amount.toLocaleString()}` : cfGuardUsed ? `-${Math.floor(amount/2).toLocaleString()}` : `-${amount.toLocaleString()}`;
    const cfTitle = won ? "🎉 YOU WON" : cfGuardUsed ? "🔒 GUARD ACTIVATED" : "💸 YOU LOST";
    const cfDesc = cfGuardUsed
      ? `Coin landed **${coinResult}**. Guard refunded 50% of your loss.`
      : `Coin landed **${coinResult}**.`;
    await reply.edit({
      embeds: [
        embed(won ? SUCCESS_COLOR : ERROR_COLOR)
          .setTitle(cfTitle)
          .setDescription(cfDesc)
          .addFields(
            { name: "Chose", value: `**${userChoice}**`, inline: true },
            { name: "Change", value: `**${cfChange} ${currencyEmoji}**`, inline: true },
            { name: "Balance", value: `**${newBalance.toLocaleString()} ${currencyEmoji}**`, inline: true }
          ),
      ],
      components: [],
    });
  } catch (err) { console.error("Coinflip collector error:", err); }
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      await reply.edit({
        embeds: [embed(0x888888).setTitle("🪙 Coin Flip Expired").setDescription("You took too long! Bet cancelled.")],
        components: [],
      }).catch(() => {});
    }
  });
}

async function handleDuel(message, args) {
  if (!gamesEnabled) { await message.reply({ embeds: [gamesDisabledEmbed()] }); return; }
  const targetUser = message.mentions.users.first();

  if (!targetUser) {
    await message.reply({ embeds: [errorEmbed("Invalid Usage", "Usage: `!duel @user <amount>`")] });
    return;
  }
  if (targetUser.bot) { await message.reply({ embeds: [errorEmbed("Invalid Target", "You cannot duel a bot!")] }); return; }
  if (targetUser.id === message.author.id) { await message.reply({ embeds: [errorEmbed("Invalid Target", "You cannot duel yourself!")] }); return; }
  if (pendingDuels.has(targetUser.id)) { await message.reply({ embeds: [errorEmbed("Already in Duel", "That user already has a pending duel.")] }); return; }

  const [challenger, target] = await Promise.all([
    getOrCreateUser(message.author.id, message.author.username),
    getOrCreateUser(targetUser.id, targetUser.username),
  ]);

  const { amount, error } = parseAmount(args[1], challenger.balance, MAX_BET);
  if (error) {
    await message.reply({ embeds: [errorEmbed("Invalid Amount", `${error}\nUsage: \`!duel @user <amount>\``)] });
    return;
  }
  if (target.balance < amount) { await message.reply({ embeds: [errorEmbed("Target Cannot Afford", `**${targetUser.username}** only has **${target.balance} ${currencyEmoji}**.`)] }); return; }

  pendingDuels.set(targetUser.id, { challengerId: message.author.id, challengerName: message.author.username, amount });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duel_accept_${targetUser.id}`).setLabel("Accept").setEmoji("⚔️").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`duel_decline_${targetUser.id}`).setLabel("Decline").setEmoji("❌").setStyle(ButtonStyle.Danger)
  );

  const reply = await message.reply({
    embeds: [
      embed(WARN_COLOR)
        .setTitle("⚔️ DUEL CHALLENGE")
        .setDescription(`${targetUser} — you have **60 seconds** to respond.`)
        .addFields(
          { name: `⚔️ ${message.author.username}`, value: `${challenger.balance.toLocaleString()} ${currencyEmoji}`, inline: true },
          { name: "VS", value: "⚡", inline: true },
          { name: `⚔️ ${targetUser.username}`, value: `${target.balance.toLocaleString()} ${currencyEmoji}`, inline: true },
          { name: "Stakes", value: `**${amount.toLocaleString()} ${currencyEmoji}**` }
        ),
    ],
    components: [row],
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === targetUser.id,
    time: 60000,
    max: 1,
  });

  collector.on("collect", async (interaction) => { try {
    pendingDuels.delete(targetUser.id);

    if (interaction.customId === `duel_decline_${targetUser.id}`) {
      await interaction.update({
        embeds: [embed(SECONDARY_COLOR).setTitle("⚔️ Duel Declined").setDescription(`**${targetUser.username}** declined the challenge.`)],
        components: [],
      });
      return;
    }

    await interaction.update({
      embeds: [embed(WARN_COLOR).setTitle("⚔️ Duel in Progress...").setDescription("*The battle has begun — may the best fighter win!*")],
      components: [],
    });

    const [freshC, freshT] = await Promise.all([
      getOrCreateUser(message.author.id, message.author.username),
      getOrCreateUser(targetUser.id, targetUser.username),
    ]);

    if (freshC.balance < amount || freshT.balance < amount) {
      await reply.edit({ embeds: [errorEmbed("Duel Failed", `A player no longer has enough ${currencyEmoji}.`)], components: [] });
      return;
    }

    const challengerLucky = hasSoriRole(message.member);
    const targetLucky = hasSoriRole(await message.guild.members.fetch(targetUser.id).catch(() => null));
    let challengerWins;
    if (challengerLucky && !targetLucky) challengerWins = true;
    else if (targetLucky && !challengerLucky) challengerWins = false;
    else challengerWins = Math.random() < 0.5;
    const winner = challengerWins
      ? { id: message.author.id, name: message.author.username, bal: freshC.balance }
      : { id: targetUser.id, name: targetUser.username, bal: freshT.balance };
    const loser = challengerWins
      ? { id: targetUser.id, name: targetUser.username, bal: freshT.balance }
      : { id: message.author.id, name: message.author.username, bal: freshC.balance };

    await Promise.all([
      pool.query("UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id=$2", [amount, winner.id]),
      pool.query("UPDATE discord_users SET balance = GREATEST(0, balance - $1) WHERE discord_id=$2", [amount, loser.id]),
    ]);
    const winnerNewBal = winner.bal + amount;
    const loserNewBal = Math.max(0, loser.bal - amount);
    logAction(winner.id, winner.name, "Duel Win", `+${amount} coins vs ${loser.name} → Balance: ${winnerNewBal}`);
    logAction(loser.id, loser.name, "Duel Loss", `-${amount} coins vs ${winner.name} → Balance: ${loserNewBal}`);
    updateQuestProgress(winner.id, winner.name, 'duel_play').catch(() => {});
    updateQuestProgress(winner.id, winner.name, 'duel_win').catch(() => {});
    updateQuestProgress(loser.id, loser.name, 'duel_play').catch(() => {});

    await reply.edit({
      embeds: [
        embed(SUCCESS_COLOR)
          .setTitle("⚔️ DUEL RESULT")
          .setDescription(`🏆 **${winner.name}** wins!`)
          .addFields(
            { name: `🏆 ${winner.name}`, value: `+${amount.toLocaleString()} ${currencyEmoji} → **${winnerNewBal.toLocaleString()}**`, inline: true },
            { name: `💔 ${loser.name}`, value: `-${amount.toLocaleString()} ${currencyEmoji} → **${loserNewBal.toLocaleString()}**`, inline: true }
          ),
      ],
      components: [],
    });
  } catch (err) { console.error("Duel collector error:", err); }
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      pendingDuels.delete(targetUser.id);
      await reply.edit({
        embeds: [embed(SECONDARY_COLOR).setTitle("⚔️ Duel Expired").setDescription(`**${targetUser.username}** didn't respond. Challenge cancelled.`)],
        components: [],
      }).catch(() => {});
    }
  });
}

async function handleBalance(message, args) {
  const target = message.mentions.users.first() ?? message.author;
  const user = await getOrCreateUser(target.id, target.username);
  const rank = await getUserRank(target.id);
  const crateCount = user.crates || 0;

  await message.reply({
    embeds: [
      embed(GOLD_COLOR)
        .setAuthor({ name: target.username, iconURL: avatarUrl(target) })
        .setTitle("EVERDALE BALANCE")
        .setThumbnail(avatarUrl(target))
        .addFields(
          { name: "Balance", value: `**${user.balance.toLocaleString()} ${currencyEmoji}**`, inline: true },
          { name: "Rank", value: `**#${rank}**`, inline: true },
          { name: "Crates", value: `**${crateCount}** 🎁`, inline: true }
        ),
    ],
  });
}

async function handleMessages(message) {
  const user = await getOrCreateUser(message.author.id, message.author.username);
  const { inWindow, earnCount } = checkEarnWindow(user);
  const currentEarnCount = inWindow ? earnCount : 0;
  const { bar, percent } = progressBar(Math.min(user.message_count, EARN_REQUIRED_MESSAGES), EARN_REQUIRED_MESSAGES);
  const ready = user.message_count >= EARN_REQUIRED_MESSAGES;

  let statusText;
  if (ready && currentEarnCount < EARN_MAX_PER_WINDOW) {
    statusText = `✅ **Ready to \`!earn\`!**  (${currentEarnCount}/${EARN_MAX_PER_WINDOW} earns used this window)`;
  } else if (ready && currentEarnCount >= EARN_MAX_PER_WINDOW && inWindow) {
    const windowMs = EARN_WINDOW_HOURS * 60 * 60 * 1000;
    const remaining = windowMs - (Date.now() - new Date(user.earn_window_start).getTime());
    statusText = `⏳ Earn limit reached — resets in **${formatTime(remaining)}**`;
  } else {
    statusText = `**${EARN_REQUIRED_MESSAGES - user.message_count} more messages** to unlock next earn`;
  }

  await message.reply({
    embeds: [
      embed(BRAND_COLOR)
        .setTitle("📊 Message Progress")
        .setDescription(`\`${bar}\` **${percent}%**\n\`${Math.min(user.message_count, EARN_REQUIRED_MESSAGES)} / ${EARN_REQUIRED_MESSAGES} messages\`\n\n${statusText}`),
    ],
  });
}

async function handleLeaderboard(message) {
  const PAGE_SIZE = 10;
  const { rows: countRows } = await pool.query("SELECT COUNT(*) AS count FROM discord_users");
  const totalUsers = parseInt(countRows[0].count);
  const totalPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));
  let page = 0;

  async function fetchPage(p) {
    const { rows } = await pool.query(
      "SELECT discord_id, username, balance FROM discord_users ORDER BY balance DESC LIMIT $1 OFFSET $2",
      [PAGE_SIZE, p * PAGE_SIZE]
    );
    return rows;
  }

  async function buildEmbed(rows, p) {
    const lines = rows.map((u, i) => {
      const globalIdx = p * PAGE_SIZE + i;
      const medal = ["🥇", "🥈", "🥉"][globalIdx] ?? `\`#${globalIdx + 1}\``;
      const you = u.discord_id === message.author.id ? "  **◀ you**" : "";
      return `${medal} **${u.username}** — ${u.balance.toLocaleString()} ${currencyEmoji}${you}`;
    });
    const callerOnPage = rows.some(u => u.discord_id === message.author.id);
    let yourRankLine = "";
    if (!callerOnPage) {
      const { rows: rr } = await pool.query(
        `SELECT COUNT(*) + 1 AS rank FROM discord_users WHERE balance > (SELECT COALESCE((SELECT balance FROM discord_users WHERE discord_id=$1),0))`,
        [message.author.id]
      );
      yourRankLine = `\n\nYour rank: **#${rr[0].rank}**`;
    }
    return embed(GOLD_COLOR)
      .setTitle("🏆 EVERDALE LEADERBOARD")
      .setDescription((lines.join("\n") || "No players yet.") + yourRankLine)
      .addFields({ name: "Page", value: `**${p + 1}** / ${totalPages}`, inline: true });
  }

  function buildRow(p) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lb_prev_${message.author.id}`).setLabel("← Previous").setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
      new ButtonBuilder().setCustomId(`lb_next_${message.author.id}`).setLabel("Next →").setStyle(ButtonStyle.Secondary).setDisabled(p >= totalPages - 1)
    );
  }

  const firstRows = await fetchPage(0);
  const reply = await message.reply({
    embeds: [await buildEmbed(firstRows, 0)],
    components: totalPages > 1 ? [buildRow(0)] : [],
  });

  if (totalPages <= 1) return;

  const collector = reply.createMessageComponentCollector({ time: 120_000 });
  collector.on("collect", async (i) => { try {
    if (!i.customId.endsWith(`_${message.author.id}`)) {
      await i.reply({ content: "This is not your leaderboard.", ephemeral: true }); return;
    }
    if (i.customId.startsWith("lb_prev_") && page > 0) page--;
    else if (i.customId.startsWith("lb_next_") && page < totalPages - 1) page++;
    const rows = await fetchPage(page);
    await i.update({ embeds: [await buildEmbed(rows, page)], components: [buildRow(page)] });
  } catch (err) { console.error("Leaderboard collector error:", err); }});

  collector.on("end", async () => { await reply.edit({ components: [] }).catch(() => {}); });
}

async function handleHelp(message) {
  const CATS = {
    economy: {
      label: "🏛️ Economy",
      lines: [
        "`!daily` — Claim your daily reward (streak bonuses)",
        `\`!earn\` — Earn **${EARN_AMOUNT}** coins after **${EARN_REQUIRED_MESSAGES}** messages`,
        "`!bal [@user]` — Check balance",
        "`!profile [@user]` — Full stats card",
        "`!msg` — Message progress tracker",
        "`!lb` — Paginated leaderboard",
      ],
    },
    games: {
      label: "⚔️ Games",
      lines: [
        "`!cf <amount>` — Coin flip",
        "`!duel @user <amount>` — Duel another player",
        `\`!adventure\` — Story adventure *(${ADVENTURE_COOLDOWN_HOURS}h cooldown)*`,
      ],
    },
    pets: {
      label: "🐾 Pets",
      lines: [
        `\`!hunt\` — Catch a random pet *(${HUNT_MAX_PER_WINDOW}x / ${HUNT_WINDOW_HOURS}h)*`,
        "`!pets [@user]` — Pet collection tracker",
        "`!inv` — Your inventory (grouped by rarity)",
        "`!sell <pet>` — Sell a pet",
        "`!sell all` — Sell all pets",
        `◇ Common 25 ${currencyEmoji}  ◆ Rare 50 ${currencyEmoji}  ✦ Epic 100 ${currencyEmoji}  ✧ Legendary 250 ${currencyEmoji}`,
      ],
    },
    shop: {
      label: "🛒 Shop",
      lines: [
        "`!shop` — Open the Everdale Market",
        `🎁 **Wild Crate** — 40 ${currencyEmoji} *(random pet)*`,
        `🎁 **Wild Crate ×5** — 180 ${currencyEmoji} *(10% off)*`,
        `🍀 **Luck Boost** — 100 ${currencyEmoji} *(1h better drops)*`,
        `🔒 **Coinflip Guard** — 100 ${currencyEmoji} *(50% loss refund)*`,
        "`!crate <1-100>` — Open crates",
      ],
    },
    admin: {
      label: "🛡️ Admin",
      lines: [
        "`!removepoints @user <n>` — Remove coins",
        "`!resetpoints @user` — Reset balance to 0",
        "`!addmsg / !removemsg @user <n>` — Manage messages",
        "`!game enable / disable` — Toggle game commands",
        "`!gamestatus` — Check game status",
        "`!ftr <prize> <winners> <time>` — First-to-react giveaway",
        "`!setemoji <emoji>` — Set currency emoji",
        "`!setlogchannel / !logs` — Configure logging",
        "`!resetall @user / !resetserver` — Full resets",
        "`!ahelp` — Full admin reference",
      ],
    },
  };

  function catEmbed(key) {
    const c = CATS[key];
    return embed(GOLD_COLOR)
      .setTitle(c.label)
      .setDescription(c.lines.join("\n"));
  }

  function catRow(active) {
    const btns = Object.entries(CATS).map(([k, c]) =>
      new ButtonBuilder()
        .setCustomId(`hlp_${k}_${message.author.id}`)
        .setLabel(c.label)
        .setStyle(k === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
    const rows = [];
    for (let i = 0; i < btns.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(...btns.slice(i, i + 5)));
    }
    return rows;
  }

  let current = "economy";
  const reply = await message.reply({ embeds: [catEmbed(current)], components: catRow(current) });

  const collector = reply.createMessageComponentCollector({ time: 120_000 });
  collector.on("collect", async (i) => { try {
    if (!i.customId.endsWith(`_${message.author.id}`)) {
      await i.reply({ content: "This menu isn't yours.", ephemeral: true }); return;
    }
    const m = i.customId.match(/^hlp_(\w+)_/);
    if (m) { current = m[1]; await i.update({ embeds: [catEmbed(current)], components: catRow(current) }); }
  } catch (err) { console.error("Help collector error:", err); }});
  collector.on("end", async () => { await reply.edit({ components: [] }).catch(() => {}); });
}

async function handleEHelp(message) { return handleHelp(message); }

async function handleAHelp(message) {
  await message.reply({
    embeds: [
      embed(ERROR_COLOR)
        .setTitle("🛡️ ADMIN COMMANDS")
        .setDescription("Requires **Administrator** or **Manage Server**.")
        .addFields(
          {
            name: "💰 Balance",
            value: [
              `\`!removepoints @user <n>\` — Remove ${currencyEmoji}`,
              "`!resetpoints @user` — Reset balance to 0",
            ].join("\n"),
          },
          {
            name: "📊 Messages",
            value: [
              "`!addmsg @user <n>` — Add messages",
              "`!removemsg @user <n>` — Remove messages",
            ].join("\n"),
          },
          {
            name: "🎮 Games",
            value: [
              "`!game enable` — Enable all game commands",
              "`!game disable` — Disable all game commands",
              "`!gamestatus` — Check current game status",
            ].join("\n"),
          },
          {
            name: "🎉 Giveaways",
            value: [
              "**`!ftr <prize> <winners> <time>`** — First-to-react giveaway",
              "*Time: `30s`, `5m`, `1h`, `2h30m` • max 24h*",
              "Auto-delivered prizes: `coins:500` · `crate` 🎁 · `luck` 🍀 · `cfguard` 🔒",
            ].join("\n"),
          },
          {
            name: "💱 Settings",
            value: [
              "`!setemoji <emoji>` — Set currency emoji",
              "`!setlogchannel [#ch]` — Set log channel",
              "`!logs [@user]` — View last 10 events",
            ].join("\n"),
          },
          {
            name: "🔄 Resets",
            value: [
              "`!resetall @user` — Reset one user fully",
              "`!resetserver` — ⚠️ Reset everyone",
            ].join("\n"),
          }
        ),
    ],
  });
}

// =================== ANIMAL SYSTEM ===================

async function handleHunt(message) {
  if (!gamesEnabled) { await message.reply({ embeds: [gamesDisabledEmbed()] }); return; }
  if (!acquireLock(message.author.id)) {
    await message.reply({ embeds: [errorEmbed("Please Wait", "You have a command in progress. Try again in a moment.")] });
    return;
  }
  try {
  const user = await getOrCreateUser(message.author.id, message.author.username);
  const { inWindow, huntCount } = checkHuntWindow(user);
  const currentHuntCount = inWindow ? huntCount : 0;

  if (inWindow && currentHuntCount >= HUNT_MAX_PER_WINDOW) {
    const remaining = HUNT_WINDOW_MS - (Date.now() - new Date(user.hunt_window_start).getTime());
    await message.reply({
      embeds: [
        embed(WARN_COLOR)
          .setTitle("⏳ Hunt Limit Reached")
          .setDescription(
            `You've used **${HUNT_MAX_PER_WINDOW}/${HUNT_MAX_PER_WINDOW}** hunts this window.\n\n` +
            `Next hunt available in **${formatTime(remaining)}**`
          )
          .setFooter({ text: `${HUNT_MAX_PER_WINDOW} hunts per ${HUNT_WINDOW_HOURS} hours` }),
      ],
    });
    return;
  }

  const lucky = isLuckyActive(user);
  const animal = rollAnimal(lucky);
  const newHuntCount = currentHuntCount + 1;
  const newWindowStart = !inWindow || currentHuntCount === 0 ? new Date() : new Date(user.hunt_window_start);

  await pool.query(
    "UPDATE discord_users SET last_hunt=$1, hunt_count=$2, hunt_window_start=$3 WHERE discord_id=$4",
    [new Date(), newHuntCount, newWindowStart, message.author.id]
  );
  await pool.query(
    `INSERT INTO animal_inventory (discord_id, animal_key, quantity)
     VALUES ($1, $2, 1)
     ON CONFLICT (discord_id, animal_key) DO UPDATE SET quantity = animal_inventory.quantity + 1`,
    [message.author.id, animal.key]
  );

  logAction(message.author.id, message.author.username, "Hunt", `Caught ${animal.emoji} ${animal.name} (${animal.rarity}, ${animal.value} coins)`);
  updateQuestProgress(message.author.id, message.author.username, 'hunt').catch(() => {});
  updateQuestProgress(message.author.id, message.author.username, 'pet').catch(() => {});
  if (['Rare', 'Epic', 'Legendary'].includes(animal.rarity)) updateQuestProgress(message.author.id, message.author.username, 'rare_pet').catch(() => {});

  const huntsLeft = HUNT_MAX_PER_WINDOW - newHuntCount;
  const resetsIn = HUNT_WINDOW_MS - (Date.now() - newWindowStart.getTime());
  const huntsLine = huntsLeft > 0
    ? `**${huntsLeft}x** hunt left • resets in ${formatTime(resetsIn)}`
    : `Limit reached • resets in ${formatTime(resetsIn)}`;

  await message.reply({
    embeds: [
      embed(RARITY_COLOR[animal.rarity])
        .setTitle("🐾 HUNT RESULT")
        .setDescription(`You caught a **${animal.emoji} ${animal.name}**!${lucky ? "\n🍀 *Luck Boost active*" : ""}`)
        .addFields(
          { name: "Rarity", value: `${RARITY_BADGE[animal.rarity]} **${animal.rarity}**`, inline: true },
          { name: "Sell Value", value: `**${animal.value} ${currencyEmoji}**`, inline: true },
          { name: "Hunts Left", value: huntsLeft > 0 ? `**${huntsLeft}** · ${formatTime(resetsIn)}` : `Limit · ${formatTime(resetsIn)}`, inline: true }
        ),
    ],
  });
  } finally { releaseLock(message.author.id); }
}

async function handlePets(message) {
  const target = message.mentions.users.first() ?? message.author;
  const { rows } = await pool.query(
    "SELECT animal_key, quantity FROM animal_inventory WHERE discord_id=$1 AND quantity > 0",
    [target.id]
  );
  const owned = new Map(rows.map((r) => [r.animal_key, r.quantity]));

  const totalUnique = Object.keys(ANIMALS).length;
  let totalOwned = 0;
  const tierEmoji = { Common: "🟢", Rare: "🔵", Epic: "🟣", Legendary: "🟡" };

  const sections = [];
  for (const tier of RARITY_TABLE) {
    const tierKeys = tier.keys;
    const ownedInTier = tierKeys.filter((k) => owned.has(k)).length;
    totalOwned += ownedInTier;

    const cells = tierKeys.map((k) => {
      const a = ANIMALS[k];
      const qty = owned.get(k) || 0;
      return qty > 0
        ? `✅ ${a.emoji} ${a.name} ×${qty}`
        : `⬜ ${a.emoji} ${a.name}`;
    });

    const lines = [];
    for (let i = 0; i < cells.length; i += 3) {
      lines.push(cells.slice(i, i + 3).join("  •  "));
    }

    sections.push(
      `${tierEmoji[tier.rarity]} **${tier.rarity}** — ${ownedInTier}/${tierKeys.length} caught\n${lines.join("\n")}`
    );
  }

  const pct = Math.floor((totalOwned / totalUnique) * 100);

  await message.reply({
    embeds: [
      embed(BRAND_COLOR)
        .setTitle(`🐾 ${target.username}'s Pet Collection`)
        .setDescription(`**${totalOwned}/${totalUnique}** unique pets caught (${pct}%)\n\n${sections.join("\n\n")}`)
        .setFooter({ text: "Catch them all with !hunt and !crate!" }),
    ],
  });
}

async function handleInventory(message) {
  const { rows } = await pool.query(
    "SELECT animal_key, quantity FROM animal_inventory WHERE discord_id=$1 AND quantity > 0",
    [message.author.id]
  );

  if (rows.length === 0) {
    await message.reply({
      embeds: [embed(BRAND_COLOR).setTitle("🎒 Inventory").setDescription("Your bag is empty! Use `!hunt` to catch your first pet.")],
    });
    return;
  }

  const byRarity = {};
  let totalValue = 0;
  let totalCount = 0;
  for (const r of rows) {
    const a = ANIMALS[r.animal_key];
    if (!a) continue;
    if (!byRarity[a.rarity]) byRarity[a.rarity] = [];
    byRarity[a.rarity].push(r);
    totalValue += a.value * r.quantity;
    totalCount += r.quantity;
  }

  const fields = [];
  for (const tier of RARITY_TABLE) {
    const tierRows = byRarity[tier.rarity];
    if (!tierRows) continue;
    const lines = tierRows.map(r => {
      const a = ANIMALS[r.animal_key];
      return `${a.emoji} **${a.name}** ×${r.quantity} — ${(a.value * r.quantity).toLocaleString()} ${currencyEmoji}`;
    });
    fields.push({ name: `${RARITY_BADGE[tier.rarity]} ${tier.rarity}`, value: lines.join("\n"), inline: false });
  }

  await message.reply({
    embeds: [
      embed(GOLD_COLOR)
        .setTitle("🎒 INVENTORY")
        .setDescription(`**${totalCount}** pets · Total value: **${totalValue.toLocaleString()} ${currencyEmoji}**`)
        .addFields(...fields),
    ],
  });
}

async function handleSell(message, args) {
  const userId = message.author.id;
  const username = message.author.username;

  const TIER_EMOJI = { Common: "🟢", Rare: "🔵", Epic: "🟣", Legendary: "🟡" };

  const fetchOwned = async () => {
    const { rows } = await pool.query(
      "SELECT animal_key, quantity FROM animal_inventory WHERE discord_id=$1 AND quantity > 0",
      [userId]
    );
    return new Map(rows.map((r) => [r.animal_key, parseInt(r.quantity)]));
  };

  const calcTotals = (owned) => {
    const catTotals = {};
    let grandTotal = 0;
    let grandCount = 0;
    for (const [key, qty] of owned) {
      const a = ANIMALS[key];
      if (!a) continue;
      if (!catTotals[a.rarity]) catTotals[a.rarity] = { count: 0, value: 0 };
      catTotals[a.rarity].count += qty;
      catTotals[a.rarity].value += a.value * qty;
      grandTotal += a.value * qty;
      grandCount += qty;
    }
    return { catTotals, grandTotal, grandCount };
  };

  const owned = await fetchOwned();

  if (owned.size === 0) {
    await message.reply({ embeds: [errorEmbed("Empty Inventory", "You have no pets to sell. Try `!hunt` first.")] });
    return;
  }

  let { catTotals, grandTotal, grandCount } = calcTotals(owned);

  const buildMainEmbed = () => {
    const catLines = RARITY_TABLE
      .filter((t) => catTotals[t.rarity])
      .map((t) => {
        const { count, value } = catTotals[t.rarity];
        return `${TIER_EMOJI[t.rarity]} **${t.rarity}** — ${count} pet${count !== 1 ? "s" : ""} worth **${value} ${currencyEmoji}**`;
      });
    return embed(BRAND_COLOR)
      .setTitle("💰 Sell Pets")
      .setDescription(
        `You have **${grandCount} pet${grandCount !== 1 ? "s" : ""}** worth **${grandTotal} ${currencyEmoji}** total.\n\n` +
        catLines.join("\n") +
        "\n\n*Pick a category to browse pets, or sell everything at once.*"
      )
      .setFooter({ text: "Menu expires in 2 minutes" });
  };

  const buildMainComponents = () => {
    const comps = [];
    const catBtns = RARITY_TABLE
      .filter((t) => catTotals[t.rarity])
      .map((t) =>
        new ButtonBuilder()
          .setCustomId(`sl_cat_${userId}_${t.rarity}`)
          .setLabel(`${t.rarity} (${catTotals[t.rarity].count})`)
          .setEmoji(TIER_EMOJI[t.rarity])
          .setStyle(ButtonStyle.Secondary)
      );
    if (catBtns.length > 0) comps.push(new ActionRowBuilder().addComponents(...catBtns));
    comps.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`sl_all_${userId}`)
          .setLabel(`Sell All  ·  ${grandCount} pets  ·  ${grandTotal} ${currencyEmoji}`)
          .setEmoji("💰")
          .setStyle(ButtonStyle.Danger)
      )
    );
    return comps;
  };

  const buildCategoryEmbed = (rarity) => {
    const { count, value } = catTotals[rarity];
    const animalLines = RARITY_TABLE
      .find((t) => t.rarity === rarity).keys
      .filter((k) => owned.has(k))
      .map((k) => {
        const a = ANIMALS[k];
        const qty = owned.get(k);
        return `${a.emoji} **${a.name}** ×${qty}  —  ${a.value * qty} ${currencyEmoji}`;
      });
    return embed(RARITY_COLOR[rarity])
      .setTitle(`${TIER_EMOJI[rarity]} ${rarity} Pets`)
      .setDescription(animalLines.join("\n") + `\n\n**${count} pet${count !== 1 ? "s" : ""} total  •  ${value} ${currencyEmoji}**`)
      .setFooter({ text: "Click a pet to sell it, or sell the whole category" });
  };

  const buildCategoryComponents = (rarity) => {
    const comps = [];
    const keys = RARITY_TABLE.find((t) => t.rarity === rarity).keys.filter((k) => owned.has(k));
    for (let i = 0; i < keys.length; i += 4) {
      comps.push(
        new ActionRowBuilder().addComponents(
          ...keys.slice(i, i + 4).map((k) => {
            const a = ANIMALS[k];
            return new ButtonBuilder()
              .setCustomId(`sl_animal_${userId}_${k}`)
              .setLabel(`${a.name} ×${owned.get(k)}`)
              .setEmoji(a.emoji)
              .setStyle(ButtonStyle.Primary);
          })
        )
      );
    }
    const { count, value } = catTotals[rarity];
    comps.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`sl_allcat_${userId}_${rarity}`)
          .setLabel(`Sell All ${rarity}  ·  ${count} pets  ·  ${value} ${currencyEmoji}`)
          .setEmoji("💰")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`sl_back_${userId}`)
          .setLabel("Back")
          .setEmoji("⬅️")
          .setStyle(ButtonStyle.Secondary)
      )
    );
    return comps;
  };

  const buildAnimalConfirmEmbed = (animalKey) => {
    const a = ANIMALS[animalKey];
    const qty = owned.get(animalKey);
    return embed(WARN_COLOR)
      .setTitle(`Sell ${a.emoji} ${a.name}?`)
      .setDescription(
        `Sell **1× ${a.emoji} ${a.name}** for **${a.value} ${currencyEmoji}**?\n\n` +
        `You own **${qty}** — you'll have **${qty - 1}** remaining.`
      )
      .setFooter({ text: "This action cannot be undone" });
  };

  const buildCatConfirmEmbed = (rarity) => {
    const { count, value } = catTotals[rarity];
    const lines = RARITY_TABLE.find((t) => t.rarity === rarity).keys
      .filter((k) => owned.has(k))
      .map((k) => `${ANIMALS[k].emoji} **${ANIMALS[k].name}** ×${owned.get(k)}`);
    return embed(WARN_COLOR)
      .setTitle(`Sell All ${TIER_EMOJI[rarity]} ${rarity} Pets?`)
      .setDescription(
        `Sell **${count} ${rarity}** pet${count !== 1 ? "s" : ""} for **${value} ${currencyEmoji}**?\n\n` +
        lines.join("  •  ")
      )
      .setFooter({ text: "This action cannot be undone" });
  };

  const buildAllConfirmEmbed = () =>
    embed(WARN_COLOR)
      .setTitle("Sell All Pets?")
      .setDescription(
        `Sell **all ${grandCount} pets** for **${grandTotal} ${currencyEmoji}**?\n\n` +
        `*Your entire inventory will be cleared.*`
      )
      .setFooter({ text: "This action cannot be undone" });

  const confirmRow = (confirmId, cancelId) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel("Confirm Sale").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setEmoji("❌").setStyle(ButtonStyle.Secondary)
    );

  const reply = await message.reply({
    embeds: [buildMainEmbed()],
    components: buildMainComponents(),
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === userId,
    time: 120_000,
  });

  collector.on("collect", async (interaction) => { try {
    const id = interaction.customId;

    if (id === `sl_back_${userId}`) {
      await interaction.update({ embeds: [buildMainEmbed()], components: buildMainComponents() });

    } else if (id.startsWith(`sl_back_cat_${userId}_`)) {
      const rarity = id.slice(`sl_back_cat_${userId}_`.length);
      await interaction.update({ embeds: [buildCategoryEmbed(rarity)], components: buildCategoryComponents(rarity) });

    } else if (id.startsWith(`sl_cat_${userId}_`)) {
      const rarity = id.slice(`sl_cat_${userId}_`.length);
      await interaction.update({ embeds: [buildCategoryEmbed(rarity)], components: buildCategoryComponents(rarity) });

    } else if (id.startsWith(`sl_animal_${userId}_`)) {
      const animalKey = id.slice(`sl_animal_${userId}_`.length);
      const rarity = ANIMALS[animalKey].rarity;
      await interaction.update({
        embeds: [buildAnimalConfirmEmbed(animalKey)],
        components: [confirmRow(`sl_do_animal_${userId}_${animalKey}`, `sl_back_cat_${userId}_${rarity}`)],
      });

    } else if (id.startsWith(`sl_allcat_${userId}_`)) {
      const rarity = id.slice(`sl_allcat_${userId}_`.length);
      await interaction.update({
        embeds: [buildCatConfirmEmbed(rarity)],
        components: [confirmRow(`sl_do_allcat_${userId}_${rarity}`, `sl_back_cat_${userId}_${rarity}`)],
      });

    } else if (id === `sl_all_${userId}`) {
      await interaction.update({
        embeds: [buildAllConfirmEmbed()],
        components: [confirmRow(`sl_do_all_${userId}`, `sl_back_${userId}`)],
      });

    } else if (id.startsWith(`sl_do_animal_${userId}_`)) {
      const animalKey = id.slice(`sl_do_animal_${userId}_`.length);
      if (!acquireLock(userId)) {
        await interaction.reply({ embeds: [errorEmbed("Please Wait", "Already processing.")], ephemeral: true });
        return;
      }
      try {
        const a = ANIMALS[animalKey];
        const { rows: invRows } = await pool.query(
          "SELECT quantity FROM animal_inventory WHERE discord_id=$1 AND animal_key=$2",
          [userId, animalKey]
        );
        if (!invRows.length || invRows[0].quantity <= 0) {
          await interaction.update({ embeds: [errorEmbed("None to Sell", `You no longer have ${a.emoji} **${a.name}**.`)], components: [] });
          collector.stop();
          return;
        }
        const qty = parseInt(invRows[0].quantity);
        const remaining = qty - 1;
        if (remaining > 0) {
          await pool.query("UPDATE animal_inventory SET quantity=$1 WHERE discord_id=$2 AND animal_key=$3", [remaining, userId, animalKey]);
        } else {
          await pool.query("DELETE FROM animal_inventory WHERE discord_id=$1 AND animal_key=$2", [userId, animalKey]);
        }
        const { rows: ur } = await pool.query(
          "UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id=$2 RETURNING balance",
          [a.value, userId]
        );
        const newBalance = ur[0].balance;
        logAction(userId, username, "Sell", `Sold ${a.emoji} ${a.name} for +${a.value} coins → Balance: ${newBalance}`);
        await interaction.update({
          embeds: [
            embed(SUCCESS_COLOR)
              .setTitle(`💰 Sold ${a.emoji} ${a.name}!`)
              .addFields(
                { name: "Earned", value: `**+${a.value} ${currencyEmoji}**`, inline: true },
                { name: "New Balance", value: `**${newBalance} ${currencyEmoji}**`, inline: true },
                { name: `${a.name} Left`, value: `**${remaining}**`, inline: true }
              ),
          ],
          components: [],
        });
        collector.stop();
      } finally {
        releaseLock(userId);
      }

    } else if (id.startsWith(`sl_do_allcat_${userId}_`)) {
      const rarity = id.slice(`sl_do_allcat_${userId}_`.length);
      if (!acquireLock(userId)) {
        await interaction.reply({ embeds: [errorEmbed("Please Wait", "Already processing.")], ephemeral: true });
        return;
      }
      try {
        const catKeys = RARITY_TABLE.find((t) => t.rarity === rarity).keys.filter((k) => owned.has(k));
        let total = 0;
        let totalCount = 0;
        const breakdown = [];
        for (const k of catKeys) {
          const a = ANIMALS[k];
          const qty = owned.get(k);
          const sub = a.value * qty;
          total += sub;
          totalCount += qty;
          breakdown.push(`${a.emoji} **${a.name}** ×${qty}  →  ${sub} ${currencyEmoji}`);
          await pool.query("DELETE FROM animal_inventory WHERE discord_id=$1 AND animal_key=$2", [userId, k]);
        }
        const { rows: ur } = await pool.query(
          "UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id=$2 RETURNING balance",
          [total, userId]
        );
        const newBalance = ur[0].balance;
        logAction(userId, username, `Sell All ${rarity}`, `Sold ${totalCount} pets for +${total} coins → Balance: ${newBalance}`);
        await interaction.update({
          embeds: [
            embed(SUCCESS_COLOR)
              .setTitle(`💰 Sold All ${TIER_EMOJI[rarity]} ${rarity} Pets!`)
              .setDescription(breakdown.join("\n"))
              .addFields(
                { name: "Total Earned", value: `**+${total} ${currencyEmoji}**`, inline: true },
                { name: "New Balance", value: `**${newBalance} ${currencyEmoji}**`, inline: true }
              ),
          ],
          components: [],
        });
        collector.stop();
      } finally {
        releaseLock(userId);
      }

    } else if (id === `sl_do_all_${userId}`) {
      if (!acquireLock(userId)) {
        await interaction.reply({ embeds: [errorEmbed("Please Wait", "Already processing.")], ephemeral: true });
        return;
      }
      try {
        const { rows: allRows } = await pool.query(
          "SELECT animal_key, quantity FROM animal_inventory WHERE discord_id=$1 AND quantity > 0",
          [userId]
        );
        let total = 0;
        let totalAnimals = 0;
        const breakdown = [];
        for (const r of allRows) {
          const a = ANIMALS[r.animal_key];
          if (!a) continue;
          const sub = a.value * r.quantity;
          total += sub;
          totalAnimals += r.quantity;
          breakdown.push(`${a.emoji} **${a.name}** ×${r.quantity}  →  ${sub} ${currencyEmoji}`);
        }
        await pool.query("DELETE FROM animal_inventory WHERE discord_id=$1", [userId]);
        const { rows: ur } = await pool.query(
          "UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id=$2 RETURNING balance",
          [total, userId]
        );
        const newBalance = ur[0].balance;
        logAction(userId, username, "Sell All", `Sold ${totalAnimals} pets for +${total} coins → Balance: ${newBalance}`);
        await interaction.update({
          embeds: [
            embed(SUCCESS_COLOR)
              .setTitle(`💰 Sold All ${totalAnimals} Pets!`)
              .setDescription(breakdown.join("\n"))
              .addFields(
                { name: "Total Earned", value: `**+${total} ${currencyEmoji}**`, inline: true },
                { name: "New Balance", value: `**${newBalance} ${currencyEmoji}**`, inline: true }
              )
              .setFooter({ text: "Inventory cleared • !hunt to start again" }),
          ],
          components: [],
        });
        collector.stop();
      } finally {
        releaseLock(userId);
      }
    }
  } catch (err) { console.error("Sell collector error:", err); }
  });

  collector.on("end", async (collected, reason) => {
    if (reason === "time") {
      await reply.edit({
        embeds: [embed(0x888888).setTitle("💰 Sell Menu Closed").setDescription("Menu expired due to inactivity.")],
        components: [],
      }).catch(() => {});
    }
  });
}

// =================== ADVENTURE ===================

async function handleAdventure(message) {
  if (!gamesEnabled) { await message.reply({ embeds: [gamesDisabledEmbed()] }); return; }
  const user = await getOrCreateUser(message.author.id, message.author.username);

  if (user.last_adventure) {
    const elapsed = Date.now() - new Date(user.last_adventure).getTime();
    if (elapsed < ADVENTURE_COOLDOWN_MS) {
      await message.reply({
        embeds: [
          embed(WARN_COLOR)
            .setTitle("⏳ Adventure Cooldown")
            .setDescription(`Your hero is resting. Next adventure in **${formatTime(ADVENTURE_COOLDOWN_MS - elapsed)}**.`)
            .setFooter({ text: `Adventure cooldown: ${ADVENTURE_COOLDOWN_HOURS} hours` }),
        ],
      });
      return;
    }
  }

  const scenario = ADVENTURE_SCENARIOS[Math.floor(Math.random() * ADVENTURE_SCENARIOS.length)];
  const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];

  const row = new ActionRowBuilder().addComponents(
    ...scenario.choices.map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`adv_${message.author.id}_${i}`)
        .setLabel(`${i + 1}`)
        .setEmoji(numberEmojis[i])
        .setStyle(ButtonStyle.Primary)
    )
  );

  const description = [
    scenario.description,
    "",
    "**What do you do?**",
    ...scenario.choices.map((c, i) => `${numberEmojis[i]} ${c}`),
  ].join("\n");

  const reply = await message.reply({
    embeds: [
      embed(BRAND_COLOR)
        .setTitle(`${scenario.emoji} ${scenario.title}`)
        .setDescription(description)
        .setFooter({ text: "Choose within 30 seconds" }),
    ],
    components: [row],
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === message.author.id,
    time: ADVENTURE_RESPONSE_MS,
    max: 1,
  });

  let answered = false;

  collector.on("collect", async (interaction) => { try {
    answered = true;
    const choiceIdx = parseInt(interaction.customId.split("_").pop(), 10);
    const choiceLabel = scenario.choices[choiceIdx];

    const disabledRow = new ActionRowBuilder().addComponents(
      ...scenario.choices.map((_, i) =>
        new ButtonBuilder()
          .setCustomId(`adv_d_${i}`)
          .setLabel(`${i + 1}`)
          .setEmoji(numberEmojis[i])
          .setStyle(i === choiceIdx ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true)
      )
    );

    await interaction.update({
      embeds: [
        embed(BRAND_COLOR)
          .setTitle(`${scenario.emoji} ${scenario.title}`)
          .setDescription(`You chose **${numberEmojis[choiceIdx]} ${choiceLabel}**...\n\n*Resolving the adventure...*`)
          .setFooter({ text: "Outcome incoming!" }),
      ],
      components: [disabledRow],
    });

    await new Promise((r) => setTimeout(r, 1500));

    await pool.query("UPDATE discord_users SET last_adventure=$1 WHERE discord_id=$2", [new Date(), message.author.id]);

    const outcome = ADVENTURE_OUTCOMES[Math.floor(Math.random() * ADVENTURE_OUTCOMES.length)];
    let resultEmbed;

    let logResult = "Nothing";
    if (outcome === "crate") {
      const { rows } = await pool.query(
        "UPDATE discord_users SET crates = crates + 1 WHERE discord_id=$1 RETURNING crates",
        [message.author.id]
      );
      logResult = `Obtained ${CRATE_EMOJI} ${CRATE_NAME}`;
      resultEmbed = embed(GOLD_COLOR)
        .setTitle("🎁 You found something hidden...")
        .setDescription(`You obtained: **${CRATE_EMOJI} ${CRATE_NAME} 🐾 ×1**`)
        .setFooter({ text: `You now have ${rows[0].crates} crate${rows[0].crates !== 1 ? "s" : ""} • Open with !crate` });
    } else if (outcome === "animal") {
      const { rows: advUser } = await pool.query("SELECT luck_boost_until FROM discord_users WHERE discord_id=$1", [message.author.id]);
      const advLucky = advUser.length && isLuckyActive(advUser[0]);
      const animal = rollAnimal(advLucky);
      await pool.query(
        `INSERT INTO animal_inventory (discord_id, animal_key, quantity)
         VALUES ($1, $2, 1)
         ON CONFLICT (discord_id, animal_key) DO UPDATE SET quantity = animal_inventory.quantity + 1`,
        [message.author.id, animal.key]
      );
      logResult = `Caught ${animal.emoji} ${animal.name} (${animal.rarity}, ${animal.value} coins)`;
      resultEmbed = embed(RARITY_COLOR[animal.rarity])
        .setTitle("🐾 You discovered a creature...")
        .setDescription(`You caught: **${animal.emoji} ${animal.name}** *(${animal.rarity} • ${animal.value} coins)*`)
        .setFooter({ text: "Added to your inventory • !inv to view" });
    } else if (outcome === "gain") {
      const roll = Math.random() * 100;
      let gained;
      if (roll < 43) {
        gained = Math.floor(Math.random() * 6) + 5;      // 5–10
      } else if (roll < 78) {
        gained = Math.floor(Math.random() * 16) + 10;    // 10–25
      } else if (roll < 98) {
        gained = Math.floor(Math.random() * 16) + 25;    // 25–40
      } else {
        gained = 50;                                       // 2% jackpot
      }
      const { rows: gr } = await pool.query(
        "UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id=$2 RETURNING balance",
        [gained, message.author.id]
      );
      const newBalance = gr[0].balance;
      logResult = `+${gained} coins → Balance: ${newBalance}`;
      resultEmbed = embed(SUCCESS_COLOR)
        .setTitle("💰 You found a hidden stash...")
        .setDescription(`**+${gained} ${currencyEmoji}** added to your balance!`)
        .setFooter({ text: `New balance: ${newBalance} coins` });
    } else if (outcome === "lose") {
      const fresh = await getOrCreateUser(message.author.id, message.author.username);
      const loss = fresh.balance < 100 ? Math.floor(fresh.balance * 0.4) : 40;
      const { rows: lr } = await pool.query(
        "UPDATE discord_users SET balance = GREATEST(0, balance - $1) WHERE discord_id=$2 RETURNING balance",
        [loss, message.author.id]
      );
      const newBalance = lr[0].balance;
      logResult = loss > 0 ? `-${loss} coins → Balance: ${newBalance}` : "No loss (balance was 0)";
      resultEmbed = embed(ERROR_COLOR)
        .setTitle("⚠️ You triggered a trap...")
        .setDescription(loss > 0 ? `You lost **${loss} ${currencyEmoji}**!` : "Luckily you had nothing to lose...")
        .setFooter({ text: `New balance: ${newBalance} coins` });
    } else {
      resultEmbed = embed(BRAND_COLOR)
        .setTitle("🌫️ Nothing interesting happened...")
        .setDescription("Maybe next time, adventurer.")
        .setFooter({ text: `Try again in ${ADVENTURE_COOLDOWN_HOURS} hours with !adventure` });
    }
    logAction(message.author.id, message.author.username, `Adventure (${scenario.title})`, logResult);
    updateQuestProgress(message.author.id, message.author.username, 'adventure').catch(() => {});

    await reply.edit({
      embeds: [
        embed(BRAND_COLOR)
          .setTitle(`${scenario.emoji} ${scenario.title}`)
          .setDescription(`You chose **${numberEmojis[choiceIdx]} ${choiceLabel}**`)
          .setFooter({ text: "Adventure complete!" }),
        resultEmbed,
      ],
      components: [disabledRow],
    });
  } catch (err) { console.error("Adventure collector error:", err); }
  });

  collector.on("end", async () => {
    if (!answered) {
      const timeoutRow = new ActionRowBuilder().addComponents(
        ...scenario.choices.map((_, i) =>
          new ButtonBuilder()
            .setCustomId(`adv_t_${i}`)
            .setLabel(`${i + 1}`)
            .setEmoji(numberEmojis[i])
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );
      await reply.edit({
        embeds: [
          embed(WARN_COLOR)
            .setTitle("⏳ Adventure Cancelled")
            .setDescription("You took too long to decide. The opportunity slipped away...")
            .setFooter({ text: "No cooldown applied — try !adventure again" }),
        ],
        components: [timeoutRow],
      }).catch(() => {});
    }
  });
}

// =================== CRATES ===================

const CRATE_NAME = "Wild Crate";
const CRATE_EMOJI = "🎁";
const CRATE_COST = 40;

async function handleOpenCrate(message, args = []) {
  if (!gamesEnabled) { await message.reply({ embeds: [gamesDisabledEmbed()] }); return; }
  if (!acquireLock(message.author.id)) {
    await message.reply({ embeds: [errorEmbed("Please Wait", "You have a command in progress. Try again in a moment.")] });
    return;
  }
  try {
    const user = await getOrCreateUser(message.author.id, message.author.username);
    const available = user.crates || 0;

    if (available <= 0) {
      await message.reply({
        embeds: [errorEmbed("No Crates", `You don't have any ${CRATE_EMOJI} **${CRATE_NAME}s** to open.\nBuy one from \`!shop\`, or ask an admin for \`!givecrate\`.`)],
      });
      return;
    }

    const requested = Math.max(1, parseInt(args[0] ?? "1") || 1);
    const toOpen = Math.min(requested, available, 100); // cap at 100 per command
    const lucky = isLuckyActive(user);

    if (toOpen === 1) {
      // ── Single crate: show result + Sell / Keep buttons ──
      const animal = rollAnimal(lucky);
      await pool.query("UPDATE discord_users SET crates = crates - 1 WHERE discord_id=$1", [message.author.id]);
      await pool.query(
        `INSERT INTO animal_inventory (discord_id, animal_key, quantity)
         VALUES ($1, $2, 1)
         ON CONFLICT (discord_id, animal_key) DO UPDATE SET quantity = animal_inventory.quantity + 1`,
        [message.author.id, animal.key]
      );
      logAction(message.author.id, message.author.username, "Open Crate", `Got ${animal.emoji} ${animal.name} (${animal.rarity}, ${animal.value} coins)`);
      updateQuestProgress(message.author.id, message.author.username, 'crate').catch(() => {});
      updateQuestProgress(message.author.id, message.author.username, 'pet').catch(() => {});
      if (['Rare', 'Epic', 'Legendary'].includes(animal.rarity)) updateQuestProgress(message.author.id, message.author.username, 'rare_pet').catch(() => {});
      const cratesLeft = available - 1;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cr_keep_${message.author.id}`).setLabel("Keep").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cr_sell_${animal.key}_${message.author.id}`).setLabel(`Sell for ${animal.value} coins`).setStyle(ButtonStyle.Secondary),
      );

      const reply = await message.reply({
        embeds: [
          embed(RARITY_COLOR[animal.rarity])
            .setTitle(`${CRATE_EMOJI} You opened a ${CRATE_NAME}!`)
            .setDescription(`Inside you found... **${animal.emoji} ${animal.name}**!`)
            .addFields(
              { name: "Pet", value: `${animal.emoji} **${animal.name}**`, inline: true },
              { name: "Rarity", value: `**${animal.rarity}**`, inline: true },
              { name: "Sell Value", value: `**${animal.value} coins**`, inline: true }
            )
            .setFooter({ text: `${cratesLeft} crate${cratesLeft !== 1 ? "s" : ""} remaining • !inv to view collection` }),
        ],
        components: [row],
      });

      const collector = reply.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 30_000,
        max: 1,
      });

      collector.on("collect", async (i) => { try {
        if (i.customId.startsWith("cr_sell_")) {
          await pool.query(
            "UPDATE animal_inventory SET quantity = quantity - 1 WHERE discord_id=$1 AND animal_key=$2",
            [message.author.id, animal.key]
          );
          await pool.query(
            "DELETE FROM animal_inventory WHERE discord_id=$1 AND animal_key=$2 AND quantity <= 0",
            [message.author.id, animal.key]
          );
          await pool.query(
            "UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id=$2",
            [animal.value, message.author.id]
          );
          logAction(message.author.id, message.author.username, "Sell Pet (crate)", `Sold ${animal.emoji} ${animal.name} for ${animal.value} coins`);
          await i.update({
            embeds: [successEmbed("Sold!", `Sold **${animal.emoji} ${animal.name}** for **${animal.value} coins**.`)],
            components: [],
          });
        } else {
          await i.update({ components: [] });
        }
      } catch (err) { console.error("Crate sell collector error:", err); }
      });

      collector.on("end", async (_, reason) => {
        if (reason === "time") await reply.edit({ components: [] }).catch(() => {});
      });

    } else {
      // ── Multi-crate: open all, show summary ──
      const animals = [];
      for (let i = 0; i < toOpen; i++) animals.push(rollAnimal(lucky));

      await pool.query("UPDATE discord_users SET crates = crates - $1 WHERE discord_id=$2", [toOpen, message.author.id]);
      for (const a of animals) {
        await pool.query(
          `INSERT INTO animal_inventory (discord_id, animal_key, quantity)
           VALUES ($1, $2, 1)
           ON CONFLICT (discord_id, animal_key) DO UPDATE SET quantity = animal_inventory.quantity + 1`,
          [message.author.id, a.key]
        );
      }

      const grouped = {};
      for (const a of animals) {
        if (!grouped[a.key]) grouped[a.key] = { animal: a, count: 0 };
        grouped[a.key].count++;
      }
      const lines = Object.values(grouped)
        .sort((x, y) => y.animal.value - x.animal.value)
        .map(({ animal, count }) => `${animal.emoji} **${animal.name}** ×${count} — ${animal.value * count} coins *(${animal.rarity})*`);
      const totalValue = animals.reduce((s, a) => s + a.value, 0);
      const cratesLeft = available - toOpen;

      logAction(message.author.id, message.author.username, "Open Crates", `Opened ${toOpen}x crates, total value ${totalValue} coins`);
      updateQuestProgress(message.author.id, message.author.username, 'crate', toOpen).catch(() => {});
      for (const _qa of animals) {
        updateQuestProgress(message.author.id, message.author.username, 'pet').catch(() => {});
        if (['Rare', 'Epic', 'Legendary'].includes(_qa.rarity)) updateQuestProgress(message.author.id, message.author.username, 'rare_pet').catch(() => {});
      }
      await message.reply({
        embeds: [
          embed(GOLD_COLOR)
            .setTitle(`${CRATE_EMOJI} Opened ${toOpen} ${CRATE_NAME}s!`)
            .setDescription(lines.join("\n"))
            .addFields({ name: "Total Sell Value", value: `**${totalValue} coins**`, inline: true })
            .setFooter({ text: `${cratesLeft} crate${cratesLeft !== 1 ? "s" : ""} remaining` }),
        ],
      });
    }
  } finally { releaseLock(message.author.id); }
}

// =================== SHOP ===================

async function handleShop(message) {
  const userId = message.author.id;
  const username = message.author.username;

  function shopMainEmbed(user) {
    const luckLine = isLuckyActive(user)
      ? `\n🍀 **Luck Boost** active until <t:${Math.floor(new Date(user.luck_boost_until).getTime() / 1000)}:t>`
      : "";
    const guardLine = (user.cf_guard || 0) > 0 ? `\n🔒 **Coinflip Guard** ×${user.cf_guard}` : "";
    const activeItems = luckLine + guardLine;
    return embed(ROBUX_COLOR)
      .setTitle("🛒 Everdale Shop")
      .setDescription(`Your balance: **${user.balance} coins**\n\nChoose a category below.${activeItems ? `\n\n**Active Items:**${activeItems}` : ""}`)
      .setFooter({ text: "Items take effect immediately after purchase" });
  }

  function categoryRow(uid) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sp_cat_crates_${uid}`).setLabel("🎁 Crates").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`sp_cat_boosts_${uid}`).setLabel("⚡ Boosts").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sp_cat_protection_${uid}`).setLabel("🛡️ Protection").setStyle(ButtonStyle.Secondary),
    );
  }

  function itemsForCategory(category) {
    return Object.values(SHOP_ITEMS).filter(i => i.category === category);
  }

  function categoryEmbed(category, user) {
    const items = itemsForCategory(category);
    const label = { crates: "🎁 Crates", boosts: "⚡ Boosts", protection: "🛡️ Protection" }[category];
    return embed(ROBUX_COLOR)
      .setTitle(`🛒 ${label}`)
      .setDescription(items.map(i => `${i.emoji} **${i.name}** — **${i.price} ${currencyEmoji}**\n${i.description}`).join("\n\n"))
      .setFooter({ text: `Your balance: ${user.balance} coins` });
  }

  function itemButtonsRow(category, uid) {
    const items = itemsForCategory(category);
    const buttons = items.map(i =>
      new ButtonBuilder()
        .setCustomId(`sp_buy_${i.key}_${uid}`)
        .setLabel(`${i.emoji} ${i.name} — ${i.price} coins`)
        .setStyle(ButtonStyle.Primary)
    );
    const backBtn = new ButtonBuilder().setCustomId(`sp_back_${uid}`).setLabel("← Back").setStyle(ButtonStyle.Secondary);
    const rows = [];
    for (let r = 0; r < Math.ceil((buttons.length + 1) / 5); r++) {
      const chunk = buttons.slice(r * 5, r * 5 + 5);
      if (r === Math.floor(buttons.length / 5)) chunk.push(backBtn);
      if (chunk.length) rows.push(new ActionRowBuilder().addComponents(...chunk));
    }
    if (!rows.length) rows.push(new ActionRowBuilder().addComponents(backBtn));
    return rows;
  }

  function confirmEmbed(item, user) {
    return embed(WARN_COLOR)
      .setTitle(`${item.emoji} Confirm Purchase`)
      .setDescription(`Buy **${item.name}** for **${item.price} ${currencyEmoji}**?\n\n${item.description}`)
      .addFields(
        { name: "Your Balance", value: `**${user.balance} ${currencyEmoji}**`, inline: true },
        { name: "After Purchase", value: `**${user.balance - item.price} ${currencyEmoji}**`, inline: true }
      );
  }

  function confirmRow(itemKey, uid) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sp_confirm_${itemKey}_${uid}`).setLabel("✅ Confirm").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sp_cancel_${uid}`).setLabel("❌ Cancel").setStyle(ButtonStyle.Danger),
    );
  }

  const user = await getOrCreateUser(userId, username);
  const reply = await message.reply({ embeds: [shopMainEmbed(user)], components: [categoryRow(userId)] });

  const collector = reply.createMessageComponentCollector({
    filter: i => i.user.id === userId,
    time: 90_000,
  });

  let currentCategory = null;

  collector.on("collect", async (interaction) => { try {
    const id = interaction.customId;

    if (id === `sp_back_${userId}`) {
      currentCategory = null;
      const fresh = await getOrCreateUser(userId, username);
      await interaction.update({ embeds: [shopMainEmbed(fresh)], components: [categoryRow(userId)] });
      return;
    }

    if (id === `sp_cancel_${userId}`) {
      currentCategory = null;
      const fresh = await getOrCreateUser(userId, username);
      await interaction.update({ embeds: [shopMainEmbed(fresh)], components: [categoryRow(userId)] });
      return;
    }

    const catMatch = id.match(new RegExp(`^sp_cat_(\\w+)_${userId}$`));
    if (catMatch) {
      currentCategory = catMatch[1];
      const fresh = await getOrCreateUser(userId, username);
      await interaction.update({ embeds: [categoryEmbed(currentCategory, fresh)], components: itemButtonsRow(currentCategory, userId) });
      return;
    }

    const buyMatch = id.match(new RegExp(`^sp_buy_(\\w+)_${userId}$`));
    if (buyMatch) {
      const itemKey = buyMatch[1];
      const item = SHOP_ITEMS[itemKey];
      if (!item) return;
      const fresh = await getOrCreateUser(userId, username);
      await interaction.update({ embeds: [confirmEmbed(item, fresh)], components: [confirmRow(itemKey, userId)] });
      return;
    }

    const confirmMatch = id.match(new RegExp(`^sp_confirm_(\\w+)_${userId}$`));
    if (confirmMatch) {
      const itemKey = confirmMatch[1];
      const item = SHOP_ITEMS[itemKey];
      if (!item) return;

      if (!acquireLock(userId)) {
        await interaction.reply({ embeds: [errorEmbed("Please Wait", "A command is in progress.")], ephemeral: true });
        return;
      }
      try {
        const fresh = await getOrCreateUser(userId, username);
        if (fresh.balance < item.price) {
          await interaction.update({
            embeds: [errorEmbed("Insufficient Balance", `You need **${item.price} ${currencyEmoji}** but only have **${fresh.balance} ${currencyEmoji}**.`)],
            components: [categoryRow(userId)],
          });
          return;
        }

        let updateQuery;
        let updateParams;

        if (item.key === "wildCrate1") {
          updateQuery = "UPDATE discord_users SET balance = balance - $1, crates = crates + 1 WHERE discord_id=$2 RETURNING balance, crates";
          updateParams = [item.price, userId];
        } else if (item.key === "wildCrate5") {
          updateQuery = "UPDATE discord_users SET balance = balance - $1, crates = crates + 5 WHERE discord_id=$2 RETURNING balance, crates";
          updateParams = [item.price, userId];
        } else if (item.key === "luckBoost") {
          const until = new Date(Date.now() + item.durationMs);
          updateQuery = "UPDATE discord_users SET balance = balance - $1, luck_boost_until = $2 WHERE discord_id=$3 RETURNING balance";
          updateParams = [item.price, until, userId];
        } else if (item.key === "cfGuard") {
          updateQuery = "UPDATE discord_users SET balance = balance - $1, cf_guard = cf_guard + 1 WHERE discord_id=$2 RETURNING balance, cf_guard";
          updateParams = [item.price, userId];
        } else {
          await interaction.reply({ embeds: [errorEmbed("Unknown Item", "This item cannot be purchased.")], ephemeral: true });
          return;
        }

        const { rows } = await pool.query(updateQuery, updateParams);
        const row = rows[0];
        logAction(userId, username, "Shop Purchase", `${item.emoji} ${item.name} for ${item.price} coins → Balance: ${row.balance}`);
        updateQuestProgress(userId, username, 'shop').catch(() => {});

        let resultDesc = `You purchased **${item.emoji} ${item.name}**!`;
        if (item.key === "luckBoost") {
          const until = new Date(Date.now() + item.durationMs);
          resultDesc += `\n🍀 Luck Boost active until <t:${Math.floor(until.getTime() / 1000)}:t> — enjoy enhanced drops in hunt & crates!`;
        } else if (item.key === "cfGuard") {
          resultDesc += `\n🔒 Your next **${row.cf_guard}** coinflip loss${row.cf_guard !== 1 ? "es will" : " will"} give a 50% refund!`;
        } else if (item.key === "wildCrate1" || item.key === "wildCrate5") {
          resultDesc += `\n🎁 You now have **${row.crates} crate${row.crates !== 1 ? "s" : ""}**. Open with \`!crate\`!`;
        }

        await interaction.update({
          embeds: [
            embed(SUCCESS_COLOR)
              .setTitle("✅ Purchase Successful!")
              .setDescription(resultDesc)
              .addFields(
                { name: "Spent", value: `**-${item.price} ${currencyEmoji}**`, inline: true },
                { name: "New Balance", value: `**${row.balance} ${currencyEmoji}**`, inline: true }
              )
              .setFooter({ text: "Use !shop to buy more" }),
          ],
          components: [categoryRow(userId)],
        });
      } finally {
        releaseLock(userId);
      }
    }
  } catch (err) { console.error("Shop collector error:", err); }
  });

  collector.on("end", async (collected, reason) => {
    if (reason === "time") {
      await reply.edit({ components: [] }).catch(() => {});
    }
  });
}

// =================== ADMIN COMMANDS ===================


async function handleAdminRemoveRobux(message, args) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }
  const targetUser = message.mentions.users.first();
  const amount = parseInt(args[1] ?? "");
  if (!targetUser || isNaN(amount) || amount <= 0) { await message.reply({ embeds: [errorEmbed("Invalid Usage", "Usage: `!removepoints @user <amount>`")] }); return; }
  const user = await getOrCreateUser(targetUser.id, targetUser.username);
  const newBalance = Math.max(0, user.balance - amount);
  await pool.query("UPDATE discord_users SET balance = GREATEST(0, balance - $1) WHERE discord_id=$2", [amount, targetUser.id]);
  logAction(message.author.id, message.author.username, "Admin Remove Points", `-${amount} coins from ${targetUser.username} → Balance: ${newBalance}`);
  await message.reply({ embeds: [successEmbed("Currency Removed", `Removed **${amount}** ${currencyEmoji} from **${targetUser.username}**.\nNew balance: **${newBalance}** ${currencyEmoji}`)] });
}

async function handleAdminAddMsg(message, args) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }
  const targetUser = message.mentions.users.first();
  const amount = parseInt(args[1] ?? "");
  if (!targetUser || isNaN(amount) || amount <= 0) { await message.reply({ embeds: [errorEmbed("Invalid Usage", "Usage: `!addmsg @user <amount>`")] }); return; }
  const user = await getOrCreateUser(targetUser.id, targetUser.username);
  const newCount = user.message_count + amount;
  await pool.query("UPDATE discord_users SET message_count=$1 WHERE discord_id=$2", [newCount, targetUser.id]);
  await message.reply({ embeds: [successEmbed("Messages Added", `Added **${amount} messages** to **${targetUser.username}**.\nNew count: **${newCount}/${EARN_REQUIRED_MESSAGES}**`)] });
}

async function handleAdminRemoveMsg(message, args) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }
  const targetUser = message.mentions.users.first();
  const amount = parseInt(args[1] ?? "");
  if (!targetUser || isNaN(amount) || amount <= 0) { await message.reply({ embeds: [errorEmbed("Invalid Usage", "Usage: `!removemsg @user <amount>`")] }); return; }
  const user = await getOrCreateUser(targetUser.id, targetUser.username);
  const newCount = Math.max(0, user.message_count - amount);
  await pool.query("UPDATE discord_users SET message_count=$1 WHERE discord_id=$2", [newCount, targetUser.id]);
  await message.reply({ embeds: [successEmbed("Messages Removed", `Removed **${amount} messages** from **${targetUser.username}**.\nNew count: **${newCount}/${EARN_REQUIRED_MESSAGES}**`)] });
}

async function handleAdminResetPoints(message) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }
  const targetUser = message.mentions.users.first();
  if (!targetUser) { await message.reply({ embeds: [errorEmbed("Invalid Usage", "Usage: `!resetpoints @user`")] }); return; }
  await getOrCreateUser(targetUser.id, targetUser.username);
  await pool.query("UPDATE discord_users SET balance=0 WHERE discord_id=$1", [targetUser.id]);
  await message.reply({ embeds: [successEmbed("Balance Reset", `Reset **${targetUser.username}**'s balance to **0** ${currencyEmoji}.`)] });
}

async function handleAdminResetAll(message) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }
  const targetUser = message.mentions.users.first();
  if (!targetUser) { await message.reply({ embeds: [errorEmbed("Invalid Usage", "Usage: `!resetall @user`")] }); return; }
  await getOrCreateUser(targetUser.id, targetUser.username);
  await pool.query(
    "UPDATE discord_users SET balance=0, message_count=0, earn_count=0, earn_window_start=NULL, last_daily=NULL, daily_streak=0, total_earned=0, last_hunt=NULL, hunt_count=0, hunt_window_start=NULL, last_adventure=NULL, luck_boost_until=NULL, cf_guard=0 WHERE discord_id=$1",
    [targetUser.id]
  );
  await message.reply({ embeds: [successEmbed("Full Reset", `Completely reset **${targetUser.username}**'s profile.`)] });
}

async function handleAdminResetServer(message) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }

  const { rows: countRows } = await pool.query("SELECT COUNT(*)::int AS n FROM discord_users");
  const total = countRows[0].n;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`resetsrv_confirm_${message.author.id}`).setLabel("Confirm Reset").setEmoji("⚠️").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`resetsrv_cancel_${message.author.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  const reply = await message.reply({
    embeds: [
      embed(ERROR_COLOR)
        .setTitle("⚠️ Confirm Full Server Reset")
        .setDescription(
          `This will wipe **EVERY user** *(${total} total)*:\n` +
          `• Balance → 0\n` +
          `• Messages → 0\n` +
          `• Earn cooldown → cleared\n` +
          `• Daily cooldown → cleared\n` +
          `• Daily streak → 0\n` +
          `• Total earned → 0\n\n` +
          `**This cannot be undone.** Confirm within 30 seconds.`
        )
        .setFooter({ text: "Only the admin who ran the command can confirm." }),
    ],
    components: [row],
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === message.author.id,
    time: 30000,
    max: 1,
  });

  collector.on("collect", async (interaction) => { try {
    if (interaction.customId.startsWith("resetsrv_cancel_")) {
      await interaction.update({
        embeds: [embed(0x888888).setTitle("Cancelled").setDescription("Server reset cancelled.")],
        components: [],
      });
      return;
    }

    const { rowCount } = await pool.query(
      "UPDATE discord_users SET balance=0, message_count=0, earn_count=0, earn_window_start=NULL, last_daily=NULL, daily_streak=0, total_earned=0, last_hunt=NULL, hunt_count=0, hunt_window_start=NULL, last_adventure=NULL, luck_boost_until=NULL, cf_guard=0"
    );

    await interaction.update({
      embeds: [
        successEmbed(
          "Server Reset Complete",
          `Reset **${rowCount}** users — all balances, messages, cooldowns, streaks, and totals zeroed.`
        ),
      ],
      components: [],
    });
  } catch (err) { console.error("Reset server collector error:", err); }
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      await reply.edit({
        embeds: [embed(0x888888).setTitle("Confirmation Expired").setDescription("Server reset cancelled (no response in 30s).")],
        components: [],
      }).catch(() => {});
    }
  });
}

// =================== EMOJI / CURRENCY ===================

async function handleAdminSetEmoji(message, args) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }
  const emoji = args[0];
  if (!emoji) { await message.reply({ embeds: [errorEmbed("Invalid Usage", "Usage: `!setemoji <emoji>`\nExample: `!setemoji 💎` or `!setemoji <:robux:1234567890>`")] }); return; }
  await setCurrencyEmoji(emoji);
  await message.reply({ embeds: [successEmbed("Currency Emoji Set", `Currency is now displayed as ${currencyEmoji}`)] });
}

async function handleAdminSetLogChannel(message) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }
  const channel = message.mentions.channels.first() ?? message.channel;
  await setLogChannel(channel.id);
  await message.reply({ embeds: [successEmbed("Log Channel Set", `All economy events will now be logged to ${channel}.`)] });
}

async function handleAdminViewLogs(message, args) {
  if (!isAdmin(message.member)) { await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] }); return; }
  const target = message.mentions.users.first();
  const limit = 10;
  const { rows } = target
    ? await pool.query(
        "SELECT username, action, result, created_at FROM bot_logs WHERE discord_id=$1 ORDER BY created_at DESC LIMIT $2",
        [target.id, limit]
      )
    : await pool.query(
        "SELECT username, action, result, created_at FROM bot_logs ORDER BY created_at DESC LIMIT $1",
        [limit]
      );

  if (rows.length === 0) {
    await message.reply({ embeds: [embed(BRAND_COLOR).setTitle("📋 Logs").setDescription("No logs found.")] });
    return;
  }

  const lines = rows.map((r) => {
    const ts = new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return `**${r.username}** • ${r.action}\n↳ ${r.result} *(${ts})*`;
  });

  await message.reply({
    embeds: [
      embed(BRAND_COLOR)
        .setTitle(`📋 Recent Logs${target ? ` — ${target.username}` : ""}`)
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: `Showing last ${rows.length} events` }),
    ],
  });
}

// =================== GAME TOGGLE ===================

async function handleGameToggle(message, args) {
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] });
    return;
  }
  const action = (args[0] ?? "").toLowerCase();
  if (action !== "enable" && action !== "disable") {
    await message.reply({ embeds: [errorEmbed("Invalid Usage", "Usage: `!game enable` or `!game disable`")] });
    return;
  }
  const enable = action === "enable";
  await setGamesEnabled(enable);
  await message.reply({
    embeds: [
      successEmbed(
        enable ? "🎮 Games Enabled" : "🔒 Games Disabled",
        enable
          ? "All game commands (`!cf`, `!duel`, `!hunt`, `!crate`, `!adventure`) are now **enabled**."
          : "All game commands are now **disabled** server-wide."
      ),
    ],
  });
}

async function handleGameStatus(message) {
  await message.reply({
    embeds: [
      embed(gamesEnabled ? SUCCESS_COLOR : WARN_COLOR)
        .setTitle("🎮 GAME STATUS")
        .setDescription(gamesEnabled
          ? "✅ Games are currently **enabled**.\nPlayers can use `!cf`, `!duel`, `!hunt`, `!crate`, and `!adventure`."
          : "🔒 Games are currently **disabled**.\nAn admin can re-enable them with `!game enable`."),
    ],
  });
}

// =================== FIRST-TO-REACT GIVEAWAY ===================

async function handleFtr(message, args) {
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [errorEmbed("No Permission", "You need Administrator or Manage Server permission.")] });
    return;
  }

  // Parse from the end: last = time, second-to-last = winners, everything before = prize
  const DURATION_MS = parseDuration(args[args.length - 1]);
  const winnersCount = parseInt(args[args.length - 2] ?? "");
  const prizeWords = args.slice(0, args.length - 2);
  const MAX_DURATION = 24 * 60 * 60 * 1000;

  if (
    prizeWords.length === 0 ||
    isNaN(winnersCount) || winnersCount <= 0 ||
    !DURATION_MS || DURATION_MS <= 0 || DURATION_MS > MAX_DURATION
  ) {
    await message.reply({ embeds: [errorEmbed(
      "Invalid Usage",
      "Usage: `!ftr <prize> <number_of_winners> <time>`\n" +
      "The prize can be **anything** — coins, a bot item, or a real-world prize.\n" +
      "Time: `30s`, `5m`, `1h`, `2h30m` *(plain number = minutes, max 24h)*\n\n" +
      "**Bot prize keywords** (auto-delivered):\n" +
      "`coins:<amount>` — e.g. `coins:500`\n" +
      "`crate` — 🎁 Wild Crate\n" +
      "`luck` — 🍀 Luck Boost (1 hour)\n" +
      "`cfguard` — 🔒 Coinflip Guard\n\n" +
      "**Custom prizes** (you deliver manually):\n" +
      "`Nitro` • `100 Robux` • `VIP Role` • anything\n\n" +
      "**Examples:**\n" +
      "`!ftr 100 Robux 1 5m`\n" +
      "`!ftr Discord Nitro 1 10m`\n" +
      "`!ftr coins:500 3 5m`\n" +
      "`!ftr crate 2 10m`"
    )] });
    return;
  }

  const prizeRaw = prizeWords.join(" ");
  const prizeLower = prizeRaw.toLowerCase();

  // Detect built-in bot prizes
  const coinMatch = prizeLower.match(/^coins?:(\d+)$/) || prizeLower.match(/^(\d+)$/);
  const coinAmount = coinMatch ? parseInt(coinMatch[1]) : 0;

  const BOT_PRIZE =
    coinAmount > 0           ? { key: "coins",   label: `**${coinAmount} ${currencyEmoji}**`,  desc: `**${coinAmount} ${currencyEmoji}**` } :
    prizeLower === "crate" || prizeLower === "crates"
                             ? { key: "crate",   label: "🎁 Wild Crate",     desc: "a Wild Crate 🎁" } :
    prizeLower === "luck" || prizeLower === "luckboost"
                             ? { key: "luck",    label: "🍀 Luck Boost",     desc: "a 1-hour Luck Boost 🍀" } :
    prizeLower === "cfguard" || prizeLower === "guard"
                             ? { key: "cfguard", label: "🔒 Coinflip Guard", desc: "a Coinflip Guard 🔒" } :
    null;

  // Custom prize — display as typed, admin delivers manually
  const prizeLabel = BOT_PRIZE ? BOT_PRIZE.label : `**${prizeRaw}**`;
  const prizeDesc  = BOT_PRIZE ? BOT_PRIZE.desc  : `**${prizeRaw}**`;
  const isCustom   = BOT_PRIZE === null;

  const REACT_EMOJI = "🎉";
  const startedAt = Date.now();
  const endsAt = startedAt + DURATION_MS;
  const winners = [];

  const buildLiveEmbed = () => {
    const remaining = Math.max(0, endsAt - Date.now());
    const slotsLeft = winnersCount - winners.length;
    const winnerList = winners.length === 0
      ? "_No one yet — be the first!_"
      : winners.map((w, i) => `${rankMedal(i)} <@${w.id}>`).join("\n");

    return embed(GOLD_COLOR)
      .setTitle("🎉 First-to-React Giveaway!")
      .setDescription(
        `React with ${REACT_EMOJI} to win ${prizeLabel}!\n\n` +
        `🏆 **${winners.length}/${winnersCount}** winner${winnersCount === 1 ? "" : "s"} claimed` +
        (slotsLeft > 0 ? ` • **${slotsLeft}** slot${slotsLeft === 1 ? "" : "s"} left` : " • **FULL**") + `\n` +
        `⏳ Ends in **${formatTime(remaining)}** *(or once all slots are filled)*\n\n` +
        `**Winners so far:**\n${winnerList}`
      )
      .setFooter({ text: `Hosted by ${message.author.username}${isCustom ? " • Prize delivered manually by host" : ""}` });
  };

  const ftrMsg = await message.channel.send({ embeds: [buildLiveEmbed()] });
  await ftrMsg.react(REACT_EMOJI).catch(() => {});

  const collector = ftrMsg.createReactionCollector({
    filter: (reaction, user) =>
      reaction.emoji.name === REACT_EMOJI &&
      !user.bot &&
      !winners.some((w) => w.id === user.id),
    time: DURATION_MS,
  });

  collector.on("collect", async (_reaction, user) => {
    if (winners.some((w) => w.id === user.id)) return;
    winners.push({ id: user.id, name: user.username });
    try {
      await getOrCreateUser(user.id, user.username);
      if (BOT_PRIZE?.key === "coins") {
        await pool.query(
          "UPDATE discord_users SET balance = balance + $1, total_earned = total_earned + $1 WHERE discord_id = $2",
          [coinAmount, user.id]
        );
      } else if (BOT_PRIZE?.key === "crate") {
        await pool.query("UPDATE discord_users SET crates = crates + 1 WHERE discord_id = $1", [user.id]);
      } else if (BOT_PRIZE?.key === "luck") {
        await pool.query(
          "UPDATE discord_users SET luck_boost_until = GREATEST(COALESCE(luck_boost_until, NOW()), NOW()) + INTERVAL '1 hour' WHERE discord_id = $1",
          [user.id]
        );
      } else if (BOT_PRIZE?.key === "cfguard") {
        await pool.query("UPDATE discord_users SET cf_guard = cf_guard + 1 WHERE discord_id = $1", [user.id]);
      }
      // Custom prizes: no bot action, host delivers manually
    } catch (err) {
      console.error("FTR payout error:", err);
    }
    await ftrMsg.edit({ embeds: [buildLiveEmbed()] }).catch(() => {});
    if (winners.length >= winnersCount) collector.stop("filled");
  });

  collector.on("end", async () => {
    if (winners.length === 0) {
      await ftrMsg.edit({
        embeds: [
          embed(0x888888)
            .setTitle("🎉 Giveaway Ended")
            .setDescription(`No one reacted in time. The ${prizeLabel} prize goes unclaimed.`),
        ],
      }).catch(() => {});
      return;
    }
    const list = winners.map((w, i) => `${rankMedal(i)} <@${w.id}> — ${prizeDesc}`).join("\n");
    await ftrMsg.edit({
      embeds: [
        embed(SUCCESS_COLOR)
          .setTitle("🎉 Giveaway Ended!")
          .setDescription(
            `**${winners.length}** winner${winners.length !== 1 ? "s" : ""} grabbed the prize:\n\n${list}` +
            (isCustom ? `\n\n*${message.author.username} — please deliver the prize to the winner${winners.length !== 1 ? "s" : ""}!*` : "")
          )
          .setFooter({ text: `Hosted by ${message.author.username}` }),
      ],
    }).catch(() => {});
    await message.channel.send(
      `🎉 Congrats ${winners.map((w) => `<@${w.id}>`).join(" ")} — you each won ${prizeDesc}!`
    ).catch(() => {});
  });
}

// =================== SLASH COMMANDS ===================

function mkMsg(interaction, { targetUser = null, targetChannel = null } = {}) {
  let firstReply = true;
  const doReply = async (data) => {
    if (!firstReply) return interaction.followUp(data);
    firstReply = false;
    return interaction.reply({ ...data, fetchReply: true });
  };
  return {
    author: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,
    content: "",
    mentions: {
      users: { first: () => targetUser },
      channels: { first: () => targetChannel },
    },
    reply: doReply,
  };
}

const SLASH_COMMANDS = [
  // User
  new SlashCommandBuilder().setName("bal").setDescription("Check your coin balance")
    .addUserOption(o => o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("earn").setDescription("Earn coins (requires 50 messages)"),
  new SlashCommandBuilder().setName("daily").setDescription("Claim your daily reward"),
  new SlashCommandBuilder().setName("profile").setDescription("View your full profile")
    .addUserOption(o => o.setName("user").setDescription("User to view")),
  new SlashCommandBuilder().setName("msgs").setDescription("Check message count progress")
    .addUserOption(o => o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder().setName("lb").setDescription("View the top 10 leaderboard"),
  new SlashCommandBuilder().setName("hunt").setDescription("Hunt for a random pet (2x per 20h)"),
  new SlashCommandBuilder().setName("pets").setDescription("View pet collection")
    .addUserOption(o => o.setName("user").setDescription("User to view")),
  new SlashCommandBuilder().setName("inv").setDescription("View your inventory"),
  new SlashCommandBuilder().setName("sell").setDescription("Sell a pet or all pets")
    .addStringOption(o => o.setName("pet").setDescription("Pet name or 'all'").setRequired(true)),
  new SlashCommandBuilder().setName("crate").setDescription("Open one or more Wild Crates")
    .addIntegerOption(o => o.setName("amount").setDescription("Number of crates to open (default 1, max 100)").setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName("shop").setDescription("Open the item shop"),
  new SlashCommandBuilder().setName("cf").setDescription("Flip a coin and bet")
    .addStringOption(o => o.setName("amount").setDescription("Amount to bet").setRequired(true)),
  new SlashCommandBuilder().setName("duel").setDescription("Challenge someone to a duel")
    .addUserOption(o => o.setName("user").setDescription("User to duel").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount to bet").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("adventure").setDescription("Go on an adventure (12h cooldown)"),
  new SlashCommandBuilder().setName("game").setDescription("[Admin] Enable or disable game commands")
    .addStringOption(o => o.setName("action").setDescription("enable or disable").setRequired(true).addChoices({name:"enable",value:"enable"},{name:"disable",value:"disable"})),
  new SlashCommandBuilder().setName("gamestatus").setDescription("Check if games are currently enabled"),
  new SlashCommandBuilder().setName("help").setDescription("Show all user commands"),
  // Admin
  new SlashCommandBuilder().setName("removepoints").setDescription("[Admin] Remove coins from a user")
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("resetpoints").setDescription("[Admin] Reset a user's balance to 0")
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true)),
  new SlashCommandBuilder().setName("addmsg").setDescription("[Admin] Add messages to a user")
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("removemsg").setDescription("[Admin] Remove messages from a user")
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("setemoji").setDescription("[Admin] Set the currency emoji")
    .addStringOption(o => o.setName("emoji").setDescription("New emoji").setRequired(true)),
  new SlashCommandBuilder().setName("setlogchannel").setDescription("[Admin] Set the economy log channel")
    .addChannelOption(o => o.setName("channel").setDescription("Channel (defaults to current)")),
  new SlashCommandBuilder().setName("logs").setDescription("[Admin] View recent economy logs")
    .addUserOption(o => o.setName("user").setDescription("Filter by user")),
  new SlashCommandBuilder().setName("ftr").setDescription("[Admin] First-to-react giveaway")
    .addStringOption(o => o.setName("prize").setDescription("Prize — anything: 'Discord Nitro', '100 Robux', 'crate', 'coins:500'…").setRequired(true))
    .addIntegerOption(o => o.setName("winners").setDescription("Number of winners").setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName("duration").setDescription("Duration e.g. 5m, 1h, 30s").setRequired(true)),
  new SlashCommandBuilder().setName("resetall").setDescription("[Admin] Fully reset one user's profile")
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true)),
  new SlashCommandBuilder().setName("resetserver").setDescription("[Admin] ⚠️ Reset ALL users (irreversible)"),
  new SlashCommandBuilder().setName("quests").setDescription("View your daily quests"),
  new SlashCommandBuilder().setName("claimquest").setDescription("Claim completed quest rewards"),
  new SlashCommandBuilder().setName("rerollquest").setDescription("Reroll one quest (1 free per day)"),
].map(c => c.toJSON());

// =================== BOT CLIENT ===================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.on(Events.ClientReady, async (c) => {
  discordClient = c;
  const storedChannel = await pool.query("SELECT value FROM bot_settings WHERE key='log_channel_id'").catch(() => ({ rows: [] }));
  if (storedChannel.rows[0]) logChannelId = storedChannel.rows[0].value;
  console.log(`✅ Bot ready! Logged in as ${c.user.tag}`);

  // Register slash commands globally
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationCommands(c.user.id), { body: SLASH_COMMANDS });
    console.log(`✅ ${SLASH_COMMANDS.length} slash commands registered`);
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;
  try {
    switch (cmd) {
      case "bal":         await handleBalance(mkMsg(interaction, { targetUser: interaction.options.getUser("user") }), []); break;
      case "earn":        await handleEarn(mkMsg(interaction)); break;
      case "daily":       await handleDaily(mkMsg(interaction)); break;
      case "profile":     await handleProfile(mkMsg(interaction, { targetUser: interaction.options.getUser("user") }), []); break;
      case "msgs":        await handleMessages(mkMsg(interaction)); break;
      case "lb":          await handleLeaderboard(mkMsg(interaction)); break;
      case "hunt":        await handleHunt(mkMsg(interaction)); break;
      case "pets":        await handlePets(mkMsg(interaction, { targetUser: interaction.options.getUser("user") })); break;
      case "inv":         await handleInventory(mkMsg(interaction)); break;
      case "sell":        await handleSell(mkMsg(interaction), [interaction.options.getString("pet")]); break;
      case "crate": {
        const amt = interaction.options.getInteger("amount") ?? 1;
        await handleOpenCrate(mkMsg(interaction), [amt.toString()]);
        break;
      }
      case "shop":        await handleShop(mkMsg(interaction)); break;
      case "cf":          await handleCoinFlip(mkMsg(interaction), [interaction.options.getString("amount")]); break;
      case "adventure":   await handleAdventure(mkMsg(interaction)); break;
      case "quests":      await handleQuests(mkMsg(interaction)); break;
      case "claimquest":  await handleClaimQuest(mkMsg(interaction)); break;
      case "rerollquest": await handleRerollQuest(mkMsg(interaction)); break;
      case "help":        await handleHelp(mkMsg(interaction)); break;
      case "duel": {
        const u = interaction.options.getUser("user");
        const amt = interaction.options.getInteger("amount").toString();
        await handleDuel(mkMsg(interaction, { targetUser: u }), [null, amt]);
        break;
      }
      case "removepoints": {
        const u = interaction.options.getUser("user");
        await handleAdminRemoveRobux(mkMsg(interaction, { targetUser: u }), [null, interaction.options.getInteger("amount").toString()]);
        break;
      }
      case "resetpoints":
        await handleAdminResetPoints(mkMsg(interaction, { targetUser: interaction.options.getUser("user") }));
        break;
      case "addmsg": {
        const u = interaction.options.getUser("user");
        await handleAdminAddMsg(mkMsg(interaction, { targetUser: u }), [null, interaction.options.getInteger("amount").toString()]);
        break;
      }
      case "removemsg": {
        const u = interaction.options.getUser("user");
        await handleAdminRemoveMsg(mkMsg(interaction, { targetUser: u }), [null, interaction.options.getInteger("amount").toString()]);
        break;
      }
      case "setemoji":
        await handleAdminSetEmoji(mkMsg(interaction), [interaction.options.getString("emoji")]);
        break;
      case "setlogchannel": {
        const ch = interaction.options.getChannel("channel");
        await handleAdminSetLogChannel(mkMsg(interaction, { targetChannel: ch }));
        break;
      }
      case "logs":
        await handleAdminViewLogs(mkMsg(interaction, { targetUser: interaction.options.getUser("user") }), []);
        break;
      case "game":
        await handleGameToggle(mkMsg(interaction), [interaction.options.getString("action")]);
        break;
      case "gamestatus":
        await handleGameStatus(mkMsg(interaction));
        break;
      case "ftr": {
        const prize = interaction.options.getString("prize");
        const winners = interaction.options.getInteger("winners").toString();
        const duration = interaction.options.getString("duration");
        await handleFtr(mkMsg(interaction), [...prize.split(" "), winners, duration]);
        break;
      }
      case "resetall":
        await handleAdminResetAll(mkMsg(interaction, { targetUser: interaction.options.getUser("user") }));
        break;
      case "resetserver":
        await handleAdminResetServer(mkMsg(interaction));
        break;
    }
  } catch (err) {
    console.error(`Slash command error [${cmd}]:`, err);
    const errData = { embeds: [errorEmbed("Error", "Something went wrong.")], ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errData).catch(() => {});
    } else {
      await interaction.reply(errData).catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  try {
    await incrementMessageCount(message.author.id, message.author.username);
  } catch (err) {
    console.error("Message count error:", err);
  }

  if (!message.content.startsWith(PREFIX)) return;

  try {
    const claim = await pool.query(
      `INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [message.id]
    );
    if (claim.rowCount === 0) return;
  } catch (_) { return; }

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  try {
    switch (command) {
      // Earning
      case "earn": case "work": case "grind": case "claim":
        await handleEarn(message); break;
      case "daily": case "dly": case "day": case "dailyreward":
        await handleDaily(message); break;

      // Games
      case "cf": case "coinflip": case "flip": case "coin":
        await handleCoinFlip(message, args); break;
      case "duel": case "fight": case "battle": case "challenge":
        await handleDuel(message, args); break;
      case "adventure": case "adv": case "explore":
        await handleAdventure(message); break;

      // Daily Quests
      case "quests": case "quest": case "dailyquests": case "dq":
        await handleQuests(message); break;
      case "claimquest": case "claimquests": case "cq":
        await handleClaimQuest(message); break;
      case "rerollquest": case "reroll":
        await handleRerollQuest(message); break;

      // Animal hunt
      case "hunt": case "h": case "catch":
        await handleHunt(message); break;
      case "inv": case "inventory": case "bag": case "collection":
        await handleInventory(message); break;
      case "pets": case "pokedex": case "dex": case "petlist": case "petdex":
        await handlePets(message); break;
      case "sell":
        await handleSell(message, args); break;
      case "sellall":
        await handleSell(message, ["all"]); break;
      case "crate": case "opencrate": case "openchest":
        await handleOpenCrate(message, args); break;
      case "shop": case "store": case "market":
        await handleShop(message); break;


      // Info
      case "bal": case "balance": case "money": case "cash": case "wallet": case "points":
        await handleBalance(message, args); break;
      case "msg": case "msgs": case "messages": case "progress": case "msgprogress":
        await handleMessages(message); break;
      case "lb": case "leaderboard": case "top": case "rank": case "ranking": case "ranks":
        await handleLeaderboard(message); break;
      case "profile": case "stats": case "info": case "me": case "card":
        await handleProfile(message, args); break;

      // Help
      case "help": case "ehelp": case "helpp": case "commands": case "cmds": case "cmd":
        await handleHelp(message); break;
      case "ahelp": case "adminhelp": case "modhelp": case "ahelps":
        await handleAHelp(message); break;

      // Admin: balance
      case "removepoints": case "removerobux": case "removemoney": case "removecash": case "removebal": case "removebalance": case "take": case "deduct":
        await handleAdminRemoveRobux(message, args); break;
      case "resetpoints": case "resetbal": case "resetbalance": case "resetmoney": case "resetcash":
        await handleAdminResetPoints(message); break;

      // Admin: messages
      case "addmsg": case "addmsgs": case "addmessages": case "addmessage":
        await handleAdminAddMsg(message, args); break;
      case "removemsg": case "removemsgs": case "removemessages": case "removemessage": case "delmsg":
        await handleAdminRemoveMsg(message, args); break;

      // Admin: full reset
      case "resetall": case "resetuser": case "fullreset": case "wipeuser":
        await handleAdminResetAll(message); break;
      case "resetserver": case "resetalluser": case "resetallusers": case "resetguild": case "wipeserver": case "wipeall":
        await handleAdminResetServer(message); break;

      // Admin: currency emoji
      case "setemoji": case "setcurrency": case "currency": case "emoji":
        await handleAdminSetEmoji(message, args); break;

      // Admin: log channel
      case "setlogchannel": case "logchannel": case "setlogs":
        await handleAdminSetLogChannel(message); break;

      // Admin: view logs
      case "logs": case "log": case "viewlogs": case "auditlog":
        await handleAdminViewLogs(message, args); break;

      // Admin: game toggle
      case "game":
        await handleGameToggle(message, args); break;
      case "gamestatus": case "gamesstatus": case "games":
        await handleGameStatus(message); break;

      // Admin: giveaway
      case "ftr": case "firsttoreact": case "giveaway": case "gw": case "drop":
        await handleFtr(message, args); break;
    }
  } catch (err) {
    console.error(`Command error [${command}]:`, err);
    await message.reply({ embeds: [errorEmbed("Error", "Something went wrong. Please try again.")] }).catch(() => {});
  }
});

const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
if (!token) { console.error("Missing DISCORD_TOKEN"); process.exit(1); }

(async () => {
  try {
    await setupDatabase();

    // Leader election: only one bot instance may run at a time.
    // pg_try_advisory_lock acquires a session-level lock. If another instance
    // already holds it, this instance exits immediately. The lock is released
    // automatically when the process (and its DB connection) dies.
    const lockClient = await pool.connect();
    const { rows } = await lockClient.query("SELECT pg_try_advisory_lock(777123) AS acquired");
    if (!rows[0].acquired) {
      console.log("⚠️  Another bot instance is already running. Exiting to avoid duplicates.");
      process.exit(0);
    }
    // Keep lockClient alive for the lifetime of the process so the lock is held.
    process.on("exit", () => lockClient.release());

    await client.login(token);
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();

/**
 * theme.js
 * Unified design system for all bot embeds.
 * All embeds must be built through these helpers to maintain visual consistency.
 *
 * SEELE Guild — Game UI Aesthetic
 * Colors are chosen to feel like a military command interface.
 */

const Discord = require('discord.js');

// ─── COLOR PALETTE ────────────────────────────────────────────────────────────
const COLORS = {
  // XP & Progression
  XP_ADD:      0x00e5ff,  // Cyan — "XP gained" (fast, clean)
  XP_REMOVE:   0xff6b35,  // Orange-red — "XP removed"

  // Rank changes
  PROMOTION:   0x7c4dff,  // Deep violet — celebratory promotion
  DEMOTION:    0xff1744,  // Vivid red — serious demotion

  // Profile & Info
  PROFILE:     0x1a237e,  // Deep navy — authoritative profile
  LEADERBOARD: 0xf9a825,  // Gold — competitive ranking

  // System
  SUCCESS:     0x00c853,  // Bright green — success / sync
  WARNING:     0xffab00,  // Amber — partial / warning
  ERROR:       0xd50000,  // Deep red — error / failure
  AUDIT:       0xff6d00,  // Burnt orange — admin / audit logs
  SYSTEM:      0x546e7a,  // Slate — system messages / reconcile
};

// ─── FOOTER BRANDING ──────────────────────────────────────────────────────────
const GUILD_NAME = 'SEELE Guild System';

/**
 * Applies the standard branded footer to any embed.
 * @param {Discord.RichEmbed} embed
 * @returns {Discord.RichEmbed}
 */
function applyFooter(embed) {
  return embed.setFooter(GUILD_NAME).setTimestamp();
}

// ─── PROGRESS BAR ─────────────────────────────────────────────────────────────
/**
 * Generates a 10-segment emoji progress bar.
 * @param {number} percent - 0 to 100
 * @returns {string}
 */
function progressBar(percent) {
  const filled = '█';
  const empty  = '░';
  const total  = 10;
  const filledCount = Math.round((Math.min(100, Math.max(0, percent)) / 100) * total);
  return `\`${filled.repeat(filledCount)}${empty.repeat(total - filledCount)}\` **${percent}%**`;
}

// ─── XP FORMATTER ─────────────────────────────────────────────────────────────
function fmtXP(n) {
  return Number(n).toLocaleString();
}

// ─── EMBED BUILDERS ───────────────────────────────────────────────────────────

/**
 * XP ADDED embed — shown in the channel when an officer grants XP.
 * Lightweight, fast, informative.
 */
function buildXPAddedEmbed({ rblxUsername, userID, addAmount, newXP, reason, officerTag, nextRankName, nextRankXP }) {
  const progress = nextRankXP > 0 ? Math.min(100, Math.round((newXP / nextRankXP) * 100)) : 100;
  const bar = progressBar(progress);
  const remainingXP = nextRankXP > 0 ? Math.max(0, nextRankXP - newXP) : 0;

  const embed = new Discord.RichEmbed()
    .setColor(COLORS.XP_ADD)
    .setAuthor(`✦ XP Granted — ${rblxUsername}`)
    .addField('⚡ XP Gained', `+${fmtXP(addAmount)} XP`, true)
    .addField('📊 Total XP', `${fmtXP(newXP)} XP`, true)
    .addField('📋 Reason', reason || 'Officer grant', false)
    .addField(`Progress → ${nextRankName || 'Max Rank'}`, `${bar}\n${remainingXP > 0 ? `**${fmtXP(remainingXP)} XP** remaining for next rank` : '**✓ Ready for promotion**'}`, false)
    .setFooter(`Granted by ${officerTag} • SEELE Guild System`)
    .setTimestamp();
  return embed;
}

/**
 * XP REMOVED embed — shown when an officer removes XP.
 */
function buildXPRemovedEmbed({ rblxUsername, removeAmount, newXP, reason, officerTag }) {
  const embed = new Discord.RichEmbed()
    .setColor(COLORS.XP_REMOVE)
    .setAuthor(`✦ XP Adjusted — ${rblxUsername}`)
    .addField('📉 XP Removed', `-${fmtXP(removeAmount)} XP`, true)
    .addField('📊 New Total', `${fmtXP(newXP)} XP`, true)
    .addField('📋 Reason', reason || 'Officer adjustment', false)
    .setFooter(`Adjusted by ${officerTag} • SEELE Guild System`)
    .setTimestamp();
  return embed;
}

/**
 * PROMOTION embed — shown when a user is promoted in the Roblox group.
 * High-impact, celebratory.
 */
function buildPromotionEmbed({ rblxUsername, userID, oldRankName, newRankName, newXP }) {
  const embed = new Discord.RichEmbed()
    .setColor(COLORS.PROMOTION)
    .setAuthor(`⬆ PROMOTION — ${rblxUsername}`)
    .setTitle('Rank Advancement')
    .setDescription([
      `**[${rblxUsername}](https://www.roblox.com/users/${userID}/profile)** has been promoted within **SEELE**.`,
      '',
      `${oldRankName ? `\`${oldRankName}\`` : '*Unknown*'} **→** \`${newRankName}\``,
      '',
      `*Congratulations on your advancement, Comrade.*`
    ].join('\n'))
    .addField('📊 Current XP', `${fmtXP(newXP)} XP`, true)
    .addField('🎖 New Rank', newRankName, true);
  return applyFooter(embed);
}

/**
 * DEMOTION embed — shown when a user is demoted due to XP falling below threshold.
 * Serious, not cruel.
 */
function buildDemotionEmbed({ rblxUsername, userID, currentRankName, requiredXP, newXP }) {
  const embed = new Discord.RichEmbed()
    .setColor(COLORS.DEMOTION)
    .setAuthor(`⬇ DEMOTION — ${rblxUsername}`)
    .setTitle('Rank Adjustment')
    .setDescription([
      `**[${rblxUsername}](https://www.roblox.com/users/${userID}/profile)** has been demoted.`,
      '',
      `Rank **\`${currentRankName}\`** requires **${fmtXP(requiredXP)} XP**.`,
      `Current XP: **${fmtXP(newXP)} XP**.`,
      '',
      `*Continue serving SEELE to regain your standing.*`
    ].join('\n'));
  return applyFooter(embed);
}

/**
 * PROFILE embed — premium game-UI stat card.
 * Used by !view.
 */
function buildProfileEmbed({ rblxUsername, userID, avatarURL, currentRankName, currentXP, nextRankName, nextRankXP }) {
  const progress = nextRankXP > 0 ? Math.min(100, Math.round((currentXP / nextRankXP) * 100)) : 100;
  const bar = progressBar(progress);
  const remaining = nextRankXP > 0 ? Math.max(0, nextRankXP - currentXP) : 0;

  const embed = new Discord.RichEmbed()
    .setColor(COLORS.PROFILE)
    .setAuthor(rblxUsername, avatarURL || undefined, `https://www.roblox.com/users/${userID}/profile`)
    .setTitle('Guild Profile')
    .setThumbnail(avatarURL || 'https://t0.rbxcdn.com/2ce8c5a24285b4f2c90c0ef497c23ae6')
    .addField('🎖 Current Rank', currentRankName || 'Unranked', true)
    .addField('📊 Total XP', `${fmtXP(currentXP)} XP`, true)
    .addField('\u200B', '\u200B', true)
    .addField('🎯 Next Rank', nextRankName || 'Max Rank', true)
    .addField('⭐ XP Needed', nextRankXP > 0 ? `${fmtXP(nextRankXP)} XP` : '—', true)
    .addField('\u200B', '\u200B', true)
    .addField(`Progress — ${nextRankName || 'Max Rank'}`,
      bar + (remaining > 0 ? `\n**${fmtXP(remaining)} XP** to next rank` : '\n**✓ Ready for promotion**'),
      false);
  return applyFooter(embed);
}

/**
 * LEADERBOARD embed — competitive top-N display.
 * Optionally highlights a specific user (the requester).
 */
function buildLeaderboardEmbed({ entries, highlightId }) {
  const medals = ['🥇', '🥈', '🥉'];

  const lines = entries.map((entry, i) => {
    const medal = medals[i] !== undefined ? medals[i] : `**${i + 1}.**`;
    const you = entry.id === highlightId ? ' ◀ **YOU**' : '';
    return `${medal} [${entry.name}](https://www.roblox.com/users/${entry.id}/profile) — **${fmtXP(entry.xp)} XP**${you}`;
  });

  const embed = new Discord.RichEmbed()
    .setColor(COLORS.LEADERBOARD)
    .setAuthor('🏆 SEELE — XP Leaderboard')
    .setDescription(lines.join('\n') || 'No entries found.')
    .setFooter('SEELE Guild System • Cached up to 5 min')
    .setTimestamp();
  return embed;
}

/**
 * ADMIN AUDIT LOG embed — posted to the private audit channel.
 * Structured for review.
 */
function buildAuditEmbed({ action, rblxUsername, userID, delta, newTotal, reason, actorTag, channelId }) {
  const isAdd = delta > 0;
  const isSystem = !actorTag || actorTag === 'AutoReconcile' || actorTag === 'system';
  const color = isSystem ? COLORS.SYSTEM : isAdd ? COLORS.AUDIT : COLORS.XP_REMOVE;
  const actionIcon = isSystem ? '⚙' : isAdd ? '⬆' : '⬇';
  const deltaStr = delta > 0 ? `+${fmtXP(delta)}` : (delta < 0 ? `${fmtXP(delta)}` : '±0');

  const embed = new Discord.RichEmbed()
    .setColor(color)
    .setAuthor(`${actionIcon} ${action || 'XP Change'} — ${rblxUsername}`)
    .addField('👤 User', `[${rblxUsername}](https://www.roblox.com/users/${userID}/profile) \`(${userID})\``, false)
    .addField('⚡ XP Delta', deltaStr, true)
    .addField('📊 New Total', `${fmtXP(newTotal)} XP`, true)
    .addField('\u200B', '\u200B', true)
    .addField('📋 Reason', reason || 'Not specified', true)
    .addField('🔧 Source', isSystem ? 'System / Auto' : `Officer: ${actorTag}`, true)
    .addField('📍 Channel', channelId && channelId !== 'system' ? `<#${channelId}>` : 'System', true);
  return applyFooter(embed);
}

/**
 * SYNC COMPLETED embed — shown after !update completes successfully.
 */
function buildSyncEmbed({ targetMember, rblxUsername, currentXP, rankName, newNickname }) {
  const embed = new Discord.RichEmbed()
    .setColor(COLORS.SUCCESS)
    .setAuthor(`✓ Sync Completed — ${rblxUsername}`)
    .addField('🎮 Roblox', `[${rblxUsername}](https://www.roblox.com/users/)`, true)
    .addField('📊 XP', `${fmtXP(currentXP)} XP`, true)
    .addField('🎖 Rank', rankName, true)
    .addField('🏷 Nickname', `\`${newNickname}\``, false)
    .addField('🔗 Discord', `${targetMember}`, true);
  return applyFooter(embed);
}

/**
 * SYNC PARTIAL embed — shown when Discord sync is incomplete (missing role, member not found).
 */
function buildSyncPartialEmbed({ rblxUsername, rankName, currentXP, reason }) {
  const embed = new Discord.RichEmbed()
    .setColor(COLORS.WARNING)
    .setAuthor(`⚠ Sync Partial — ${rblxUsername}`)
    .setDescription(reason)
    .addField('🎖 Validated Rank', rankName, true)
    .addField('📊 XP', `${fmtXP(currentXP)} XP`, true);
  return applyFooter(embed);
}

/**
 * ERROR embed — generic error display.
 */
function buildErrorEmbed(description) {
  return applyFooter(
    new Discord.RichEmbed()
      .setColor(COLORS.ERROR)
      .setDescription(`❌ ${description}`)
  );
}

/**
 * NOT FOUND embed — for invalid users, missing DB entries, etc.
 */
function buildNotFoundEmbed(description) {
  return applyFooter(
    new Discord.RichEmbed()
      .setColor(COLORS.WARNING)
      .setDescription(`⚠️ ${description}`)
  );
}

module.exports = {
  COLORS,
  progressBar,
  fmtXP,
  applyFooter,
  buildXPAddedEmbed,
  buildXPRemovedEmbed,
  buildPromotionEmbed,
  buildDemotionEmbed,
  buildProfileEmbed,
  buildLeaderboardEmbed,
  buildAuditEmbed,
  buildSyncEmbed,
  buildSyncPartialEmbed,
  buildErrorEmbed,
  buildNotFoundEmbed,
};

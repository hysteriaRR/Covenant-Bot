/* CONFIG FILE START */
const config = require('./settings/config.json');
/* CONFIG FILE END */

/* PACKAGES START */
const fs = require('fs');
const Discord = require('discord.js');
const bot = new Discord.Client();
const snekfetch = require('snekfetch');
const rbx = require('noblox.js');
const bloxy = require('bloxy');
const bloxyClient = new bloxy.Client({
  credentials: {
    cookie: `${config.rblxCookie}`
  }
})
bloxyClient.login().then(function() {
  console.log("Logged in on ROBLOX")
});
const admin = require("firebase-admin");
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || config.serviceAccountPath;
let firebase;
if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.fireBaseURL
  });
  firebase = admin;
} else {
  console.warn("Firebase service account not found. Falling back to legacy Firebase client.");
  const firebaseClient = require("firebase");
  firebaseClient.initializeApp({
    databaseURL: config.fireBaseURL
  });
  firebase = firebaseClient;
}

/* UTILS */
const { getExpectedRoleIndex, getActualRoleIndex, isHRRole, getNextRankObj, getProgress } = require('./utils/rankUtils');
const { getCachedGroupRoles, getCachedRolesDB, getCachedLeaderboard, setLeaderboardCache, invalidateCache } = require('./utils/cache');
const theme = require('./utils/theme');

/* PACKAGES END */

/* ─── HELPERS ──────────────────────────────────────────────────────────────── */

const getFirebaseData = async path => {
  const snapshot = await firebase.database().ref(path).once('value');
  return snapshot ? snapshot.val() : null;
};

const getRobloxUserByUsername = async username => {
  const { body } = await snekfetch.post('https://users.roblox.com/v1/usernames/users')
    .send({ usernames: [username], excludeBannedUsers: false });
  if (!body || !body.data || body.data.length === 0) return null;
  return body.data[0];
};

/**
 * Writes a structured audit record to Firebase.
 * This is in addition to the Discord embed log and serves as a permanent,
 * queryable, channel-independent audit trail.
 */
const writeAuditLog = async ({ userId, username, delta, newTotal, reason, actorId, actorTag, channelId }) => {
  try {
    const key = `${Date.now()}_${userId}`;
    await firebase.database().ref(`auditLog/${key}`).set({
      userId: String(userId),
      username,
      delta,
      newTotal,
      reason,
      actorId: String(actorId),
      actorTag,
      channelId: String(channelId),
      timestamp: Date.now()
    });
  } catch (e) {
    console.error('[AuditLog] Failed to write audit log:', e.message);
  }
};

/**
 * Atomically updates a user's XP using a Firebase transaction.
 * Prevents race conditions from simultaneous grants.
 * Returns the new XP total.
 *
 * @param {string|number} userID
 * @param {number} delta - Positive to add, negative to remove
 * @param {number} [minValue=0] - Floor for the resulting XP (default 0)
 * @returns {Promise<number>} New XP value
 */
const atomicXPUpdate = async (userID, delta, minValue = 0) => {
  const userRef = firebase.database().ref(`xpData/users/${userID}`);
  const result = await userRef.transaction(current => {
    const cur = current ? Number(current.xpValue) : 0;
    const next = Math.max(minValue, cur + delta);
    return { xpValue: next };
  });
  return result.snapshot.val().xpValue;
};

/**
 * Attempts to acquire an idempotency lock for a given grant event.
 * Returns true if the lock was acquired (first time), false if already processed.
 *
 * Locks are keyed by message ID + user ID, expiring after 24 hours.
 */
const acquireGrantLock = async (messageId, userId) => {
  const lockKey = `xpLocks/${messageId}_${userId}`;
  const lockRef = firebase.database().ref(lockKey);
  const result = await lockRef.transaction(val => {
    if (val === null) return { timestamp: Date.now() };
    return; // already exists — abort
  });
  return result.committed;
};

/**
 * Checks and enforces the daily XP cap for a user.
 * Returns { allowed: true, remaining } or { allowed: false, current, cap }.
 */
const checkDailyCap = async (userID, amount) => {
  const cap = config.dailyXPCap || 0;
  if (cap === 0) return { allowed: true, current: 0, cap: 0, remaining: Infinity }; // 0 = disabled
  const today = new Date().toISOString().split('T')[0];
  const dailyRef = firebase.database().ref(`dailyXP/${today}/${userID}`);
  const snap = await dailyRef.once('value');
  const current = snap.val() ? Number(snap.val().total) : 0;
  if (current + amount > cap) {
    return { allowed: false, current, cap, remaining: cap - current };
  }
  return { allowed: true, current, cap, remaining: cap - current };
};

/**
 * Increments the user's daily XP tally (separate from actual XP).
 */
const recordDailyXP = async (userID, amount) => {
  const today = new Date().toISOString().split('T')[0];
  const dailyRef = firebase.database().ref(`dailyXP/${today}/${userID}`);
  await dailyRef.transaction(cur => ({ total: (cur ? Number(cur.total) : 0) + amount }));
};

/**
 * Trims old idempotency locks older than 24 hours.
 * Runs as a background cleanup every hour.
 */
const cleanupExpiredLocks = async () => {
  try {
    const snap = await firebase.database().ref('xpLocks').once('value');
    const locks = snap.val();
    if (!locks) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, val] of Object.entries(locks)) {
      if (val.timestamp && val.timestamp < cutoff) {
        await firebase.database().ref(`xpLocks/${key}`).remove();
      }
    }
  } catch (e) {
    console.error('[Cleanup] Lock cleanup failed:', e.message);
  }
};

/**
 * Core promotion/demotion logic used by both !xp and the reconciliation job.
 * Compares expected rank (from XP) vs actual rank (from Roblox group).
 * If mismatch, updates the Roblox group rank via Bloxy.
 * Returns the expectedRoleObj for further use.
 */
const syncRobloxRank = async ({ userID, newXP, rolesData, allRolesDB, groupFunction, channel, rblxUsername }) => {
  const currentRankID = await rbx.getRankInGroup(config.groupID, userID);
  if (currentRankID <= 0 || currentRankID >= 255) return null;

  const expectedIndex = getExpectedRoleIndex(rolesData, allRolesDB, newXP);
  const actualIndex = getActualRoleIndex(rolesData, currentRankID);
  const isHR = isHRRole(allRolesDB, rolesData, actualIndex);
  const expectedRoleObj = rolesData[expectedIndex];

  if (!isHR && expectedIndex !== actualIndex && expectedRoleObj) {
    if (channel) {
      const username = rblxUsername || await rbx.getUsernameFromId(userID).catch(() => String(userID));
      if (expectedIndex > actualIndex) {
        const oldRankName = rolesData[actualIndex] ? rolesData[actualIndex].name : 'Unknown';
        await channel.send(theme.buildPromotionEmbed({ rblxUsername: username, userID, oldRankName, newRankName: expectedRoleObj.name, newXP }));
      } else {
        const reqXP = allRolesDB[rolesData[actualIndex].rank] ? allRolesDB[rolesData[actualIndex].rank].requiredXP : 0;
        await channel.send(theme.buildDemotionEmbed({ rblxUsername: username, userID, currentRankName: rolesData[actualIndex].name, requiredXP: reqXP, newXP }));
      }
    }
    if (groupFunction) {
      await groupFunction.updateMember(Number(userID), expectedRoleObj.id)
        .catch(e => console.error(`[RankSync] Could not update ${userID}: ${e.message}`));
    }
  }

  return expectedRoleObj;
};

/* ─── IN-MEMORY RATE LIMIT MAP ────────────────────────────────────────────── */
// Key: `${officerDiscordId}_${targetRobloxId}` → timestamp of last grant
const xpCooldowns = new Map();
const XP_COOLDOWN_MS = 30 * 1000; // 30 seconds

/* ─── ERROR HANDLERS ──────────────────────────────────────────────────────── */
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

/* ─── BACKGROUND JOBS ─────────────────────────────────────────────────────── */

// Lock cleanup every hour
setInterval(cleanupExpiredLocks, 60 * 60 * 1000);

// XP ↔ Rank reconciliation every 30 minutes
setInterval(async () => {
  console.log('[Reconcile] Starting XP ↔ Rank reconciliation...');
  try {
    const snapshot = await firebase.database().ref('xpData/users').once('value');
    const allUsers = snapshot.val() || {};
    const rolesData = await getCachedGroupRoles(config.groupID);
    const allRolesDB = await getCachedRolesDB(getFirebaseData);
    const groupFunction = await bloxyClient.getGroup(config.groupID).catch(() => null);

    let fixed = 0;
    for (const [userID, data] of Object.entries(allUsers)) {
      try {
        const xp = Number(data.xpValue);
        const currentRankID = await rbx.getRankInGroup(config.groupID, userID);
        if (currentRankID <= 0 || currentRankID >= 255) continue;

        const expectedIndex = getExpectedRoleIndex(rolesData, allRolesDB, xp);
        const actualIndex = getActualRoleIndex(rolesData, currentRankID);
        const isHR = isHRRole(allRolesDB, rolesData, actualIndex);

        if (!isHR && expectedIndex !== actualIndex) {
          const targetRole = rolesData[expectedIndex];
          if (groupFunction && targetRole) {
            await groupFunction.updateMember(Number(userID), targetRole.id)
              .catch(e => console.error(`[Reconcile] Failed for ${userID}: ${e.message}`));
            await writeAuditLog({
              userId: userID, username: String(userID), delta: 0, newTotal: xp,
              reason: 'reconcile_rank_fix',
              actorId: 'system', actorTag: 'AutoReconcile', channelId: 'system'
            });
            console.log(`[Reconcile] Fixed ${userID}: ${rolesData[actualIndex]?.name} → ${targetRole.name}`);
            fixed++;
          }
        }
      } catch (err) {
        console.error(`[Reconcile] Error processing user ${userID}:`, err.message);
      }
    }
    console.log(`[Reconcile] Done. Fixed ${fixed} user(s).`);
  } catch (err) {
    console.error('[Reconcile] Job failed:', err.message);
  }
}, 30 * 60 * 1000);

/* ─── BOT EVENTS ──────────────────────────────────────────────────────────── */

bot.on('ready', () => {
  console.log('Turned on Discord bot');
  bot.user.setActivity(`${bot.users.size} comrades!`, { type: 'WATCHING' });
  const mainChannel = bot.channels.get(config.mainChatChannelID);
  if (mainChannel) mainChannel.send(`**Resuming processes!** :wave:`);
})

bot.on('message', async message => {
  try {
    if (message.author.bot) return;
    if (!message.guild || message.channel.type === "dm") return;

    const args = message.content.split(/[ ]+/)
    const verifiedRole = message.guild.roles.find(role => role.name === "Verified");
    const verificationCode = ['apple', 'rain', 'dog', 'cat', 'food','yum','pizza','raindrop','snow','birthday','cake','burger','soda','ice','no','yes','orange','pear','plum'];
    const promoLogs = bot.channels.get(config.xpAuditLogChannelID);
    const officerRole = message.guild.roles.find(role => role.name === `${config.officerRole}`);

  /* ─── !verify ─────────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}verify`)){

    const botMember = message.guild.members.get(bot.user.id);
    if (!botMember.hasPermission("MANAGE_ROLES")){
      return message.channel.send(`Sorry ${message.author}, but I don't have permissions to manage roles.\n**Please give me the Manage Roles permission and ensure my role is above the Verified role.**`);
    }

    if (!botMember.hasPermission("MANAGE_NICKNAMES")){
      return message.channel.send(`Sorry ${message.author}, but I don't have permissions to manage nicknames.\n**Please contact someone to change my permissions so I can manage nicknames!**`);
    }

    if (!botMember.hasPermission("CHANGE_NICKNAME")){
      return message.channel.send(`Sorry ${message.author}, but I don't have permissions to change nicknames.\n**Please contact someone to change my permissions so I can change nicknames!**`);
    }

    if (!verifiedRole){
      return message.channel.send(`Sorry ${message.author}, but this guild is missing the \`Verified\` role!\n**Please contact someone to add the role!**`);
    }

    if (botMember.highestRole.position <= verifiedRole.position){
      return message.channel.send(`Sorry ${message.author}, but my role is not above the \`Verified\` role.\n**Move my role higher than Verified in the role settings and try again.**`);
    }

    if (botMember.highestRole.position <= message.member.highestRole.position){
      return message.channel.send(`Sorry ${message.author}, but my role is not above your highest role.\n**Move my role higher in the role settings so I can assign Verified and change your nickname.**`);
    }

    if (message.member.roles.some(role => role.name === "Verified")){
      return message.channel.send(`Sorry ${message.author}, but you're already verified!`);
    }

    if (!args[1]){
      return message.channel.send(`Sorry ${message.author}, but you need to provide me with a ROBLOX username.`);
    }

    const robloxUser = await getRobloxUserByUsername(args[1]);
    if (!robloxUser){
      return message.channel.send(`Sorry ${message.author}, but could you please provide me with a real ROBLOX username?`);
    }
    const body = robloxUser;

    var verificationPart1 = verificationCode[Math.floor(Math.random() * verificationCode.length)];
    var verificationPart2 = verificationCode[Math.floor(Math.random() * verificationCode.length)];
    var verificationPart3 = verificationCode[Math.floor(Math.random() * verificationCode.length)];
    var verificationPart4 = verificationCode[Math.floor(Math.random() * verificationCode.length)];

    const statusCode = [`RBLX-${verificationPart1} ${verificationPart2} ${verificationPart3} ${verificationPart4}`]
    const token = statusCode[Math.floor(Math.random() * statusCode.length)];

    const goodMessage = new Discord.RichEmbed()
    .setColor(0x3eff97)
    .setTitle(`Verification`)
    .setDescription(`Profile: https://web.roblox.com/users/${body.id}/profile\n\nReplace your current status with: **${token}**\n\n\n` + "**Chat `done` in __here__ to me when you've changed your status successfully!**")

    const sentMessage = await message.author.send(goodMessage).catch(() => null);
    if (!sentMessage) {
      return message.channel.send(`Sorry ${message.author}, but I couldn't direct message you!`);
    }
    const timeCollectionThing = { max: 1, time: 300000, errors: ['time'] };
    const collected = await sentMessage.channel.awaitMessages(response => response.author.id === message.author.id && response.content === 'done', timeCollectionThing).catch(() => null);
    if (!collected) {
      return message.channel.send(`Sorry ${message.author}, but I've waited patiently for five minutes and you haven't chatted **\`done\`**--I've cancelled the verification process.`);
    }
    const userId = await rbx.getIdFromUsername(args[1]);
    const blurb = await rbx.getBlurb(userId);
    const nicknames2 = await rbx.getUsernameFromId(userId);
    const firstCheck = await rbx.getRankInGroup(config.groupID, userId)

    if (blurb && blurb.includes(token)){
      try {
        await message.member.addRole(verifiedRole).catch(e => {
            if (String(e.code) !== "50013" && (!e.message || !e.message.includes("Missing Permissions"))) throw e;
        });
        await message.member.setNickname(`${firstCheck} | ${nicknames2}`).catch(e => {
            if (String(e.code) !== "50013" && (!e.message || !e.message.includes("Missing Permissions"))) throw e;
        });
        return message.author.send(`${config.welcomeMessage}`)
      } catch (permissionError) {
        console.error('Verification permission error:', permissionError);
        return message.channel.send(`Sorry ${message.author}, I couldn't complete full verification due to Discord permissions, but the process has finished.\n**Please make sure my role is above the Verified role and above your highest role.**`);
      }
    }else{
      return message.channel.send(`Sorry ${message.author}, but I couldn't find the code on your blurb or status.`);
    }
    return message.channel.send(`I should never run into this last message.\n**If I do, you fucked up somewhere in the code.**`)
  }

  /* ─── !xp ─────────────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}xp `)){
    if (!message.member.roles.some(role => role.name === `${config.officerRole}`)){
      return message.channel.send(`Sorry ${message.author}, but only users with the **\`${config.officerRole}\`** can run that command!`);
    }
    const groupFunction = await bloxyClient.getGroup(config.groupID)
    if (!args[1]){
      return message.channel.send(`Sorry ${message.author}, but you're missing the first argument--add or remove?\n**Adding XP: \`${config.prefix}xp add 1 username1, username2, username3...\`\nRemoving XP: \`${config.prefix}xp remove 1 username1, username2, username3...\`**`);
    }else if (args[1].toLowerCase() !== "add" && args[1].toLowerCase() !== "remove"){
      return message.channel.send(`Sorry ${message.author}, but you didn't provide me with a correct first argument--add or remove?\n**Adding XP: \`${config.prefix}xp add 1 username1, username2, username3...\`\nRemoving XP: \`${config.prefix}xp remove 1 username1, username2, username3...\`**`);
    }else{
      if (!args[2]){
        return message.channel.send(`Sorry ${message.author}, but you're missing the second argument--number of XP?\n**Adding XP: \`${config.prefix}xp add 1 username1, username2, username3...\`\nRemoving XP: \`${config.prefix}xp remove 1 username1, username2, username3...\`**`);
      }else if (isNaN(Number(args[2]))){
        return message.channel.send(`Sorry ${message.author}, but you didn't provide me with a real number.\n**Adding XP: \`${config.prefix}xp add 1 username1, username2, username3...\`\nRemoving XP: \`${config.prefix}xp remove 1 username1, username2, username3...\`**`);
      }else if (args[2] < 0){
        return message.channel.send(`Sorry ${message.author}, but you need to provide me with a positive number.\n**Adding XP: \`${config.prefix}xp add 1 username1, username2, username3...\`\nRemoving XP: \`${config.prefix}xp remove 1 username1, username2, username3...\`**`);
      }else if (args[2] > config.maxXP){
        return message.channel.send(`Sorry ${message.author}, but you need to provide me with a number that's less than the max XP--currently set at ${config.maxXP} XP.\n**Adding XP: \`${config.prefix}xp add 1 username1, username2, username3...\`\nRemoving XP: \`${config.prefix}xp remove 1 username1, username2, username3...\`**`);
      }else if (!args[3]){
        return message.channel.send(`Sorry ${message.author}, but you're missing the third argument--the usernames!\n**Adding XP: \`${config.prefix}xp add 1 username1, username2 | reason\`\nRemoving XP: \`${config.prefix}xp remove 1 username1, username2 | reason\`**`);
      }else{
        // Parse optional reason: everything after '|' (e.g. !xp add 5 user1, user2 | Active event)
        const rawBody = message.content.slice(message.content.indexOf(message.content.split(' ')[3]));
        const pipeIndex = rawBody.indexOf('|');
        const usernamesPart = pipeIndex !== -1 ? rawBody.slice(0, pipeIndex) : rawBody;
        const grantReason = pipeIndex !== -1 ? rawBody.slice(pipeIndex + 1).trim() : null;

        // Sanitize username array: trim whitespace, filter empty strings
        const userArray = usernamesPart
          .split(',')
          .map(u => u.trim())
          .filter(u => u.length > 0);

        const rolesData = await getCachedGroupRoles(config.groupID);
        const allRolesDB = await getCachedRolesDB(getFirebaseData);

        if (args[1].toLowerCase() === "add"){
          const addAmount = Number(args[2]);

          for (let i = 0; i < userArray.length; i++){
            const robloxUser = await getRobloxUserByUsername(userArray[i]);
            if (!robloxUser){
              const errorEmbed = new Discord.RichEmbed()
                .setColor(0xff4040)
                .setDescription(`:warning: **${userArray[i]} doesn't exist on ROBLOX** :warning:`);
              await message.channel.send(errorEmbed);
              continue;
            }

            const userID = robloxUser.id;
            const rblxUsername = robloxUser.name;

            // ── Idempotency: prevent double-grant from retries / duplicate calls
            const lockAcquired = await acquireGrantLock(message.id, userID);
            if (!lockAcquired) {
              await message.channel.send(`⚠️ XP for **${rblxUsername}** from this command was already processed. Skipping.`);
              continue;
            }

            // ── Per-officer cooldown (30s per officer per target)
            const cooldownKey = `${message.author.id}_${userID}`;
            const lastGrant = xpCooldowns.get(cooldownKey) || 0;
            if (Date.now() - lastGrant < XP_COOLDOWN_MS) {
              const remaining = Math.ceil((XP_COOLDOWN_MS - (Date.now() - lastGrant)) / 1000);
              await message.channel.send(`⚠️ Please wait **${remaining}s** before granting XP to **${rblxUsername}** again.`);
              continue;
            }

            // ── Daily XP cap check
            const capCheck = await checkDailyCap(userID, addAmount);
            if (!capCheck.allowed) {
              await message.channel.send(`⚠️ **${rblxUsername}** has reached the daily XP cap of **${capCheck.cap} XP** (currently at **${capCheck.current} XP** today). They can only receive **${capCheck.remaining} more XP** today.`);
              continue;
            }

            // ── Atomic XP update (transaction — race-condition safe)
            const newXP = await atomicXPUpdate(userID, addAmount);

            // ── Record daily tally and cooldown
            await recordDailyXP(userID, addAmount);
            xpCooldowns.set(cooldownKey, Date.now());

            // ── Resolve next rank info for the XP embed progress bar
            const rolesDataForEmbed = await getCachedGroupRoles(config.groupID).catch(() => []);
            const allRolesDBForEmbed = await getCachedRolesDB(getFirebaseData).catch(() => ({}));
            const expectedIdxForEmbed = getExpectedRoleIndex(rolesDataForEmbed, allRolesDBForEmbed, newXP);
            const nextRankObjForEmbed = getNextRankObj(rolesDataForEmbed, allRolesDBForEmbed, expectedIdxForEmbed);

            // ── Discord confirmation embed (themed)
            await message.channel.send(theme.buildXPAddedEmbed({
              rblxUsername, userID, addAmount, newXP,
              reason: grantReason || 'Officer grant',
              officerTag: message.author.tag,
              nextRankName: nextRankObjForEmbed ? nextRankObjForEmbed.name : 'Max Rank',
              nextRankXP: nextRankObjForEmbed && allRolesDBForEmbed[nextRankObjForEmbed.rank]
                ? Number(allRolesDBForEmbed[nextRankObjForEmbed.rank].requiredXP) : 0
            }));

            // ── Structured Firebase audit log
            await writeAuditLog({
              userId: userID, username: rblxUsername, delta: addAmount, newTotal: newXP,
              reason: grantReason || 'xp_add', actorId: message.author.id, actorTag: message.author.tag,
              channelId: message.channel.id
            });

            // ── Discord embed audit log (themed)
            if (promoLogs) promoLogs.send(theme.buildAuditEmbed({
              action: 'XP Added', rblxUsername, userID, delta: addAmount, newTotal: newXP,
              reason: grantReason || 'Officer grant',
              actorTag: message.author.tag, channelId: message.channel.id
            }));

            // ── Roblox rank sync
            await syncRobloxRank({ userID, newXP, rolesData, allRolesDB, groupFunction, channel: message.channel, rblxUsername });
          }

        }else{
          const removeAmount = Number(args[2]);

          for (let i = 0; i < userArray.length; i++){
            const robloxUser = await getRobloxUserByUsername(userArray[i]);
            if (!robloxUser){
              const errorEmbed = new Discord.RichEmbed()
                .setColor(0xff4040)
                .setDescription(`:warning: **${userArray[i]} doesn't exist on ROBLOX** :warning:`);
              await message.channel.send(errorEmbed);
              continue;
            }

            const userID = robloxUser.id;
            const rblxUsername = robloxUser.name;

            // ── Idempotency lock
            const lockAcquired = await acquireGrantLock(message.id, userID);
            if (!lockAcquired) {
              await message.channel.send(`⚠️ XP removal for **${rblxUsername}** from this command was already processed. Skipping.`);
              continue;
            }

            // ── Atomic XP update (floor at 0)
            const newXP = await atomicXPUpdate(userID, -removeAmount, 0);

            // ── Discord confirmation embed (themed)
            await message.channel.send(theme.buildXPRemovedEmbed({
              rblxUsername, removeAmount, newXP,
              reason: grantReason || 'Officer adjustment',
              officerTag: message.author.tag
            }));

            // ── Structured Firebase audit log
            await writeAuditLog({
              userId: userID, username: rblxUsername, delta: -removeAmount, newTotal: newXP,
              reason: grantReason || 'xp_remove', actorId: message.author.id, actorTag: message.author.tag,
              channelId: message.channel.id
            });

            // ── Discord embed audit log (themed)
            if (promoLogs) promoLogs.send(theme.buildAuditEmbed({
              action: 'XP Removed', rblxUsername, userID, delta: -removeAmount, newTotal: newXP,
              reason: grantReason || 'Officer adjustment',
              actorTag: message.author.tag, channelId: message.channel.id
            }));

            // ── Roblox rank sync (may demote if XP dropped below threshold)
            await syncRobloxRank({ userID, newXP, rolesData, allRolesDB, groupFunction, channel: message.channel, rblxUsername });
          }
        }
      }
    }
  }

  /* ─── !setup ───────────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}setup`)){
    if (message.author.id !== message.guild.owner.id){
      return message.channel.send(`Sorry ${message.author}, but only the guild owner (${message.guild.owner}) can run that command!`);
    }
    if (config.groupID === 0){
      return message.channel.send(`Sorry ${message.author}, but I'm missing the group's ID--which can be entered in the config.json file.`);
    }
    var {body} = await snekfetch.get(`https://groups.roblox.com/v1/groups/${config.groupID}`)
    if (body.errors){
      return message.channel.send(`Sorry ${message.author}, but you provided me with an invalid group ID in the config.json file.`);
    }
    await message.channel.send(`Pulling information from **${body.name}** (\`${body.id}\``);
    var {body} = await snekfetch.get(`https://groups.roblox.com/v1/groups/${config.groupID}/roles`)
    var roles = [];
    var xpData = [];
    for (let i = 1; i < body.roles.length; i++){
      if (body.roles[1].rank === body.roles[i].rank){
        firebase.database().ref(`roles/${body.roles[i].rank}`).set({
          requiredXP: 0
        })
      }else if (body.roles[body.roles.length-1].rank === body.roles[i].rank){
        firebase.database().ref(`roles/${body.roles[i].rank}`).set({
          requiredXP: 0
        })
      }else{
        const promptMessage = await message.channel.send(`How many XP should be required to achieve the rank of **\`${body.roles[i].name}\`**? (Chat \`lock\` to lock this rank)`).catch(() => null);
        if (!promptMessage) {
            return message.channel.send(`Sorry ${message.author}, but I couldn't message this channel.\nSetup abandoned.`);
        }

        const timeCollectionThing = { max: 1, time: 30000, errors: ['time'] };
        const collected = await message.channel.awaitMessages(response => message.author.id === response.author.id, timeCollectionThing).catch(() => null);
        if (!collected) {
            return message.channel.send(`Sorry ${message.author}, but you took too long to respond. Setup has been cancelled.`);
        }

        var responseArray1 = collected.map(m => m.content);
        if (responseArray1[0].toLowerCase() === 'lock'){
          firebase.database().ref(`roles/${body.roles[i].rank}`).set({
            requiredXP: 0
          })
          xpData.push('Locked');
          await message.channel.send(`Awesome, I've locked the rank of **\`${body.roles[i].name}\`** from XP promotions!`)
        }else if (isNaN(Number(responseArray1[0]))){
          return message.channel.send(`Sorry ${message.author}, but you didn't provide me with a real number.  I've cancelled the setup process.`)
        }else if (Number(responseArray1[0]) < 0){
          return message.channel.send(`Sorry ${message.author}, but you provided me with a negative number.  I've cancelled the setup process.`)
        }else{
          let lastNumericXP = 0;
          for (let k = xpData.length - 1; k >= 0; k--) {
            if (xpData[k] !== 'Locked') {
              lastNumericXP = Number(xpData[k]);
              break;
            }
          }
          if (Number(responseArray1[0]) <= lastNumericXP && Number(responseArray1[0]) !== 0) {
            return message.channel.send(`Sorry ${message.author}, but you provided me with a number that was either less than or equal to the required XP for the previous numeric rank--the logic **will not** work if continued. I've cancelled the setup process.`)
          } else {
            firebase.database().ref(`roles/${body.roles[i].rank}`).set({
              requiredXP: Number(responseArray1[0])
            })
            xpData.push(Number(responseArray1[0]));
            await message.channel.send(`Awesome, I've set the required XP to achieve the rank of **\`${body.roles[i].name}\`** @ **${responseArray1[0]}**!`)
          }
        }
      }
    }
    console.log(xpData);
    // Invalidate caches so next command picks up new thresholds
    invalidateCache();
    const finallyDone = new Discord.RichEmbed()
      .setColor(0x4aff98)
      .setTitle(`**XP Requirements**`)
    for (let i = 1; i < body.roles.length; i++){
      if (body.roles[1].rank === body.roles[i].rank){
        finallyDone.addField(`:lock: **\`${body.roles[i].name} | ${body.roles[i].rank} | ${body.roles[i].id}\`**`, `0 XP`, true)
      }else if (body.roles[body.roles.length-1].rank === body.roles[i].rank){
          finallyDone.addField(`:lock: **\`${body.roles[i].name} | ${body.roles[i].rank} | ${body.roles[i].id}\`**`, `0 XP`, true)
      }else{
          let xpValue = xpData[0];
          if (xpValue === 'Locked') {
            finallyDone.addField(`:lock: **\`${body.roles[i].name} | ${body.roles[i].rank} | ${body.roles[i].id}\`**`, `Locked`, true)
          } else {
            finallyDone.addField(`**\`${body.roles[i].name} | ${body.roles[i].rank} | ${body.roles[i].id}\`**`, `${xpValue} XP`, true)
          }
          xpData.shift()
      }
    }
    return message.reply(finallyDone);
  }

  /* ─── !view ────────────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}view`)){
    if (!args[1]){
      return message.channel.send(theme.buildNotFoundEmbed(`You must provide a username. Usage: \`${config.prefix}view username\``));
    }

    const robloxUser = await getRobloxUserByUsername(args[1]);
    if (!robloxUser){
      return message.channel.send(theme.buildNotFoundEmbed(`Could not find Roblox user **${args[1]}**. Check the username and try again.`));
    }
    const userID = robloxUser.id;

    const { body: thumbBody } = await snekfetch.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userID}&size=150x150&format=Png&isCircular=false`);
    const mugShot = thumbBody.data && thumbBody.data.length > 0 ? thumbBody.data[0].imageUrl : null;

    const dbData = await getFirebaseData(`xpData/users/${userID}`);
    if (!dbData){
      return message.channel.send(theme.buildNotFoundEmbed(`**${robloxUser.name}** is not registered in the database yet.`));
    }

    const currentXP = Number(dbData.xpValue || 0);
    const currentRankID = await rbx.getRankInGroup(config.groupID, userID);
    const rolesData = await getCachedGroupRoles(config.groupID);
    const allRolesDB = await getCachedRolesDB(getFirebaseData);

    let currentRankName = 'Guest';
    let nextRankName = `Join Group`;
    let nextRankXP = 0;

    if ((0 < currentRankID) && (currentRankID < 255)){
      const expectedRankIndex = getExpectedRoleIndex(rolesData, allRolesDB, currentXP);
      const actualRankIndex = getActualRoleIndex(rolesData, currentRankID);
      const targetRankIndex = Math.max(expectedRankIndex, actualRankIndex);
      currentRankName = rolesData[targetRankIndex] ? rolesData[targetRankIndex].name : rolesData[1].name;
      const nextRankObj = getNextRankObj(rolesData, allRolesDB, targetRankIndex);
      nextRankName = nextRankObj ? nextRankObj.name : 'Max Rank';
      const nextRankNumber = nextRankObj ? nextRankObj.rank : null;
      nextRankXP = nextRankNumber && allRolesDB[nextRankNumber] ? Number(allRolesDB[nextRankNumber].requiredXP) : 0;
    } else if (currentRankID === 255) {
      currentRankName = await rbx.getRankNameInGroup(config.groupID, userID);
      nextRankName = 'Max Rank';
      nextRankXP = 0;
    }

    return message.reply(theme.buildProfileEmbed({
      rblxUsername: robloxUser.name, userID, avatarURL: mugShot,
      currentRankName, currentXP, nextRankName, nextRankXP
    }));
  }

  /* ─── !leaderboard ─────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}leaderboard`)){
    let leaderboardData = getCachedLeaderboard();

    if (!leaderboardData) {
      const snap = await firebase.database().ref('xpData/users').once('value');
      const allUsers = snap.val() || {};
      leaderboardData = Object.entries(allUsers)
        .map(([id, d]) => ({ id, xp: Number(d.xpValue) }))
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 10);
      setLeaderboardCache(leaderboardData);
    }

    if (leaderboardData.length === 0) {
      return message.channel.send(theme.buildNotFoundEmbed('No users are registered in the database yet.'));
    }

    // Resolve Roblox usernames, and try to match the requester's Roblox ID from nickname
    let requesterRobloxId = null;
    if (message.member.nickname) {
      const nickMatch = message.member.nickname.match(/\(\s*(\S+)\s*\)/);
      if (nickMatch) {
        const ru = await getRobloxUserByUsername(nickMatch[1]).catch(() => null);
        if (ru) requesterRobloxId = String(ru.id);
      }
    }

    const entries = await Promise.all(leaderboardData.map(async (entry) => {
      const name = await rbx.getUsernameFromId(entry.id).catch(() => `ID: ${entry.id}`);
      return { id: String(entry.id), name, xp: entry.xp };
    }));

    return message.channel.send(theme.buildLeaderboardEmbed({ entries, highlightId: requesterRobloxId }));
  }

  /* ─── !register ────────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}register`)){
    if (!message.member.roles.some(role => role.name === `${config.officerRole}`)){
      return message.channel.send(`Sorry ${message.author}, but only users with the **\`${config.officerRole}\`** can run that command!`);
    }

    if (!args[1]){
      return message.channel.send(`Sorry ${message.author}, but you're missing the first argument--the Roblox ID!\n**\`${config.prefix}register 1234567\`**`);
    }

    const userID = args[1];
    if (isNaN(Number(userID))){
      return message.channel.send(`Sorry ${message.author}, but you didn't provide me with a valid Roblox ID number.`);
    }

    try {
      const rblxUsername = await rbx.getUsernameFromId(Number(userID));
      if (!rblxUsername) {
        return message.channel.send(`Sorry ${message.author}, but I couldn't find a Roblox user with that ID.`);
      }

      const existingData = await getFirebaseData(`xpData/users/${userID}`);
      if (!existingData){
        await firebase.database().ref(`xpData/users/${userID}`).set({ xpValue: 0 });
        const embed = theme.applyFooter(
          new Discord.RichEmbed()
            .setColor(theme.COLORS.SUCCESS)
            .setAuthor(`✓ Registered — ${rblxUsername}`)
            .addField('👤 Roblox User', `[${rblxUsername}](https://www.roblox.com/users/${userID}/profile)`, true)
            .addField('🆔 Roblox ID', String(userID), true)
            .addField('📊 Starting XP', '0 XP', true)
        );
        await message.channel.send(embed);
      } else {
        const embed = theme.applyFooter(
          new Discord.RichEmbed()
            .setColor(theme.COLORS.WARNING)
            .setAuthor(`Already Registered — ${rblxUsername}`)
            .addField('👤 Roblox User', `[${rblxUsername}](https://www.roblox.com/users/${userID}/profile)`, true)
            .addField('📊 Current XP', `${theme.fmtXP(existingData.xpValue)} XP`, true)
        );
        await message.channel.send(embed);
      }
    } catch (err) {
      return message.channel.send(`Sorry ${message.author}, but that Roblox ID does not appear to exist.`);
    }
  }

  /* ─── !update ───────────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}update`)){
    // Officer-only gate
    if (!message.member.roles.some(role => role.name === `${config.officerRole}`)){
      return message.channel.send(`Sorry ${message.author}, but only users with the **\`${config.officerRole}\`** can run that command!`);
    }

    if (!args[1]){
      return message.channel.send(`Sorry ${message.author}, but you're missing the argument--the Roblox username or ID!\n**\`${config.prefix}update username/userid\`**`);
    }

    const searchTarget = args[1];
    let robloxUser, userID, rblxUsername;
    let targetMember;

    await message.guild.fetchMembers();

    if (!isNaN(Number(searchTarget)) && Number(searchTarget) > 1000) {
      userID = searchTarget;
      rblxUsername = await rbx.getUsernameFromId(Number(userID)).catch(() => null);
      if (!rblxUsername) {
        return message.channel.send(`Sorry ${message.author}, but I couldn't find a Roblox user with that ID.`);
      }
    } else {
      // Try to find a Discord member whose nickname or username partially matches
      targetMember = message.guild.members.find(m => {
          if (m.nickname && m.nickname.toLowerCase().includes(searchTarget.toLowerCase())) return true;
          if (m.user.username.toLowerCase().includes(searchTarget.toLowerCase())) return true;
          return false;
      });

      if (targetMember) {
          let extractedName = "";
          // Extract Roblox username from 'Rank | DiscordUser ( RobloxUser )' format
          if (targetMember.nickname && targetMember.nickname.includes('(') && targetMember.nickname.includes(')')) {
              extractedName = targetMember.nickname.split('(')[1].split(')')[0].trim();
          } else if (targetMember.nickname && targetMember.nickname.includes('|')) {
              extractedName = targetMember.nickname.split('|')[1].trim();
          } else {
              extractedName = targetMember.nickname || targetMember.user.username;
          }
          robloxUser = await getRobloxUserByUsername(extractedName);
          if (!robloxUser) robloxUser = await getRobloxUserByUsername(searchTarget);
      } else {
          robloxUser = await getRobloxUserByUsername(searchTarget);
      }

      if (!robloxUser){
        return message.channel.send(`Sorry ${message.author}, but I couldn't find that ROBLOX username or a matching Discord member.`);
      }
      userID = robloxUser.id;
      rblxUsername = robloxUser.name;
    }

    // Find Discord member if not found yet using the confirmed Roblox username
    if (!targetMember) {
      targetMember = message.guild.members.find(m => {
          if (m.nickname && m.nickname.toLowerCase().includes(rblxUsername.toLowerCase())) return true;
          if (m.user.username.toLowerCase() === rblxUsername.toLowerCase()) return true;
          return false;
      });
    }

    if (!targetMember) {
      return message.channel.send(`Sorry ${message.author}, but I couldn't find a Discord member matching the Roblox user **${rblxUsername}** in this server.`);
    }

    const dbData = await getFirebaseData(`xpData/users/${userID}`);
    const currentXP = dbData ? Number(dbData.xpValue) : 0;

    const rolesData = await getCachedGroupRoles(config.groupID);
    const allRolesDB = await getCachedRolesDB(getFirebaseData);

    const expectedIndex = getExpectedRoleIndex(rolesData, allRolesDB, currentXP);
    const currentRankID = await rbx.getRankInGroup(config.groupID, userID);
    const expectedRoleObj = rolesData[expectedIndex];

    if (!expectedRoleObj) {
      return message.channel.send(`Sorry, there was an error parsing the roles for ${rblxUsername}.`);
    }

    const actualIndex = getActualRoleIndex(rolesData, currentRankID);
    const isHR = isHRRole(allRolesDB, rolesData, actualIndex);

    // Correct Roblox group rank if mismatched and not an HR
    if (currentRankID > 0 && currentRankID < 255 && !isHR && expectedIndex !== actualIndex) {
      const groupFunction = await bloxyClient.getGroup(config.groupID).catch(() => null);
      if (groupFunction) {
         await groupFunction.updateMember(Number(userID), expectedRoleObj.id).catch(() => null);
      }
    }

    // Find the target Discord role by matching Roblox rank name
    const targetDiscordRole = message.guild.roles.find(r => r.name.toLowerCase() === expectedRoleObj.name.toLowerCase());

    if (!targetDiscordRole) {
      return message.channel.send(theme.buildSyncPartialEmbed({
        rblxUsername, rankName: expectedRoleObj.name, currentXP,
        reason: `No Discord role named **"${expectedRoleObj.name}"** exists in this server.`
      }));
    }

    try {
      // Build a set of all Discord role IDs that correspond to Roblox rank names
      // Using ID-based cleanup prevents stacking when roles are renamed
      const rankRoleIds = new Set(
        rolesData
          .map(r => message.guild.roles.find(dr => dr.name.toLowerCase() === r.name.toLowerCase()))
          .filter(Boolean)
          .map(r => r.id)
      );

      // Remove all rank roles that are NOT the target
      for (const [, role] of targetMember.roles) {
        if (rankRoleIds.has(role.id) && role.id !== targetDiscordRole.id) {
          await targetMember.removeRole(role).catch(() => {});
        }
      }

      await targetMember.addRole(targetDiscordRole).catch(() => {});

      // Format: Rank | DiscordUsername ( RobloxUsername )
      let newNickname = `${expectedRoleObj.name} | ${targetMember.user.username} ( ${rblxUsername} )`;
      if (newNickname.length > 32) {
          newNickname = `${expectedRoleObj.name} | ( ${rblxUsername} )`;
          if (newNickname.length > 32) {
              newNickname = `${expectedRoleObj.name.substring(0, 10)} | ${rblxUsername.substring(0, 15)}`;
          }
      }
      await targetMember.setNickname(newNickname).catch(() => {});

      return message.channel.send(theme.buildSyncEmbed({
        targetMember, rblxUsername, currentXP, rankName: expectedRoleObj.name, newNickname
      }));
    } catch (e) {
      console.error(e);
      return message.channel.send(theme.buildErrorEmbed(`I encountered an issue syncing roles or nicknames. Ensure my bot role is above the rank roles in the server hierarchy.`));
    }
  }

  /* ─── !avatar ───────────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}avatar`)){
    if (!args[1]){
      return message.channel.send(`Sorry ${message.author}, but you're missing the argument--the Roblox username or ID!\n**\`${config.prefix}avatar username/userid\`**`);
    }
    const searchTarget = args[1];
    let robloxUser, userID, rblxUsername;

    if (!isNaN(Number(searchTarget)) && Number(searchTarget) > 1000) {
      userID = searchTarget;
      rblxUsername = await rbx.getUsernameFromId(Number(userID)).catch(() => null);
      if (!rblxUsername) {
        return message.channel.send(`Sorry ${message.author}, but I couldn't find a Roblox user with that ID.`);
      }
    } else {
      robloxUser = await getRobloxUserByUsername(searchTarget);
      if (!robloxUser){
        return message.channel.send(`Sorry ${message.author}, but I couldn't find that ROBLOX username.`);
      }
      userID = robloxUser.id;
      rblxUsername = robloxUser.name;
    }

    try {
      const { body: avatarBody } = await snekfetch.get(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userID}&size=420x420&format=Png&isCircular=false`);
      const avatarImage = avatarBody.data && avatarBody.data.length > 0 ? avatarBody.data[0].imageUrl : "https://t0.rbxcdn.com/2ce8c5a24285b4f2c90c0ef497c23ae6";

      const blurb = await rbx.getBlurb(userID).catch(() => "No bio available.");

      const embed = new Discord.RichEmbed()
        .setColor(0x00a8ff)
        .setTitle(`Roblox Profile: ${rblxUsername}`)
        .setURL(`https://www.roblox.com/users/${userID}/profile`)
        .setImage(avatarImage)
        .addField("Username", rblxUsername, true)
        .addField("User ID", userID, true)
        .addField("Bio", blurb ? blurb : "No bio available.");

      return message.channel.send(embed);
    } catch (e) {
      console.error(e);
      return message.channel.send(`Sorry ${message.author}, I encountered an error fetching this user's profile.`);
    }
  }

  /* ─── !commands ─────────────────────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}commands`)){
    const first = theme.applyFooter(new Discord.RichEmbed()
      .setColor(theme.COLORS.PROFILE)
      .setAuthor('\ud83d\udcd6 SEELE Guild \u2014 Command Reference')
      .setTitle('Member Commands')
      .setDescription('The following commands are available to *everyone*.')
      .addField(`\`${config.prefix}verify\``, `Link your Roblox account to Discord via blurb verification.`)
      .addField(`\`${config.prefix}view <username>\``, `View an in-depth XP profile for a Roblox user.`)
      .addField(`\`${config.prefix}leaderboard\``, `View the Top 10 members by XP. Cached every 5 minutes.`)
      .addField(`\`${config.prefix}avatar <username>\``, `Retrieve a Roblox user's avatar and profile info.`)
      .addField(`\`${config.prefix}xpsources\``, `See all the ways to earn XP in SEELE.`)
      .addField(`\`${config.prefix}commands\``, `Display this command reference.`)
    );
    await message.channel.send(first);

    const second = theme.applyFooter(new Discord.RichEmbed()
      .setColor(theme.COLORS.AUDIT)
      .setTitle('Officer Commands')
      .setDescription(`Restricted to members with the **${config.officerRole}** role.`)
      .addField(`\`${config.prefix}xp add <amount> <user1>, <user2> | <reason>\``,
        `Grants XP to one or more users. The \`| reason\` part is optional but recommended (e.g. \`| Active event participation\`).`)
      .addField(`\`${config.prefix}xp remove <amount> <user1>, <user2> | <reason>\``,
        `Removes XP from one or more users. The \`| reason\` explains why.`)
      .addField(`\`${config.prefix}register <robloxid>\``, `Register a Roblox user in the XP database by their Roblox user ID.`)
      .addField(`\`${config.prefix}update <username>\``, `Sync a member's Discord role, Roblox group rank, and nickname based on their XP.`)
    );
    await message.channel.send(second);

    const third = theme.applyFooter(new Discord.RichEmbed()
      .setColor(theme.COLORS.SYSTEM)
      .setTitle('Owner Commands')
      .setDescription('Restricted to the server owner.')
      .addField(`\`${config.prefix}setup\``, `Configure XP thresholds for each Roblox group rank. Run this once after adding new ranks.`)
    );
    return message.channel.send(third);
  }

  /* ─── !xpsources / !howtolevel ──────────────────────────────────────────── */
  if (
    message.content.toLowerCase().startsWith(`${config.prefix}xpsources`) ||
    message.content.toLowerCase().startsWith(`${config.prefix}howtolevel`)
  ){
    const xpGuide = new Discord.RichEmbed()
      .setColor(0x7c4dff)
      .setAuthor('\u26a1 SEELE Guild \u2014 How to Earn XP')
      .setTitle('XP Sources Guide')
      .setDescription(
        'XP is granted by officers based on your participation and contribution to the guild.\n' +
        'The more active and involved you are, the faster you climb the ranks.\n\u200B'
      )
      .addField(
        '\u2694\ufe0f\u2002 Wars & Scrimmages',
        '\u2022 Participating in **official wars** earns XP based on performance.\n' +
        '\u2022 Attending **daily scrimmages** consistently is one of the most reliable ways to progress.\n' +
        '\u2022 Competitive effort is always recognized \u2014 playing hard matters.',
        false
      )
      .addField(
        '\ud83c\udf3e\u2002 Farming & Grind Sessions',
        '\u2022 Joining **organized farming sessions** hosted by officers earns XP.\n' +
        '\u2022 Dedicated grinders who show up regularly are rewarded for consistency.\n' +
        '\u2022 Solo grinding during announced sessions also counts.',
        false
      )
      .addField(
        '\ud83c\udf89\u2002 Guild Events & Raids',
        '\u2022 Special **guild events, raids, and challenges** offer bonus XP opportunities.\n' +
        '\u2022 Keep an eye on announcements \u2014 events may include **double XP periods**.\n' +
        '\u2022 Showing up and staying active during events is what gets you noticed.',
        false
      )
      .addField(
        '\ud83d\udcc5\u2002 Daily Activity & Consistency',
        '\u2022 Being consistently active day-to-day is rewarded over time.\n' +
        '\u2022 Officers notice members who show up regularly \u2014 loyalty is valued.\n' +
        '\u2022 Consistent attendance across multiple activities stacks your progress.',
        false
      )
      .addField(
        '\ud83e\udd1d\u2002 Community Contribution',
        '\u2022 Helping newer members, being a good team player, or showing leadership.\n' +
        '\u2022 Representing SEELE well in public matches and other servers.\n' +
        '\u2022 Going beyond the bare minimum \u2014 officers have discretion to reward effort.',
        false
      )
      .addField(
        '\ud83d\udeab\u2002 What Does NOT Earn XP',
        '\u2022 Spamming, idling, or inflating participation.\n' +
        "\u2022 Claiming XP for activity you didn't genuinely take part in.\n" +
        '\u2022 Attempting to game the system \u2014 offenders may have XP removed.',
        false
      )
      .addField(
        '\u200B',
        '**Track your progress anytime:**\n' +
        `\`${config.prefix}view <your roblox username>\` \u2014 See your rank, XP, and progress bar.\n` +
        `\`${config.prefix}leaderboard\` \u2014 Check where you stand against everyone else.`,
        false
      )
      .setFooter('Stay active. Stay consistent. The ranks are earned, not given. \u2022 SEELE Guild System')
      .setTimestamp();

    return message.channel.send(xpGuide);
  }

  /* ─── !code / !link / !tutorial ─────────────────────────────────────────── */
  if (message.content.toLowerCase().startsWith(`${config.prefix}code`) || message.content.toLowerCase().startsWith(`${config.prefix}link`) || message.content.toLowerCase().startsWith(`${config.prefix}tutorial`)){
    const embedA = new Discord.RichEmbed()
      .setColor(0xff3636)
      .setDescription(`**[Video Tutorial](https://www.google.com)**`)
    await message.channel.send(embedA)
    const embedB = new Discord.RichEmbed()
      .setColor(0x3072ff)
      .setDescription(`**[Source Code](https://www.github.com)**`)
    await message.channel.send(embedB)
    const embedC = new Discord.RichEmbed()
      .setColor(0x1cff8e)
      .setDescription(`This project was developed by [hysx2](https://www.roblox.com/users/3488853549/profile).\n__Made for SEELE.__`)
    return message.channel.send(embedC)
  }

  } catch (err) {
    console.error('Message handler error:', err);
    if (message && message.channel) {
      message.channel.send('Sorry, an internal error occurred while processing your command.').catch(() => null);
    }
  }
});


bot.login(config.bot_token)
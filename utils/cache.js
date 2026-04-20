/**
 * cache.js
 * Module-level TTL caches for expensive external data fetches.
 * Prevents redundant Roblox API calls and Firebase reads on every command.
 */

const snekfetch = require('snekfetch');

const ROLES_TTL_MS = 5 * 60 * 1000; // 5 minutes

let groupRolesCache = null;
let groupRolesCacheTime = 0;

let rolesDBCache = null;
let rolesDBCacheTime = 0;

let leaderboardCache = null;
let leaderboardCacheTime = 0;
const LEADERBOARD_TTL_MS = 5 * 60 * 1000;

/**
 * Returns the Roblox group roles array, using a local cache to avoid
 * hitting the API on every command. Cache expires after 5 minutes.
 *
 * @param {number|string} groupID
 * @returns {Promise<Array>} Array of Roblox role objects
 */
async function getCachedGroupRoles(groupID) {
  if (groupRolesCache && (Date.now() - groupRolesCacheTime < ROLES_TTL_MS)) {
    return groupRolesCache;
  }
  const api = await snekfetch.get(`https://groups.roblox.com/v1/groups/${groupID}/roles`);
  groupRolesCache = api.body.roles;
  groupRolesCacheTime = Date.now();
  return groupRolesCache;
}

/**
 * Returns the Firebase roles XP threshold object, using a local cache.
 * Cache expires after 5 minutes.
 *
 * @param {Function} getFirebaseData - The getFirebaseData helper from code.js
 * @returns {Promise<Object>} Firebase roles object keyed by rank number
 */
async function getCachedRolesDB(getFirebaseData) {
  if (rolesDBCache && (Date.now() - rolesDBCacheTime < ROLES_TTL_MS)) {
    return rolesDBCache;
  }
  rolesDBCache = await getFirebaseData('roles') || {};
  rolesDBCacheTime = Date.now();
  return rolesDBCache;
}

/**
 * Returns the cached leaderboard data (top users by XP).
 * Returns null if cache is stale so the caller knows to rebuild it.
 *
 * @returns {Array|null}
 */
function getCachedLeaderboard() {
  if (leaderboardCache && (Date.now() - leaderboardCacheTime < LEADERBOARD_TTL_MS)) {
    return leaderboardCache;
  }
  return null;
}

/**
 * Stores fresh leaderboard data in cache.
 * @param {Array} data
 */
function setLeaderboardCache(data) {
  leaderboardCache = data;
  leaderboardCacheTime = Date.now();
}

/**
 * Invalidates all caches. Call this after !setup completes so the next
 * command fetches fresh data.
 */
function invalidateCache() {
  groupRolesCache = null;
  groupRolesCacheTime = 0;
  rolesDBCache = null;
  rolesDBCacheTime = 0;
  leaderboardCache = null;
  leaderboardCacheTime = 0;
}

module.exports = {
  getCachedGroupRoles,
  getCachedRolesDB,
  getCachedLeaderboard,
  setLeaderboardCache,
  invalidateCache,
};

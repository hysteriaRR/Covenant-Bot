/**
 * rankUtils.js
 * Canonical rank calculation utilities for the XP progression system.
 * All rank-related logic must go through these functions to ensure consistency.
 */

/**
 * Given an XP value, returns the index in rolesData of the highest rank
 * the user has earned based on their XP.
 * Index 1 is the lowest non-guest rank.
 *
 * @param {Array} rolesData - Array of Roblox group role objects (from API)
 * @param {Object} allRolesDB - Firebase roles object keyed by rank number
 * @param {number} xp - The user's current XP
 * @returns {number} The index in rolesData of the expected rank
 */
function getExpectedRoleIndex(rolesData, allRolesDB, xp) {
  let expectedIndex = 1;
  // Iterate from index 1 (skip guest at 0) up to second-to-last (skip owner)
  for (let j = 1; j < rolesData.length - 1; j++) {
    const rRank = rolesData[j].rank;
    const rDB = allRolesDB[rRank];
    if (rDB && Number(rDB.requiredXP) > 0 && xp >= Number(rDB.requiredXP)) {
      expectedIndex = j;
    }
  }
  return expectedIndex;
}

/**
 * Given the user's actual Roblox rank ID, finds its index in the rolesData array.
 *
 * @param {Array} rolesData - Array of Roblox group role objects
 * @param {number} currentRankID - The user's Roblox rank number (0-255)
 * @returns {number} The index in rolesData of the user's actual rank
 */
function getActualRoleIndex(rolesData, currentRankID) {
  for (let j = 1; j < rolesData.length; j++) {
    if (rolesData[j].rank === Number(currentRankID)) return j;
  }
  return 1;
}

/**
 * Determines if a role at the given index is a "High Rank" (HR) role —
 * i.e. a role with requiredXP === 0 that is not the lowest rank.
 * HR roles are exempt from automatic XP-based promotion/demotion.
 *
 * @param {Object} allRolesDB - Firebase roles object keyed by rank number
 * @param {Array} rolesData - Array of Roblox group role objects
 * @param {number} index - Index in rolesData to check
 * @returns {boolean}
 */
function isHRRole(allRolesDB, rolesData, index) {
  const role = rolesData[index];
  if (!role) return false;
  const rDB = allRolesDB[role.rank];
  return rDB && index > 1 && Number(rDB.requiredXP) === 0;
}

/**
 * Returns the next rank object above a given index that has a positive XP requirement.
 * Returns null if the user is at or near max rank.
 *
 * @param {Array} rolesData - Array of Roblox group role objects
 * @param {Object} allRolesDB - Firebase roles object keyed by rank number
 * @param {number} fromIndex - The current rank index to search upward from
 * @returns {Object|null} The next Roblox role object, or null if max rank
 */
function getNextRankObj(rolesData, allRolesDB, fromIndex) {
  for (let k = fromIndex + 1; k < rolesData.length; k++) {
    const checkRank = rolesData[k].rank;
    if (allRolesDB[checkRank] && Number(allRolesDB[checkRank].requiredXP) > 0) {
      return rolesData[k];
    }
  }
  return null;
}

/**
 * Calculates the percentage progress toward a required XP threshold.
 * Returns 100 if there is no next rank or requiredXP is 0.
 *
 * @param {number} currentXP
 * @param {number} requiredXP - XP required for the next rank
 * @returns {number} Integer 0-100
 */
function getProgress(currentXP, requiredXP) {
  if (!requiredXP || requiredXP <= 0) return 100;
  return Math.min(100, Math.round((Number(currentXP) / Number(requiredXP)) * 100));
}

module.exports = {
  getExpectedRoleIndex,
  getActualRoleIndex,
  isHRRole,
  getNextRankObj,
  getProgress,
};

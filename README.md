```markdown
# Covenant Bot

A Discord bot for managing Roblox group ranks and XP progression using Firebase as the backend database.

## Features

- **XP Management System**: Grant or remove XP from group members with atomic operations to prevent race conditions
- **Automatic Rank Synchronization**: Automatically promote/demote members in the Roblox group based on XP thresholds
- **Idempotency Protection**: Prevents duplicate XP grants from retries or duplicate commands
- **Daily XP Caps**: Enforce configurable daily XP limits per user
- **Verification System**: Link Discord accounts to Roblox accounts via blurb verification
- **User Profiles**: View detailed XP progress and rank information
- **Leaderboard**: Display top 10 users by XP with caching
- **Audit Logging**: Structured Firebase audit trail for all XP transactions plus Discord embeds
- **XP ↔ Rank Reconciliation**: Automatic hourly background job to fix mismatches between XP and Roblox group ranks
- **Officer Commands**: Restricted commands for XP grants, removals, and member updates
- **Guild Setup Wizard**: Configure XP thresholds for each Roblox rank interactively

## How It Works

```
Discord User (Officer) → !xp add command → Atomic Firebase XP update
                      → Daily cap check
                      → Idempotency lock check
                      → Rate limit check (30s per officer per target)
                      → XP successfully recorded
                      → Roblox rank sync triggered
                      → Expected rank vs actual rank compared
                      → Rank mismatch? → Roblox group rank updated via Bloxy
                      → Audit logs written to Firebase
                      → Discord embeds sent to audit channel + user channel
```

Firebase handles all XP data and audit logs. Roblox integration uses both `noblox.js` (read) and `bloxy` (write) for rank updates.

## Tech Stack

- **Language**: JavaScript (Node.js)
- **Discord Interface**: discord.js
- **Roblox API**: noblox.js, bloxy
- **Database**: Firebase Realtime Database
- **Authentication**: Firebase service account (admin SDK) + Roblox cookie

## Installation

### Prerequisites

- Node.js 12+ (tested with Discord.js v11 era)
- A Discord bot token
- A Roblox group ID
- A Roblox account for the bot (with group access)
- Firebase project with Realtime Database
- Firebase service account JSON file

### Steps

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd "covenant bot"
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure settings**
   - Create `settings/config.json` in the project root:
   ```json
   {
     "prefix": "!",
     "bot_token": "your-discord-bot-token",
     "groupID": 12345678,
     "rblxCookie": ".ROBLOSECURITY=...",
     "fireBaseURL": "https://your-project.firebaseio.com",
     "serviceAccountPath": "./settings/serviceAccountKey.json",
     "mainChatChannelID": "discord-channel-id",
     "xpAuditLogChannelID": "discord-channel-id",
     "officerRole": "Officer",
     "maxXP": 1000,
     "dailyXPCap": 500,
     "welcomeMessage": "Welcome to the guild!"
   }
   ```

4. **Set up Firebase**
   - Download your Firebase service account JSON from Firebase Console → Project Settings → Service Accounts
   - Save as `settings/serviceAccountKey.json`
   - Ensure the service account has Realtime Database read/write permissions

5. **Start the bot**
   ```bash
   node code.js
   ```

   Or set via environment variable:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS="./settings/serviceAccountKey.json" node code.js
   ```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GOOGLE_APPLICATION_CREDENTIALS` | (Optional) Path to Firebase service account JSON. If set, overrides `config.serviceAccountPath`. |

**Note**: Most configuration is stored in `settings/config.json`. Sensitive values (bot token, Roblox cookie) should be protected.

## Usage

### Starting the Bot

```bash
node code.js
```

The bot will:
1. Load config from config.json
2. Initialize Firebase (admin SDK if service account exists, otherwise legacy client)
3. Log into Roblox via the provided cookie
4. Connect to Discord
5. Start background jobs (lock cleanup every hour, rank reconciliation every 30 minutes)

### Commands Table

#### Member Commands (Everyone)

| Command | Description | Arguments | Example |
|---------|-------------|-----------|---------|
| `!verify` | Link your Roblox account to Discord via blurb verification | `<roblox-username>` | `!verify myusername` |
| `!view` | View detailed XP profile for a user | `<username>` | `!view myusername` |
| `!leaderboard` | View top 10 users by XP | None | `!leaderboard` |
| `!avatar` | Retrieve a user's avatar and profile info | `<username>` | `!avatar myusername` |
| `!xpsources` / `!howtolevel` | Display XP earning guide | None | `!xpsources` |
| `!commands` | Display command reference | None | `!commands` |
| `!code` / `!link` / `!tutorial` | Show tutorial and source code links | None | `!code` |

#### Officer Commands (Requires "Officer" role)

| Command | Description | Arguments | Example |
|---------|-------------|-----------|---------|
| `!xp add` | Grant XP to one or more users | `<amount> <user1>, <user2> \| [reason]` | `!xp add 100 user1, user2 \| Active event` |
| `!xp remove` | Remove XP from one or more users | `<amount> <user1>, <user2> \| [reason]` | `!xp remove 50 user1 \| Demotion` |
| `!register` | Register a Roblox user in XP database | `<roblox-id>` | `!register 123456789` |
| `!update` | Sync member's Discord role, Roblox rank, and nickname | `<username>` | `!update myusername` |

#### Owner Commands (Guild owner only)

| Command | Description | Arguments | Example |
|---------|-------------|-----------|---------|
| `!setup` | Configure XP thresholds for each Roblox rank | Interactive prompts | `!setup` |

### Command Details

#### `!xp add / !xp remove`

**Features:**
- Supports multiple users (comma-separated)
- Optional reason suffix after `|`
- Idempotency: Same message ID + user = skipped on retry
- Per-officer cooldown: 30 seconds per target per officer
- Daily XP cap enforced (if configured)
- Atomic Firebase transaction (no race conditions)
- Automatic Roblox rank sync if XP crosses threshold
- Audit logs to Firebase + Discord embed

**Rate Limits:**
- 30 seconds between grants to the same user by the same officer

**Daily Cap:**
- Default: 500 XP per user per day (configurable via `dailyXPCap`)
- Resets at midnight UTC

#### `!verify`

**Flow:**
1. Officer/user triggers command with Roblox username
2. Bot generates 4-part random verification code
3. User must set code as their Roblox status
4. User responds "done" in DM
5. Bot checks Roblox blurb/status for code
6. If found: Assigns "Verified" role, sets nickname to `<Rank> | <Username>`
7. Requires bot permissions: MANAGE_ROLES, MANAGE_NICKNAMES, CHANGE_NICKNAME

#### `!update`

**Flow:**
1. Officer provides username or Roblox ID
2. Bot resolves Roblox user and finds Discord member
3. Calculates expected rank from current XP
4. Syncs Discord role (removes old rank roles, adds new one)
5. Updates nickname to `<Rank> | <DiscordUser> ( <RobloxUser> )`
6. Updates Roblox group rank if not HR (Human Resource)

#### `!setup`

**Flow:**
1. Owner runs command
2. Bot fetches group roles from Roblox
3. For each rank (excluding guest/owner):
   - Prompts owner to enter required XP
   - Accepts "lock" to exclude from XP promotions
   - Validates XP increases monotonically
4. Stores in Firebase under `roles/{rankId}/requiredXP`
5. Displays summary embed

## Permissions

### Discord Requirements

**Bot must have:**
- `MANAGE_ROLES` - Assign verified role
- `MANAGE_NICKNAMES` / `CHANGE_NICKNAME` - Set member nicknames
- `SEND_MESSAGES` - Post messages and embeds
- `EMBED_LINKS` - Send rich embeds
- `READ_MESSAGE_HISTORY` - Await message collections

**Bot role must be:**
- Higher than the "Verified" role (for `!verify`)
- Higher than all rank roles (for `!update`)
- Higher than user's highest role (for role assignment)

### Role-Based Restrictions

- **Officer commands** (`!xp`, `!register`, `!update`): Requires `config.officerRole` (default: "Officer")
- **Setup command**: Guild owner only
- **Rank restrictions in Roblox**: Non-HR users auto-sync based on XP; HR roles are excluded

## Folder Structure

```
covenant bot/
├── code.js                      # Main bot file
├── settings/
│   ├── config.json             # Configuration (gitignore this)
│   └── serviceAccountKey.json  # Firebase credentials (gitignore this)
├── utils/
│   ├── rankUtils.js            # XP → rank calculation utilities
│   ├── cache.js                # Caching for roles and leaderboard
│   └── theme.js                # Embed styling and formatting
└── package.json
```

## Security Notes

⚠️ **Critical Security Warnings:**

1. **`.ROBLOSECURITY` Cookie**: 
   - This is your Roblox account's authentication token
   - Treat it like a password
   - Never commit to version control
   - Use `.gitignore` to protect config.json
   - If leaked, regenerate at https://www.roblox.com/login

2. **Firebase Service Account**:
   - Contains credentials to your entire Firebase project
   - Never commit serviceAccountKey.json
   - Use environment variables or .env files in production
   - Restrict service account permissions to Realtime Database only

3. **Discord Bot Token**:
   - Store in config or environment variables only
   - Never hardcode in public repositories

4. **Database Access**:
   - Firebase rules should restrict XP writes to authenticated users (audit logs only in this bot)
   - Consider adding Firestore security rules per your use case

## Database Structure

### Firebase Paths

```
xpData/users/{userid}/
  xpValue: number                    # User's total XP

roles/{rankId}/
  requiredXP: number                 # XP threshold for this rank

dailyXP/{YYYY-MM-DD}/{userid}/
  total: number                      # XP granted today (for cap enforcement)

xpLocks/{messageId}_{userid}/
  timestamp: number                  # Idempotency lock timestamp

auditLog/{timestamp}_{userid}/
  userId: string
  username: string
  delta: number                      # XP change (+ or -)
  newTotal: number
  reason: string                     # 'xp_add', 'xp_remove', 'reconcile_rank_fix'
  actorId: string
  actorTag: string
  channelId: string
  timestamp: number
```

## Background Jobs

### Lock Cleanup (Hourly)
- Removes idempotency locks older than 24 hours
- Prevents unbounded growth of `xpLocks` collection

### XP ↔ Rank Reconciliation (Every 30 minutes)
- Iterates all users in `xpData/users`
- Compares expected rank (from XP) vs actual rank (from Roblox group)
- Updates Roblox group rank if mismatch found
- Logs to Firebase audit trail
- Console logs summary: `[Reconcile] Done. Fixed X user(s).`

## Troubleshooting

### Bot Won't Start
- **Missing config.json**: Ensure config.json exists with all required fields
- **Firebase credentials**: Set `GOOGLE_APPLICATION_CREDENTIALS` env var or `serviceAccountPath` in config
- **Discord token invalid**: Verify `bot_token` in config matches Discord application token

### !xp Command Fails
- **Missing Officer role**: User must have the role named in `config.officerRole`
- **Rate limit**: User hit 30-second cooldown; wait and retry
- **Daily cap reached**: User exceeded `dailyXPCap` for today; try again tomorrow
- **Roblox user not found**: Username may be misspelled or account doesn't exist

### !verify Fails
- **Bot missing permissions**: Ensure bot has MANAGE_ROLES, MANAGE_NICKNAMES, CHANGE_NICKNAME
- **Bot role too low**: Move bot's role above "Verified" role in Discord settings
- **User DM issues**: User may have blocked DMs; check privacy settings
- **Verification code not found**: User must set code in Roblox status/blurb, not elsewhere

### !update Doesn't Sync Discord Roles
- **No matching Discord role**: Create a Discord role with exact name as Roblox rank
- **Bot role hierarchy**: Ensure bot role is above all rank roles
- **Member not found**: User may not be in Discord server

### Ranks Not Auto-Updating After !xp
- **Bloxy connection issue**: Check console for Bloxy login errors
- **Roblox API rate limited**: Wait a few minutes before retrying
- **User is HR**: HR roles are excluded from auto-sync; manual update required
- **Reconciliation job**: If critical, check if reconciliation job fixed it (runs every 30 min)

### XP Not Persisting
- **Firebase connection**: Verify `fireBaseURL` in config is correct
- **Service account permissions**: Ensure service account has write access to Realtime Database
- **Network error**: Check console for Firebase error messages

## Known Issues

### Deprecated Discord.js Usage
- Code uses `discord.js` v11 API (`RichEmbed`, `.get()` for channels/roles, etc.)
- Consider upgrading to discord.js v12+ (`EmbedBuilder`, `.cache.get()`, etc.)

### Missing Error Handling for Bloxy
- Bloxy login failures during startup are logged but don't halt the bot
- If Bloxy is unavailable, rank updates will fail silently

### No Rate Limiting on !verify
- Multiple verify attempts can be made in rapid succession
- Consider adding cooldown tracking

### Hardcoded Verification Codes
- Verification words are hardcoded; consider moving to config for internationalization

## Contributing

- Fork the repository
- Create a feature branch
- Test thoroughly before submitting a pull request
- Ensure sensitive data is not in commits

## License

Unlicensed. Project developed by [hysx2](https://www.roblox.com/users/3488853549/profile) for SEELE.

---

**Last Updated**: April 20, 2026

For issues or questions, contact the bot maintainer or SEELE guild leadership.
Discord: h6y_

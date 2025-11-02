# Trello Assistant Bot

A secure Telegram bot that captures ideas from authorized users and groups, sending them directly to your Trello boards.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)](https://nodejs.org/)

⚠️ **IMPORTANT:** Only run ONE instance of the bot at a time!

## Features

- 🔐 **Authorization System** - Only authorized users and groups can use the bot
- 🏢 **Multiple Workspaces** - Each user/group can use their own Trello account
- 📝 Capture ideas from Telegram group chats
- 📋 Send ideas directly to Trello boards and lists
- 👥 Works in group chats with multiple users
- 🎯 Configurable board and list selection
- 🏷️ Add labels and descriptions to cards
- 👤 Assign cards to team members
- 🔒 Admin controls for bot management
- 📊 Usage statistics and request management
- 🔄 Automatic workspace switching per chat

## Setup Instructions

### 1. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` command
3. Choose a name for your bot (e.g., "Trello Assistant")
4. Choose a username (must end with 'bot', e.g., "TrelloAssistant_bot")
5. Save the **bot token** you receive

### 2. Get Trello API Credentials

1. Go to https://trello.com/app-key
2. Log in to your Trello account
3. Copy your **API Key**
4. Click on "Token" link to generate a token
5. Authorize the app and copy the **Token**

### 3. Get Your Telegram User ID

**Important**: You need your Telegram user ID to be the bot admin.

1. Search for **@userinfobot** on Telegram
2. Start a chat and it will show your user ID
3. Copy this ID for the next step

### 4. Configure the Bot

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your credentials:
   - `TELEGRAM_BOT_TOKEN`: Your bot token from BotFather
   - `TRELLO_API_KEY`: Your Trello API key
   - `TRELLO_TOKEN`: Your Trello token
   - `BOT_USERNAME`: Your bot's username (without @)
   - `ADMIN_USER_IDS`: Your Telegram user ID from step 3 (comma-separated for multiple admins)
   - `ENCRYPTION_KEY` (optional): Random string for encrypting tokens (recommended to change)

### 5. Find Your Trello Board ID (Optional)

To set a default board, you need the board ID:

1. Open your Trello board in a browser
2. Add `.json` to the end of the URL
3. Look for `"id"` at the beginning of the JSON
4. Copy this ID to `DEFAULT_BOARD_ID` in `.env`

### 6. Install and Run

```bash
# Install dependencies
npm install

# Start the bot
npm start

# For development with auto-restart
npm run dev
```

## Bot Commands

### Public Commands (No Auth Required)
- `/start` - Initialize the bot and check authorization
- `/request` - Request access to use the bot

### Basic Commands (Auth Required)
- `/helptrello` - Show all available commands
- `/idea [your idea]` - Quick capture an idea to default list
- `/task [task description]` - Create a task card

### Workspace Management (Auth Required)
- `/workspace` - View current workspace info
- `/setworkspace` - Connect your own Trello account
- `/removeworkspace` - Remove custom workspace and use default

### Trello Management (Auth Required)
- `/boards` - List all accessible Trello boards
- `/setboard` - Set the current board for the chat
- `/lists` - Show lists in current board
- `/setlist` - Set default list for quick captures
- `/status` - Show current configuration

### Advanced Features (Auth Required)
- `/addidea` - Interactive idea creation with options
- `/assign @username [card title]` - Create and assign a card
- `/label [label] [card title]` - Create card with label
- `/search [query]` - Search for cards

### Admin Commands
- `/authorize [user_id]` - Authorize a user
- `/authorize group:[group_id]` - Authorize a group
- `/unauthorize [user_id]` - Remove user authorization
- `/requests` - View pending access requests
- `/authorized` - View all authorized users and groups
- `/settings` - Configure bot settings
- `/stats` - Show bot usage statistics

## Using Your Own Trello Workspace

Each authorized user or group can connect their own Trello account:

### Setting Up Custom Workspace
1. Use `/setworkspace` command
2. Get your API key from https://trello.com/app-key
3. Generate a token using the link provided
4. Send credentials to the bot in the format shown

### Benefits
- **Privacy**: Your cards go to your own Trello account
- **Organization**: Each group can use different workspaces
- **Flexibility**: Switch between workspaces anytime
- **Independence**: Not dependent on bot owner's Trello

## Authorization System

The bot uses a whitelist system - only authorized users and groups can use it.

### First Time Setup (Admin)
1. Add your Telegram user ID to `ADMIN_USER_IDS` in `.env`
2. Start the bot
3. You'll have full access as admin

### Authorizing Users/Groups

**For individual users:**
1. User sends `/request` to the bot
2. Admin receives notification
3. Admin uses `/authorize [user_id]` to grant access

**For groups:**
1. Add bot to the group
2. Someone in the group uses `/start`
3. Bot shows the group ID
4. Admin uses `/authorize group:[group_id]` to grant access

## Group Chat Setup

1. **Get group authorized first** (see above)

2. Add the bot to your group:
   - Open the group chat
   - Click group name → Add Members
   - Search for your bot username
   - Add the bot

3. **Important**: Make the bot an admin (for it to see messages):
   - Click group name → Edit
   - Administrators → Add Administrator
   - Select your bot

4. Configure the board for the group:
   - Use `/setboard` command
   - Select the Trello board for this group

## Usage Examples

### Quick Idea Capture
```
/idea Build a feature for user authentication
```

### Detailed Task Creation
```
/task Implement OAuth2 login with Google
```

### Interactive Mode
```
/addidea
Bot: What's your idea?
You: Create landing page
Bot: Select a list: [Shows buttons]
You: [Select "To Do"]
Bot: Add a description? (optional)
You: Modern, responsive design with hero section
Bot: Card created! 
```

## Tips

- Use `/setlist` to set a default list for faster idea capture
- Ideas can be captured by mentioning the bot: `@YourBot_bot idea: [your idea]`
- Multiple users can use the bot simultaneously in group chats
- Cards are created with the sender's name for tracking

## Deployment

### Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

1. Click the button above or go to [Railway](https://railway.app/)
2. Create a new project from your GitHub repository
3. Add the following environment variables in Railway:
   - `TELEGRAM_BOT_TOKEN`
   - `TRELLO_API_KEY`
   - `TRELLO_TOKEN`
   - `BOT_USERNAME`
   - `ADMIN_USER_IDS`
   - `ENCRYPTION_KEY` (optional but recommended)
   - `DEFAULT_BOARD_ID` (optional)
   - `PORT` (Railway sets this automatically)
4. **Add a volume** for persistent data storage:
   - Go to your service settings
   - Click "Volumes" → "New Volume"
   - Mount path: `/app/data`
   - Volume size: 1GB (you'll use <100MB)
5. Deploy!

**Cost**: Railway ~$5/month + Volume ~$0.01/month = **~$5.01/month total** ✅

**Note**: The bot stores data in JSON files in the `data/` folder. Railway volumes ensure this data persists across restarts and redeployments.

### Other Deployment Options

The bot can be deployed to any Node.js hosting platform:
- **Heroku**: Use the included `Procfile`
- **DigitalOcean**: Deploy as a Node.js app
- **AWS/GCP**: Use their Node.js runtime
- **VPS**: Run with `npm start` or use PM2 for process management

**Using PM2 (recommended for VPS):**
```bash
npm install -g pm2
pm2 start index.js --name trello-bot
pm2 save
pm2 startup
```

## Troubleshooting

- **Bot not responding in groups**: Make sure bot is an admin
- **Can't see boards**: Check Trello token permissions
- **Commands not working**: Ensure bot username is correctly set in `.env`
- **Bot crashes**: Check logs for missing environment variables

## Security Notes

- Never share your `.env` file or commit it to git
- Keep your API keys and tokens secret
- Regularly rotate your Trello token
- Use ADMIN_USER_IDS to restrict sensitive commands
- The bot encrypts stored tokens in JSON files in the `data/` directory
- The `data/` directory is excluded from git via `.gitignore`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions:
1. Check the [Troubleshooting](#troubleshooting) section
2. Search existing [GitHub Issues](../../issues)
3. Create a new issue if your problem isn't already reported
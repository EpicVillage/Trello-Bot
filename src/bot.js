const TelegramBot = require('node-telegram-bot-api');
const TrelloService = require('./trello-service');
const ConfigManager = require('./config-manager');
const AuthManager = require('./auth-manager');
const TokenManager = require('./token-manager');
const ErrorHandler = require('./error-handler');
const ConnectionManager = require('./connection-manager');

class TrelloAssistantBot {
    constructor(config) {
        this.bot = new TelegramBot(config.telegramToken, { 
            polling: {
                interval: 300,
                autoStart: true,
                params: {
                    timeout: 10
                }
            },
            request: {
                agentOptions: {
                    keepAlive: true,
                    family: 4
                }
            }
        });
        this.config = new ConfigManager();
        this.auth = new AuthManager(config.adminUserIds || []);
        this.tokenManager = new TokenManager(config.trelloApiKey, config.trelloToken);
        this.adminIds = config.adminUserIds || [];
        this.botUsername = config.botUsername;
        this.apiKey = config.trelloApiKey;
        this.defaultToken = config.trelloToken;
        
        this.userSessions = new Map();
        this.trelloServices = new Map();
        this.lastCardListMessages = new Map(); // Store last card list message ID per chat
        this.retryCount = 0;
        this.maxRetries = 5;
        this.retryDelay = 5000;
        this.connectionManager = new ConnectionManager(this.bot);
        this.setupHandlers();
    }

    setupHandlers() {
        // Add error handler for polling errors with retry logic
        this.bot.on('polling_error', (error) => {
            this.handlePollingError(error);
        });
        
        // Add error handler for webhook errors
        this.bot.on('webhook_error', (error) => {
            console.error('Webhook error:', error);
        });
        
        // Handle general errors
        this.bot.on('error', (error) => {
            console.error('Bot error:', error.message);
            if (error.code === 'ETELEGRAM' && error.response && error.response.statusCode === 429) {
                const retryAfter = error.response.body.parameters?.retry_after || 30;
                console.log(`Rate limited. Retrying after ${retryAfter} seconds...`);
                setTimeout(() => {
                    console.log('Resuming after rate limit...');
                }, retryAfter * 1000);
            }
        });
        
        // Basic commands (no auth required for start)
        this.bot.onText(/\/start/, async (msg) => {
            try {
                await this.handleStart(msg);
            } catch (error) {
                await ErrorHandler.sendError(this.bot, msg.chat.id, error, 'handleStart');
            }
        });
        
        this.bot.onText(/\/trellohelp/, (msg) => this.withAuth(msg, async () => {
            try {
                await this.handleHelp(msg);
            } catch (error) {
                await ErrorHandler.sendError(this.bot, msg.chat.id, error, 'handleHelp');
            }
        }));
        
        // Authorization commands
        this.bot.onText(/\/request/, (msg) => this.handleRequestAccess(msg));
        this.bot.onText(/\/authorize (.+)/, (msg, match) => this.handleAuthorize(msg, match[1]));
        this.bot.onText(/\/unauthorize (.+)/, (msg, match) => this.handleUnauthorize(msg, match[1]));
        this.bot.onText(/\/requests/, (msg) => this.handleViewRequests(msg));
        this.bot.onText(/\/authorized/, (msg) => this.handleViewAuthorized(msg));
        
        // Workspace commands
        this.bot.onText(/\/setworkspace/, (msg) => this.withAuth(msg, () => this.handleSetWorkspace(msg)));
        this.bot.onText(/\/removeworkspace/, (msg) => this.withAuth(msg, () => this.handleRemoveWorkspace(msg)));
        this.bot.onText(/\/workspace/, (msg) => this.withAuth(msg, () => this.handleViewWorkspace(msg)));
        
        // Idea capture commands (require auth)
        this.bot.onText(/\/idea (.+)/, (msg, match) => this.withAuth(msg, () => this.handleQuickIdea(msg, match[1])));
        this.bot.onText(/\/task (.+)/, (msg, match) => this.withAuth(msg, () => this.handleQuickTask(msg, match[1])));
        this.bot.onText(/\/addidea/, (msg) => this.withAuth(msg, () => this.handleInteractiveIdea(msg)));
        
        // Trello management (require auth)
        this.bot.onText(/\/boards/, (msg) => this.withAuth(msg, () => this.handleListBoards(msg)));
        this.bot.onText(/\/lists/, (msg) => this.withAuth(msg, () => this.handleListLists(msg)));
        this.bot.onText(/^\/view$/, (msg) => this.withAuth(msg, () => this.handleViewCards(msg)));
        
        // Advanced features (require auth)
        this.bot.onText(/\/assign/, (msg) => this.withAuth(msg, () => this.handleAssignCard(msg)));
        this.bot.onText(/\/label/, (msg) => this.withAuth(msg, () => this.handleLabelCard(msg)));
        this.bot.onText(/\/search (.+)/, (msg, match) => this.withAuth(msg, () => this.handleSearchCards(msg, match[1])));
        
        // Admin commands
        this.bot.onText(/\/settings/, (msg) => this.handleSettings(msg));
        this.bot.onText(/\/stats/, (msg) => this.handleStats(msg));
        this.bot.onText(/\/clearboard/, (msg) => this.handleClearBoard(msg));
        
        // Status command (require auth)
        this.bot.onText(/\/status/, (msg) => this.withAuth(msg, () => this.handleStatus(msg)));
        
        // Network status command (admin only)
        this.bot.onText(/\/network/, (msg) => this.handleNetworkStatus(msg));
        
        // Callback queries for inline keyboards
        this.bot.on('callback_query', (query) => this.handleCallbackQuery(query));
        
        // Handle all messages for sessions and mentions
        this.bot.on('message', async (msg) => {
            try {
                await this.handleMentions(msg);
            } catch (error) {
                console.error('Error handling message:', error);
            }
        });
    }

    async handleStart(msg) {
        console.log('handleStart called with message:', msg.text);
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const userName = msg.from.first_name || 'there';
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

        // Check if this is a deep link for completing a card
        const startParam = msg.text ? msg.text.split(' ')[1] : null;
        console.log('Start parameter:', startParam);

        if (startParam && startParam.startsWith('complete_')) {
            console.log('Deep link detected:', startParam);
            const parts = startParam.replace('complete_', '').split('_');
            console.log('Parsed parts:', parts);
            const cardId = parts[0];
            const listId = parts[1];
            // Use the current chat ID since the user is clicking from their chat
            const originalChatId = chatId;

            console.log('Attempting to complete card:', cardId, 'from list:', listId, 'chat:', originalChatId);

            try {
                const trello = await this.getTrelloService(originalChatId);

                // Get card name before archiving
                console.log('Fetching card details...');
                const card = await trello.getCard(cardId);
                const cardName = card.name.replace(/[💡📝]/g, '').trim();
                console.log('Card name:', cardName);

                // Archive the card
                console.log('Archiving card...');
                await trello.archiveCard(cardId);
                console.log('Card archived successfully');

                // Send success message to the chat where the action was initiated
                await this.bot.sendMessage(chatId, `✅ Card completed: *${cardName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')}*`, { parse_mode: 'Markdown' });

                // Send updated list to the original chat (if different from current chat)
                console.log('Sending updated card list to chat:', originalChatId);
                await this.sendUpdatedCardList(originalChatId, listId);

                // Delete the /start message
                try {
                    await this.bot.deleteMessage(chatId, msg.message_id);
                    console.log('Deleted /start message:', msg.message_id);
                } catch (error) {
                    console.log('Could not delete /start message:', error.message);
                }

                return;
            } catch (error) {
                console.error('Error completing card:', error);
                console.error('Error stack:', error.stack);
                await this.bot.sendMessage(chatId, `❌ Failed to complete card. The card may have been deleted or you may not have access.`);
                return;
            }
        }

        const isAuthorized = await this.auth.isAuthorized(msg);
        const isAdmin = this.auth.isAdmin(userId);
        
        if (isAdmin) {
            const welcome = `
👋 Hello Admin ${userName}!

Welcome to your Trello Assistant Bot. You have full access to all features.

Quick Start:
1. /boards - View Trello boards
2. /setboard - Select a board
3. /idea or /task - Capture ideas

Admin Commands:
• /authorize [user_id] - Add user
• /requests - View access requests
• /authorized - View authorized list
• /stats - Bot statistics

Type /trellohelp for all commands.
            `;
            await this.bot.sendMessage(chatId, welcome);
        } else if (isAuthorized) {
            const welcome = `
👋 Hello ${userName}!

Welcome back to Trello Assistant Bot. You have access to capture ideas and tasks.

Commands:
• /boards - View Trello boards
• /setboard - Select a board
• /idea [text] - Quick capture
• /task [text] - Create task

Type /trellohelp for all commands.
            `;
            await this.bot.sendMessage(chatId, welcome);
        } else {
            const welcome = `
👋 Hello ${userName}!

I'm the Trello Assistant Bot. This bot requires authorization to use.

${isGroup ? 
`This group (${msg.chat.title}) needs authorization.

An admin can authorize this group using:
/authorize group:${chatId}` : 
`To request access, use: /request

An admin will review your request.`}

Contact the bot admin for immediate access.
            `;
            await this.bot.sendMessage(chatId, welcome);
        }
    }

    async handleHelp(msg) {
        const chatId = msg.chat.id;
        const isAdmin = this.isAdmin(msg.from.id);
        const hasCustom = await this.tokenManager.hasCustomToken(chatId);
        
        let helpText = `
📚 *Available Commands:*

*Basic Commands:*
/start - Initialize the bot
/trellohelp - Show this help message
/status - Show current configuration

*Workspace Management:*
/workspace - View current workspace
/setworkspace - Use your own Trello account
${hasCustom ? '/removeworkspace - Remove custom workspace' : ''}

*Capture Ideas:*
/idea [text] - Quick capture an idea
/task [text] - Create a task card
/addidea - Interactive idea creation

*Trello Management:*
/boards - List and select Trello boards
/lists - Show and select default list
/view - View cards in current board

*Advanced:*
/search [query] - Search cards
/assign - Create and assign a card
/label - Add labels to cards
        `;
        
        if (isAdmin) {
            helpText += `

*Admin Commands:*
/authorize [user_id] - Authorize user
/unauthorize [user_id] - Remove authorization
/requests - View access requests
/authorized - View authorized users
/settings - Configure bot settings
/stats - Show usage statistics
            `;
        }
        
        helpText += `

💡 *Tips:*
${hasCustom ? 
'• You are using your own Trello workspace' : 
'• Use /setworkspace to connect your own Trello account'}
• Each chat can have its own workspace
• Mention the bot: @${this.botUsername} idea: [text]
        `;
        
        await this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
    }

    async handleQuickIdea(msg, ideaText) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const userName = msg.from.first_name || msg.from.username || 'User';
        
        try {
            const config = await this.config.getChatConfig(chatId);
            
            if (!config.boardId) {
                return this.bot.sendMessage(chatId, 
                    '❌ No board selected. Use /setboard to select a Trello board first.');
            }
            
            let listId = config.defaultListId;
            
            if (!listId) {
                const trello = await this.getTrelloService(chatId);
                const lists = await trello.getBoardLists(config.boardId);
                if (lists.length === 0) {
                    return this.bot.sendMessage(chatId, '❌ No lists found in the selected board.');
                }
                listId = lists[0].id;
            }
            
            // Extract URLs from the idea text
            const { cleanText, urls, description } = this.extractUrlsFromText(ideaText);
            
            const cardName = `💡 ${cleanText}`;
            const cardDesc = description;
            
            const trello = await this.getTrelloService(chatId);
            const card = await trello.createCard(listId, cardName, cardDesc);
            
            // Escape special characters for Markdown
            const escapedCardName = cardName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
            const escapedUrl = card.url.replace(/_/g, '\\_');
            
            await this.bot.sendMessage(chatId, 
                `✅ Idea captured!\n📋 Card: ${escapedCardName}\n🔗 [View in Trello](${escapedUrl})`,
                { parse_mode: 'Markdown' });
                
            await this.config.incrementStats(chatId, userId);
            
        } catch (error) {
            console.error('Error creating idea:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to create card. Please try again.');
        }
    }

    async handleQuickTask(msg, taskText) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const userName = msg.from.first_name || msg.from.username || 'User';
        
        try {
            const config = await this.config.getChatConfig(chatId);
            
            if (!config.boardId) {
                return this.bot.sendMessage(chatId, 
                    '❌ No board selected. Use /setboard to select a Trello board first.');
            }
            
            let listId = config.defaultListId;
            
            if (!listId) {
                const trello = await this.getTrelloService(chatId);
                const lists = await trello.getBoardLists(config.boardId);
                if (lists.length === 0) {
                    return this.bot.sendMessage(chatId, '❌ No lists found in the selected board.');
                }
                listId = lists[0].id;
            }
            
            // Extract URLs from the task text
            const { cleanText, urls, description } = this.extractUrlsFromText(taskText);
            
            const cardName = `📝 ${cleanText}`;
            const cardDesc = description;
            
            const trello = await this.getTrelloService(chatId);
            const card = await trello.createCard(listId, cardName, cardDesc);
            
            // Escape special characters for Markdown
            const escapedCardName = cardName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
            const escapedUrl = card.url.replace(/_/g, '\\_');
            
            await this.bot.sendMessage(chatId, 
                `✅ Task created!\n📋 Card: ${escapedCardName}\n🔗 [View in Trello](${escapedUrl})`,
                { parse_mode: 'Markdown' });
                
            await this.config.incrementStats(chatId, userId);
            
        } catch (error) {
            console.error('Error creating task:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to create task. Please try again.');
        }
    }

    async handleListBoards(msg) {
        const chatId = msg.chat.id;
        
        try {
            const trello = await this.getTrelloService(chatId);
            const boards = await trello.getBoards();
            
            if (boards.length === 0) {
                return this.bot.sendMessage(chatId, '❌ No boards found in your Trello account.');
            }
            
            const keyboard = {
                inline_keyboard: boards.map(board => [{
                    text: board.name,
                    callback_data: `select_board:${board.id}`
                }])
            };
            
            await this.bot.sendMessage(chatId, 
                '📋 *Your Trello Boards:*\nSelect a board to use for this chat:',
                { parse_mode: 'Markdown', reply_markup: keyboard });
                
        } catch (error) {
            console.error('Error fetching boards:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to fetch boards. Check your Trello credentials.');
        }
    }

    async handleListLists(msg) {
        const chatId = msg.chat.id;
        
        try {
            const config = await this.config.getChatConfig(chatId);
            
            if (!config.boardId) {
                return this.bot.sendMessage(chatId, 
                    '❌ No board selected. Use /setboard to select a board first.');
            }
            
            const trello = await this.getTrelloService(chatId);
            const lists = await trello.getBoardLists(config.boardId);
            
            if (lists.length === 0) {
                return this.bot.sendMessage(chatId, '❌ No lists found in the selected board.');
            }
            
            const keyboard = {
                inline_keyboard: lists.map(list => [{
                    text: list.name,
                    callback_data: `select_list:${list.id}`
                }])
            };
            
            await this.bot.sendMessage(chatId, 
                '📝 *Lists in current board:*\nSelect a default list for quick capture:',
                { parse_mode: 'Markdown', reply_markup: keyboard });
                
        } catch (error) {
            console.error('Error fetching lists:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to fetch lists.');
        }
    }

    async handleInteractiveIdea(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        
        // Check if board is selected first
        const config = await this.config.getChatConfig(chatId);
        if (!config.boardId) {
            return this.bot.sendMessage(chatId, 
                '❌ No board selected. Use /setboard to select a board first.');
        }
        
        const session = {
            step: 'waiting_for_idea',
            type: 'addidea',
            data: {
                originalUserId: userId,
                userName: msg.from.first_name || msg.from.username || 'User'
            },
            chatId: chatId
        };
        
        // For groups, use chatId as session key so all users share the session
        // For DMs, use userId as session key
        const sessionKey = isGroup ? `group_${chatId}` : userId.toString();
        
        this.userSessions.set(sessionKey, session);
        
        await this.bot.sendMessage(chatId, 
            "💡 *Interactive Idea Creation*\n\nWhat's your idea?",
            { parse_mode: 'Markdown' });
    }

    async handleStatus(msg) {
        const chatId = msg.chat.id;
        
        try {
            const config = await this.config.getChatConfig(chatId);
            const stats = await this.config.getStats(chatId);
            
            let statusText = '*Current Configuration:*\n\n';
            
            if (config.boardId) {
                const trello = await this.getTrelloService(chatId);
            const boards = await trello.getBoards();
                const board = boards.find(b => b.id === config.boardId);
                statusText += `📋 Board: ${board ? board.name : 'Unknown'}\n`;
            } else {
                statusText += '📋 Board: Not set\n';
            }
            
            if (config.defaultListId) {
                const trello = await this.getTrelloService(chatId);
            const lists = await trello.getBoardLists(config.boardId);
                const list = lists.find(l => l.id === config.defaultListId);
                statusText += `📝 Default List: ${list ? list.name : 'Unknown'}\n`;
            } else {
                statusText += '📝 Default List: Not set\n';
            }
            
            statusText += `\n*Statistics:*\n`;
            statusText += `📊 Total cards created: ${stats.totalCards || 0}\n`;
            statusText += `👥 Active users: ${stats.activeUsers || 0}\n`;
            
            await this.bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
            
        } catch (error) {
            console.error('Error getting status:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to get status.');
        }
    }

    async handleCallbackQuery(query) {
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const dataParts = query.data.split(':');
        const action = dataParts[0];
        const value = dataParts[1];

        try {
            switch (action) {
                case 'select_board':
                    await this.selectBoard(chatId, value, messageId);
                    await this.bot.answerCallbackQuery(query.id, { text: 'Board selected!' });
                    break;

                case 'select_list':
                    await this.selectList(chatId, value, messageId);
                    await this.bot.answerCallbackQuery(query.id, { text: 'Default list set!' });
                    break;

                case 'idea_list':
                    await this.handleIdeaListSelection(query, value);
                    break;

                case 'view_list_cards':
                    await this.handleViewListCards(query, value);
                    break;

                case 'complete_card':
                    await this.handleCompleteCard(query, value, dataParts[2]);
                    break;

                default:
                    await this.bot.answerCallbackQuery(query.id);
            }
        } catch (error) {
            console.error('Error handling callback:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error occurred' });
        }
    }

    async selectBoard(chatId, boardId, messageId) {
        await this.config.setChatConfig(chatId, { boardId, defaultListId: null });
        
        const trello = await this.getTrelloService(chatId);
        const boards = await trello.getBoards();
        const board = boards.find(b => b.id === boardId);
        
        await this.bot.editMessageText(
            `✅ Board selected: *${board.name}*\n\nUse /lists to set a default list.`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            }
        );
    }

    async selectList(chatId, listId, messageId) {
        const config = await this.config.getChatConfig(chatId);
        await this.config.setChatConfig(chatId, { ...config, defaultListId: listId });
        
        const trello = await this.getTrelloService(chatId);
        const lists = await trello.getBoardLists(config.boardId);
        const list = lists.find(l => l.id === listId);
        
        await this.bot.editMessageText(
            `✅ Default list set: *${list.name}*\n\nYou can now use /idea or /task for quick capture!`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            }
        );
    }

    async handleViewListCards(query, listId) {
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        try {
            const trello = await this.getTrelloService(chatId);
            // Get active cards (excluding completed)
            const cards = await trello.getListCards(listId, false);

            // Also get all cards to count completed ones
            const allCards = await trello.getListCards(listId, true);
            const completedCount = allCards.filter(card => card.dueComplete === true).length;

            if (cards.length === 0) {
                const emptyMessage = completedCount > 0
                    ? `📭 No active cards in this list.\n\n_${completedCount} completed card${completedCount > 1 ? 's' : ''} hidden_`
                    : '📭 No cards found in this list.';

                await this.bot.editMessageText(emptyMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });
                await this.bot.answerCallbackQuery(query.id, { text: 'No active cards' });
                return;
            }

            // Format cards with descriptions
            let messageText = '📋 *Cards in selected list:*\n\n';

            for (let i = 0; i < cards.length; i++) {
                const card = cards[i];
                if (i === 0) {
                    console.log('First card object keys:', Object.keys(card));
                    console.log('Card ID:', card.id);
                    console.log('Card idShort:', card.idShort);
                }
                const cardName = card.name.replace(/[💡📝]/g, '').trim();
                // Escape special characters in card name for Markdown
                const escapedCardName = cardName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

                // Add card number and name
                messageText += `*${i + 1}. ${escapedCardName}*\n`;

                // Add description if it exists
                if (card.desc && card.desc.trim()) {
                    const descLines = card.desc.split('\n');
                    let formattedDesc = '';

                    // Process description lines, filtering out old metadata
                    for (const line of descLines) {
                        const trimmedLine = line.trim();

                        // Skip old metadata lines
                        if (trimmedLine.startsWith('Added by:') ||
                            trimmedLine.startsWith('From:') ||
                            trimmedLine.startsWith('Date:') ||
                            trimmedLine.startsWith('User:') ||
                            trimmedLine.startsWith('Chat:')) {
                            continue;
                        }

                        // Process valid content lines
                        if (trimmedLine.startsWith('Details:')) {
                            formattedDesc += '   📝 _Details:_\n';
                        } else if (trimmedLine.startsWith('Links:')) {
                            formattedDesc += '   🔗 _Links:_\n';
                        } else if (trimmedLine.startsWith('-')) {
                            // Format list items with indentation, escaping URLs if present
                            const escapedLine = trimmedLine.replace(/(https?:\/\/[^\s]+)/g, (url) => {
                                return url.replace(/_/g, '\\_');
                            });
                            formattedDesc += `   ${escapedLine}\n`;
                        } else if (trimmedLine) {
                            // Escape URLs in regular lines
                            const escapedLine = trimmedLine.replace(/(https?:\/\/[^\s]+)/g, (url) => {
                                return url.replace(/_/g, '\\_');
                            });
                            formattedDesc += `   ${escapedLine}\n`;
                        }
                    }

                    if (formattedDesc) {
                        messageText += formattedDesc;
                    }
                }

                // Add Trello link and complete link as text
                if (card.url) {
                    const escapedUrl = card.url.replace(/_/g, '\\_');
                    messageText += `   [View in Trello](${escapedUrl}) | `;
                }

                // Add completion link - keep it under 64 char limit
                const completeLink = `https://t.me/${this.botUsername}?start=complete_${card.id}_${listId}`;
                if (i === 0) {
                    console.log('Sample complete link (handleViewListCards):', completeLink);
                    console.log('Deep link param length:', `complete_${card.id}_${listId}`.length);
                }
                messageText += `[✅ Complete](${completeLink})\n`;

                messageText += '\n';  // Add spacing between cards

                // Check message length to avoid Telegram limits
                if (messageText.length > 3000) {
                    messageText += `_...and ${cards.length - i - 1} more cards_`;
                    break;
                }
            }

            // Add note about hidden completed cards
            if (completedCount > 0) {
                messageText += `\n_Note: ${completedCount} completed card${completedCount > 1 ? 's' : ''} hidden_`;
            }

            await this.bot.editMessageText(messageText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });

            // Store this message ID for future deletion when updated
            this.lastCardListMessages.set(chatId, messageId);

            await this.bot.answerCallbackQuery(query.id, { text: 'Cards loaded!' });

        } catch (error) {
            console.error('Error viewing list cards:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Failed to load cards' });
            await this.bot.editMessageText('❌ Failed to load cards from this list.', {
                chat_id: chatId,
                message_id: messageId
            });
        }
    }

    async handleCompleteCard(query, cardId, listId) {
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        try {
            const trello = await this.getTrelloService(chatId);

            // Get card name before archiving for confirmation message
            const card = await trello.getCard(cardId);
            const cardName = card.name.replace(/[💡📝]/g, '').trim();

            // Archive the card
            await trello.archiveCard(cardId);

            // Show success notification
            await this.bot.answerCallbackQuery(query.id, {
                text: `✅ Completed: ${cardName.substring(0, 30)}${cardName.length > 30 ? '...' : ''}`,
                show_alert: false
            });

            // Reload the list view to show updated cards
            await this.handleViewListCards(query, listId);

        } catch (error) {
            console.error('Error completing card:', error);
            await this.bot.answerCallbackQuery(query.id, {
                text: '❌ Failed to complete card',
                show_alert: true
            });
        }
    }

    async handleIdeaListSelection(query, listId) {
        const userId = query.from.id;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const isGroup = query.message.chat.type === 'group' || query.message.chat.type === 'supergroup';
        
        // Get session using the correct key
        const sessionKey = isGroup ? `group_${chatId}` : userId.toString();
        const session = this.userSessions.get(sessionKey);
        
        if (!session || !session.data.idea) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Session expired. Please try again.' });
            await this.bot.editMessageText('Session expired. Please use /addidea to start again.', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }
        
        try {
            const trello = await this.getTrelloService(chatId);
            const config = await this.config.getChatConfig(chatId);
            const lists = await trello.getBoardLists(config.boardId);
            const selectedList = lists.find(l => l.id === listId);
            
            if (!selectedList) {
                throw new Error('List not found');
            }
            
            // Extract URLs from the idea text
            const { cleanText, urls, description } = this.extractUrlsFromText(session.data.idea);
            
            // Create the card with clean text as name and URLs in description
            const cardName = `💡 ${cleanText}`;
            const cardDesc = description;
            
            const card = await trello.createCard(listId, cardName, cardDesc);
            
            // Clear session using the correct key
            this.userSessions.delete(sessionKey);
            
            // Escape special characters in card name and URL for Markdown
            const escapedCardName = cardName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
            const escapedUrl = card.url.replace(/_/g, '\\_');
            
            // Update message with success
            await this.bot.editMessageText(
                `✅ Idea added to *${selectedList.name}*!\n\n📋 Card: ${escapedCardName}\n🔗 [View in Trello](${escapedUrl})`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                }
            );
            
            await this.bot.answerCallbackQuery(query.id, { text: '✅ Idea captured!' });
            
            // Update stats
            await this.config.incrementStats(chatId, userId);
            
        } catch (error) {
            console.error('Error creating card from interactive mode:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Failed to create card' });
            await this.bot.editMessageText('❌ Failed to create card. Please try again.', {
                chat_id: chatId,
                message_id: messageId
            });
        }
    }

    async handleMentions(msg) {
        if (!msg.text) return;
        
        // Skip if this is a command (except /cancel)
        if (msg.text.startsWith('/') && msg.text !== '/cancel') return;
        
        const userId = msg.from.id;
        const chatId = msg.chat.id;
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        
        // Determine session key based on chat type
        const sessionKey = isGroup ? `group_${chatId}` : userId.toString();
        const session = this.userSessions.get(sessionKey);
        
        // Handle cancel command
        if (msg.text === '/cancel' && session) {
            this.userSessions.delete(sessionKey);
            return this.bot.sendMessage(msg.chat.id, '❌ Operation cancelled.');
        }
        
        if (session) {
            // Update session with current user info for groups
            if (isGroup && session.step === 'waiting_for_idea') {
                session.data.userName = msg.from.first_name || msg.from.username || 'User';
                session.data.originalUserId = userId;
            }
            await this.handleSessionMessage(msg, session);
            return;
        }
        
        // Handle bot mentions
        if (msg.entities) {
            const botMention = `@${this.botUsername}`;
            if (msg.text.includes(botMention)) {
                const ideaMatch = msg.text.match(/idea:\s*(.+)/i);
                const taskMatch = msg.text.match(/task:\s*(.+)/i);
                
                if (ideaMatch) {
                    await this.handleQuickIdea(msg, ideaMatch[1]);
                } else if (taskMatch) {
                    await this.handleQuickTask(msg, taskMatch[1]);
                }
            }
        }
    }

    async handleSessionMessage(msg, session) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        const sessionKey = isGroup ? `group_${chatId}` : userId.toString();
        
        // Handle different session types
        if (session.type === 'setworkspace') {
            await this.handleWorkspaceSetup(msg, session);
            return;
        }
        
        // Handle idea creation session
        if (session.step === 'waiting_for_idea') {
            console.log(`Processing idea: "${text}" for session ${sessionKey}`);
            try {
                session.data.idea = text;
                // Keep the user info from who typed the idea
                if (!session.data.userName) {
                    session.data.userName = msg.from.first_name || msg.from.username || 'User';
                }
                session.step = 'waiting_for_list';
                
                const config = await this.config.getChatConfig(chatId);
                if (!config.boardId) {
                    this.userSessions.delete(sessionKey);
                    return this.bot.sendMessage(chatId, 
                        '❌ No board selected. Use /setboard first.');
                }
                
                console.log(`Getting lists for board ${config.boardId}`);
                const trello = await this.getTrelloService(chatId);
                const lists = await trello.getBoardLists(config.boardId);
                
                if (!lists || lists.length === 0) {
                    this.userSessions.delete(sessionKey);
                    return this.bot.sendMessage(chatId, 
                        '❌ No lists found in the selected board.');
                }
                
                console.log(`Found ${lists.length} lists, showing selection`);
                const keyboard = {
                    inline_keyboard: lists.map(list => [{
                        text: list.name,
                        callback_data: `idea_list:${list.id}`
                    }])
                };
                
                await this.bot.sendMessage(chatId, 
                    `📝 *Select a list for your idea:*\n\n_"${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"_`,
                    { 
                        parse_mode: 'Markdown', 
                        reply_markup: keyboard 
                    });
                
                console.log('List selection sent successfully');
                    
            } catch (error) {
                console.error('Error in handleSessionMessage:', error);
                this.userSessions.delete(sessionKey);
                await this.bot.sendMessage(chatId, 
                    '❌ An error occurred. Please try again with /addidea');
            }
        }
    }

    async handleWorkspaceSetup(msg, session) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text.trim();
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        const sessionKey = isGroup ? `group_${chatId}` : userId.toString();

        // Parse credentials - handle multiple formats
        const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        let apiKey = null;
        let token = null;

        // Try labeled format first
        for (const line of lines) {
            // Try different separators: colon, space, equals
            const apiKeyMatch = line.match(/API[_\s-]?KEY\s*[:=]?\s*(.+)/i);
            const tokenMatch = line.match(/TOKEN\s*[:=]?\s*(.+)/i);

            if (apiKeyMatch) {
                apiKey = apiKeyMatch[1].trim();
            } else if (tokenMatch) {
                token = tokenMatch[1].trim();
            }
        }

        // If not found, try simple two-line format (API key on first line, token on second)
        if (!apiKey && !token && lines.length === 2) {
            apiKey = lines[0].trim();
            token = lines[1].trim();
        }

        if (!apiKey || !token) {
            return this.bot.sendMessage(chatId,
                '❌ Invalid format. Please provide both API_KEY and TOKEN.\n\n' +
                '**Easiest format** (just paste the values):\n```\nyour_api_key_here\nyour_token_here\n```\n\n' +
                'Or with labels:\n```\nAPI_KEY:your_key\nTOKEN:your_token\n```',
                { parse_mode: 'Markdown' });
        }

        // Log for debugging (first/last chars only for security)
        console.log(`Validating credentials - API Key: ${apiKey.substring(0, 5)}...${apiKey.substring(apiKey.length - 5)}, Token: ${token.substring(0, 5)}...${token.substring(token.length - 5)}`);

        // Validate credentials
        const validation = await this.tokenManager.validateToken(apiKey, token);

        if (!validation.valid) {
            return this.bot.sendMessage(chatId,
                `❌ Invalid credentials: ${validation.error}\n\n` +
                `API Key length: ${apiKey.length} chars\n` +
                `Token length: ${token.length} chars\n\n` +
                `Please ensure:\n` +
                `1. No extra spaces in the credentials\n` +
                `2. Complete API key and token copied\n` +
                `3. Credentials are from https://trello.com/app-key`);
        }

        // Save token for this chat
        await this.tokenManager.setToken(
            chatId,
            token,
            apiKey,
            validation.fullName || validation.username || 'Custom Workspace'
        );

        // Clear the session using the correct key
        this.userSessions.delete(sessionKey);
        
        // Clear cached services to force reload
        this.trelloServices.clear();
        
        // Clear board config for fresh start
        await this.config.clearChatConfig(chatId);
        
        await this.bot.sendMessage(chatId, 
            `✅ *Workspace configured successfully!*\n\n` +
            `*Account:* ${validation.fullName || validation.username}\n` +
            `*Email:* ${validation.email || 'Not available'}\n\n` +
            `Now use /boards to select a board from your workspace.`,
            { parse_mode: 'Markdown' });
    }

    async handleSettings(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!this.isAdmin(userId)) {
            return this.bot.sendMessage(chatId, '❌ This command is for administrators only.');
        }
        
        await this.bot.sendMessage(chatId, 
            '*Bot Settings:*\n\nSettings management coming soon!',
            { parse_mode: 'Markdown' });
    }

    async handleNetworkStatus(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!this.isAdmin(userId)) {
            return this.bot.sendMessage(chatId, '❌ This command is for administrators only.');
        }
        
        const status = this.connectionManager.getStatus();
        const isPolling = this.bot.isPolling();
        
        const statusText = `
*🌐 Network Status:*

Connection: ${status.isConnected ? '✅ Connected' : '❌ Disconnected'}
Polling: ${isPolling ? '✅ Active' : '❌ Inactive'}
Reconnect Attempts: ${status.reconnectAttempts}
Uptime: ${status.uptime}s
Last Successful: ${status.lastSuccessfulConnection ? status.lastSuccessfulConnection.toLocaleString() : 'Never'}

Error Recovery: ${this.retryCount > 0 ? `Active (${this.retryCount} retries)` : 'Standby'}
        `;
        
        await this.bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    }
    
    async handleStats(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!this.isAdmin(userId)) {
            return this.bot.sendMessage(chatId, '❌ This command is for administrators only.');
        }
        
        const stats = await this.config.getGlobalStats();
        
        const statsText = `
*📊 Bot Statistics:*

Total Cards Created: ${stats.totalCards || 0}
Active Chats: ${stats.activeChats || 0}
Active Users: ${stats.totalUsers || 0}
        `;
        
        await this.bot.sendMessage(chatId, statsText, { parse_mode: 'Markdown' });
    }

    async handleClearBoard(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!this.isAdmin(userId)) {
            return this.bot.sendMessage(chatId, '❌ This command is for administrators only.');
        }
        
        await this.config.clearChatConfig(chatId);
        await this.bot.sendMessage(chatId, '✅ Board configuration cleared.');
    }

    async handleViewCards(msg) {
        const chatId = msg.chat.id;
        
        try {
            const config = await this.config.getChatConfig(chatId);
            
            if (!config.boardId) {
                return this.bot.sendMessage(chatId, 
                    '❌ No board selected. Use /boards to select a board first.');
            }
            
            const trello = await this.getTrelloService(chatId);
            const lists = await trello.getBoardLists(config.boardId);
            
            if (lists.length === 0) {
                return this.bot.sendMessage(chatId, '❌ No lists found in the selected board.');
            }
            
            const keyboard = {
                inline_keyboard: lists.map(list => [{
                    text: list.name,
                    callback_data: `view_list_cards:${list.id}`
                }])
            };
            
            const messageText = '📋 *Select a list to view its cards:*\n\n_Completed cards will be hidden_';
            
            await this.bot.sendMessage(chatId, 
                messageText,
                { parse_mode: 'Markdown', reply_markup: keyboard });
                
        } catch (error) {
            console.error('Error fetching lists:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to fetch lists.');
        }
    }

    async handleSearchCards(msg, query) {
        const chatId = msg.chat.id;
        
        try {
            const config = await this.config.getChatConfig(chatId);
            
            if (!config.boardId) {
                return this.bot.sendMessage(chatId, 
                    '❌ No board selected. Use /setboard first.');
            }
            
            const trello = await this.getTrelloService(chatId);
            const cards = await trello.searchCards(config.boardId, query);
            
            if (cards.length === 0) {
                return this.bot.sendMessage(chatId, '❌ No cards found matching your search.');
            }
            
            let resultText = `*Search Results for "${query}":*\n\n`;
            cards.slice(0, 5).forEach((card, index) => {
                const cardName = card.name.replace(/[💡📝]/g, '').trim();
                // Escape special characters in card name for Markdown
                const escapedCardName = cardName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
                resultText += `*${index + 1}. ${escapedCardName}*\n`;
                
                // Add formatted description if it exists
                if (card.desc && card.desc.trim()) {
                    const allLines = card.desc.split('\n');
                    const filteredLines = [];
                    
                    // Filter out metadata lines
                    for (const line of allLines) {
                        const trimmedLine = line.trim();
                        if (!trimmedLine.startsWith('Added by:') && 
                            !trimmedLine.startsWith('From:') && 
                            !trimmedLine.startsWith('Date:') &&
                            !trimmedLine.startsWith('User:') &&
                            !trimmedLine.startsWith('Chat:')) {
                            filteredLines.push(line);
                        }
                    }
                    
                    // Process first 3 filtered lines for display
                    const descLines = filteredLines.slice(0, 3);
                    for (const line of descLines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('Details:')) {
                            resultText += '   📝 _Details:_\n';
                        } else if (trimmedLine.startsWith('Links:')) {
                            resultText += '   🔗 _Links:_\n';
                        } else if (trimmedLine) {
                            // Escape URLs in the line
                            const escapedLine = trimmedLine.replace(/(https?:\/\/[^\s]+)/g, (url) => {
                                return url.replace(/_/g, '\\_');
                            });
                            resultText += `   ${escapedLine}\n`;
                        }
                    }
                    if (filteredLines.length > 3) {
                        resultText += '   _...more_\n';
                    }
                }
                
                const escapedUrl = card.url.replace(/_/g, '\\_');
                resultText += `   [View in Trello](${escapedUrl})\n\n`;
            });
            
            await this.bot.sendMessage(chatId, resultText, { parse_mode: 'Markdown' });
            
        } catch (error) {
            console.error('Error searching cards:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to search cards.');
        }
    }

    async handleAssignCard(msg) {
        await this.bot.sendMessage(msg.chat.id, 
            'Card assignment feature coming soon!');
    }

    async handleLabelCard(msg) {
        await this.bot.sendMessage(msg.chat.id, 
            'Label management feature coming soon!');
    }

    async withAuth(msg, callback) {
        const chatId = msg.chat.id;
        const isAuthorized = await this.auth.isAuthorized(msg);
        
        if (!isAuthorized) {
            const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
            await this.bot.sendMessage(chatId, 
                `❌ Unauthorized access.\n\n${isGroup ? 
                    `This group needs authorization. Group ID: ${chatId}` : 
                    'Use /request to request access.'}`);
            return;
        }
        
        return callback();
    }

    async handleRequestAccess(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const userName = msg.from.first_name || msg.from.username || 'Unknown';
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        
        // Check if already authorized
        if (await this.auth.isAuthorized(msg)) {
            return this.bot.sendMessage(chatId, '✅ You already have access!');
        }
        
        const chatTitle = msg.chat.title || 'Private Chat';
        const type = isGroup ? 'group' : 'user';
        
        const request = await this.auth.addAccessRequest(userId, userName, chatId, chatTitle, type);
        
        if (request) {
            await this.bot.sendMessage(chatId, 
                `📝 Access request submitted!\n\nYour ${type} ID: ${chatId}\nStatus: Pending admin approval`);
            
            // Notify admins
            for (const adminId of this.adminIds) {
                try {
                    await this.bot.sendMessage(adminId, 
                        `🔔 New access request:\n\nFrom: ${userName}\nType: ${type}\nChat: ${chatTitle}\nID: ${chatId}\n\nUse /requests to review`);
                } catch (error) {
                    console.error(`Failed to notify admin ${adminId}:`, error);
                }
            }
        } else {
            await this.bot.sendMessage(chatId, 'ℹ️ Request already pending. Please wait for admin approval.');
        }
    }

    async handleAuthorize(msg, param) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!this.auth.isAdmin(userId)) {
            return this.bot.sendMessage(chatId, '❌ Admin only command.');
        }
        
        // Parse parameter (can be user ID or "group:groupId")
        let targetId, targetType;
        if (param.startsWith('group:')) {
            targetId = param.replace('group:', '');
            targetType = 'group';
        } else {
            targetId = param;
            targetType = 'user';
        }
        
        let success;
        if (targetType === 'group') {
            success = await this.auth.authorizeGroup(targetId);
        } else {
            success = await this.auth.authorizeUser(targetId);
        }
        
        if (success) {
            await this.bot.sendMessage(chatId, 
                `✅ Authorized ${targetType}: ${targetId}`);
            
            // Notify the authorized user/group
            try {
                await this.bot.sendMessage(targetId, 
                    `🎉 Access granted! You can now use the bot.\n\nType /trellohelp to see available commands.`);
            } catch (error) {
                console.error('Failed to notify authorized entity:', error);
            }
        } else {
            await this.bot.sendMessage(chatId, `ℹ️ ${targetType} already authorized.`);
        }
    }

    async handleUnauthorize(msg, param) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!this.auth.isAdmin(userId)) {
            return this.bot.sendMessage(chatId, '❌ Admin only command.');
        }
        
        // Parse parameter
        let targetId, targetType;
        if (param.startsWith('group:')) {
            targetId = param.replace('group:', '');
            targetType = 'group';
        } else {
            targetId = param;
            targetType = 'user';
        }
        
        let success;
        if (targetType === 'group') {
            success = await this.auth.unauthorizeGroup(targetId);
        } else {
            success = await this.auth.unauthorizeUser(targetId);
        }
        
        if (success) {
            await this.bot.sendMessage(chatId, 
                `✅ Removed authorization for ${targetType}: ${targetId}`);
        } else {
            await this.bot.sendMessage(chatId, 
                `❌ Could not unauthorize ${targetType} (not found or is admin).`);
        }
    }

    async handleViewRequests(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!this.auth.isAdmin(userId)) {
            return this.bot.sendMessage(chatId, '❌ Admin only command.');
        }
        
        const requests = await this.auth.getPendingRequests();
        
        if (requests.length === 0) {
            return this.bot.sendMessage(chatId, '📭 No pending requests.');
        }
        
        let message = '*📝 Pending Access Requests:*\n\n';
        requests.forEach((req, index) => {
            message += `${index + 1}. *${req.userName}*\n`;
            message += `   Type: ${req.type}\n`;
            message += `   Chat: ${req.chatTitle}\n`;
            message += `   ID: ${req.chatId}\n`;
            message += `   Time: ${new Date(req.timestamp).toLocaleString()}\n\n`;
        });
        
        message += 'To approve: /authorize [ID]\n';
        message += 'To approve request #: /approve [number]';
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async handleViewAuthorized(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!this.auth.isAdmin(userId)) {
            return this.bot.sendMessage(chatId, '❌ Admin only command.');
        }
        
        const list = await this.auth.getAuthorizedList();
        
        let message = '*🔐 Authorized Access:*\n\n';
        
        message += '*Admins:*\n';
        list.admins.forEach(id => message += `• ${id}\n`);
        
        message += '\n*Users:*\n';
        if (list.users.length > 0) {
            list.users.forEach(id => message += `• ${id}\n`);
        } else {
            message += 'None\n';
        }
        
        message += '\n*Groups:*\n';
        if (list.groups.length > 0) {
            list.groups.forEach(id => message += `• ${id}\n`);
        } else {
            message += 'None\n';
        }
        
        const stats = await this.auth.getStats();
        message += `\n*Stats:*\n`;
        message += `Total Users: ${stats.totalUsers}\n`;
        message += `Total Groups: ${stats.totalGroups}\n`;
        message += `Pending Requests: ${stats.pendingRequests}`;
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async getTrelloService(chatId) {
        const tokenData = await this.tokenManager.getToken(chatId);
        const key = `${tokenData.apiKey}:${tokenData.token}`;
        
        if (!this.trelloServices.has(key)) {
            this.trelloServices.set(key, new TrelloService(tokenData.apiKey, tokenData.token));
        }
        
        return this.trelloServices.get(key);
    }

    async handleSetWorkspace(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

        // Use consistent session key
        const sessionKey = isGroup ? `group_${chatId}` : userId.toString();

        // Start workspace setup session
        this.userSessions.set(sessionKey, {
            step: 'waiting_for_credentials',
            type: 'setworkspace',
            chatId: chatId
        });
        
        const instructions = `
🔐 *Set Your Trello Workspace*

To use your own Trello workspace in this chat, follow these steps:

*Step 1: Get your API Key*
1. Go to: https://trello.com/app-key
2. Log in to your Trello account
3. Copy the *API Key*

*Step 2: Get your Token*
1. On the same page, click the *Token* link
2. Click "Allow"
3. Copy the *Token* (long string)

*Step 3: Send me your credentials*
Reply with BOTH on separate lines (easiest):
\`\`\`
your_api_key_here
your_token_here
\`\`\`

Or with labels:
\`\`\`
API_KEY:your_api_key_here
TOKEN:your_token_here
\`\`\`

Type /cancel to abort.
        `;
        
        await this.bot.sendMessage(chatId, instructions, { parse_mode: 'Markdown' });
    }

    async handleRemoveWorkspace(msg) {
        const chatId = msg.chat.id;
        
        const hasCustom = await this.tokenManager.hasCustomToken(chatId);
        if (!hasCustom) {
            return this.bot.sendMessage(chatId, 'ℹ️ This chat is using the default workspace.');
        }
        
        const removed = await this.tokenManager.removeToken(chatId);
        if (removed) {
            // Clear cached Trello service
            this.trelloServices.clear();
            // Clear board config for this chat
            await this.config.clearChatConfig(chatId);
            
            await this.bot.sendMessage(chatId, 
                '✅ Custom workspace removed. Now using default workspace.\n\nUse /boards to select a board from the default workspace.');
        } else {
            await this.bot.sendMessage(chatId, '❌ Failed to remove custom workspace.');
        }
    }

    async handleViewWorkspace(msg) {
        const chatId = msg.chat.id;
        
        try {
            const hasCustom = await this.tokenManager.hasCustomToken(chatId);
            const tokenData = await this.tokenManager.getToken(chatId);
            const trello = await this.getTrelloService(chatId);
            const boards = await trello.getBoards();
            
            const validation = await this.tokenManager.validateToken(tokenData.apiKey, tokenData.token);
            
            const message = `
🏢 *Current Workspace*

*Status:* ${hasCustom ? '✅ Custom Workspace' : '📦 Default Workspace'}
*Account:* ${validation.valid ? validation.fullName || validation.username : 'Unknown'}
*Workspace:* ${tokenData.workspace || 'Default'}

*Available Boards:* ${boards.length}
${boards.slice(0, 5).map(b => `• ${b.name}`).join('\n')}
${boards.length > 5 ? `_...and ${boards.length - 5} more_` : ''}

*Commands:*
${hasCustom ? 
`• /removeworkspace - Switch back to default
• /boards - Select a board` :
`• /setworkspace - Use your own Trello account
• /boards - Select a board`}
            `;
            
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error in handleViewWorkspace:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to fetch workspace info. Try /setworkspace to configure.');
        }
    }

    extractUrlsFromText(text) {
        // Split text into lines
        const lines = text.split('\n').map(line => line.trim()).filter(line => line);
        
        // Regular expression to match URLs
        const urlRegex = /(https?:\/\/[^\s]+)/gi;
        const urls = [];
        const listItems = [];
        let mainTitle = '';
        let processedLines = [];
        
        // Check if we have multiple lines (potential list format)
        if (lines.length > 1) {
            // First line is usually the main title/idea
            mainTitle = lines[0];
            
            // Extract URLs from main title
            const titleUrls = mainTitle.match(urlRegex) || [];
            urls.push(...titleUrls);
            titleUrls.forEach(url => {
                mainTitle = mainTitle.replace(url, '').trim();
            });
            
            // Process remaining lines as potential list items
            for (let i = 1; i < lines.length; i++) {
                let line = lines[i];
                
                // Extract URLs from this line
                const lineUrls = line.match(urlRegex) || [];
                urls.push(...lineUrls);
                lineUrls.forEach(url => {
                    line = line.replace(url, '').trim();
                });
                
                // Check if line starts with list markers
                if (line.match(/^[-*•]\s+/) || line.match(/^\d+\.\s+/)) {
                    // Remove the list marker for cleaner storage
                    const cleanItem = line.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim();
                    if (cleanItem) {
                        listItems.push(`- ${cleanItem}`);
                    }
                } else if (line) {
                    // Non-list item line, add as regular list item
                    listItems.push(`- ${line}`);
                }
            }
        } else {
            // Single line input
            mainTitle = text;
            
            // Extract URLs
            const titleUrls = mainTitle.match(urlRegex) || [];
            urls.push(...titleUrls);
            titleUrls.forEach(url => {
                mainTitle = mainTitle.replace(url, '').trim();
            });
        }
        
        // Clean up the main title
        mainTitle = mainTitle.replace(/\s+/g, ' ').trim();
        
        // Build description
        let description = '';
        
        if (listItems.length > 0) {
            description = 'Details:\n' + listItems.join('\n');
        }
        
        if (urls.length > 0) {
            if (description) {
                description += '\n\n';
            }
            description += 'Links:\n' + urls.map(url => `- ${url}`).join('\n');
        }
        
        return {
            cleanText: mainTitle || text.replace(urlRegex, '').trim(),
            urls,
            listItems,
            description
        };
    }

    isAdmin(userId) {
        return this.adminIds.includes(userId.toString());
    }

    handlePollingError(error) {
        const errorCode = error.code || 'UNKNOWN';
        const errorMessage = error.message || 'Unknown error';

        // Handle 409 Conflict - another bot instance is running
        if (errorCode === 'ETELEGRAM' && error.response && error.response.statusCode === 409) {
            console.error('❌ CRITICAL ERROR: Another bot instance is already running!');
            console.error('Please close all other instances before starting the bot.');
            console.error('To find and kill other instances:');
            console.error('  - Windows: Open Task Manager and end all node.exe processes');
            console.error('  - Linux/WSL: Run "pkill -f node"');
            console.error('\nBot will NOT attempt to reconnect automatically for this error.');
            return;
        }

        if (errorCode === 'EFATAL' || errorCode === 'ECONNRESET' || errorCode === 'ETIMEDOUT' || errorCode === 'ENOTFOUND') {
            this.retryCount++;
            
            if (this.retryCount <= this.maxRetries) {
                console.log(`⚠️ Connection error (${errorCode}). Retry ${this.retryCount}/${this.maxRetries} in ${this.retryDelay/1000}s...`);
                
                setTimeout(() => {
                    console.log('🔄 Attempting to reconnect...');
                    this.bot.stopPolling()
                        .then(() => this.bot.startPolling())
                        .then(() => {
                            console.log('✅ Reconnected successfully!');
                            this.retryCount = 0;
                        })
                        .catch((err) => {
                            console.error('Failed to restart polling:', err.message);
                        });
                }, this.retryDelay);
                
                this.retryDelay = Math.min(this.retryDelay * 1.5, 30000);
            } else {
                console.error(`❌ Max retries (${this.maxRetries}) exceeded. Manual restart may be required.`);
                console.error('Last error:', errorMessage);
                
                setTimeout(() => {
                    console.log('🔄 Attempting final recovery...');
                    this.retryCount = 0;
                    this.retryDelay = 5000;
                    this.bot.stopPolling()
                        .then(() => this.bot.startPolling())
                        .then(() => {
                            console.log('✅ Bot recovered!');
                        })
                        .catch((err) => {
                            console.error('❌ Final recovery failed:', err.message);
                        });
                }, 60000);
            }
        } else {
            console.error('Polling error:', errorMessage);
            if (error.response && error.response.body) {
                console.error('Response:', error.response.body);
            }
        }
    }
    
    start() {
        console.log('🤖 Trello Assistant Bot is running...');
        
        this.connectionManager.startHealthCheck();
        
        setInterval(() => {
            const isPolling = this.bot.isPolling();
            if (!isPolling) {
                console.log('⚠️ Bot stopped polling. Attempting restart...');
                this.bot.startPolling()
                    .then(() => {
                        console.log('✅ Polling restarted successfully!');
                    })
                    .catch((err) => {
                        console.error('Failed to restart polling:', err.message);
                    });
            }
        }, 30000);
    }

    async sendUpdatedCardList(chatId, listId) {
        try {
            // Delete the old card list message if it exists
            const oldMessageId = this.lastCardListMessages.get(chatId);
            if (oldMessageId) {
                try {
                    await this.bot.deleteMessage(chatId, oldMessageId);
                    console.log('Deleted old card list message:', oldMessageId);
                } catch (error) {
                    console.log('Could not delete old message (may be already deleted):', error.message);
                }
            }

            const trello = await this.getTrelloService(chatId);

            // Get active cards (excluding completed)
            const cards = await trello.getListCards(listId, false);

            // Also get all cards to count completed ones
            const allCards = await trello.getListCards(listId, true);
            const completedCount = allCards.filter(card => card.dueComplete === true).length;

            if (cards.length === 0) {
                const emptyMessage = completedCount > 0
                    ? `📭 No active cards in this list.\n\n_${completedCount} completed card${completedCount > 1 ? 's' : ''} hidden_`
                    : '📭 No cards found in this list.';

                const sentMsg = await this.bot.sendMessage(chatId, emptyMessage, { parse_mode: 'Markdown' });
                this.lastCardListMessages.set(chatId, sentMsg.message_id);
                return;
            }

            // Format cards with descriptions
            let messageText = '📋 *Updated card list:*\n\n';

            for (let i = 0; i < cards.length; i++) {
                const card = cards[i];
                const cardName = card.name.replace(/[💡📝]/g, '').trim();
                // Escape special characters in card name for Markdown
                const escapedCardName = cardName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

                // Add card number and name
                messageText += `*${i + 1}. ${escapedCardName}*\n`;

                // Add description if it exists
                if (card.desc && card.desc.trim()) {
                    const descLines = card.desc.split('\n');
                    let formattedDesc = '';

                    // Process description lines, filtering out old metadata
                    for (const line of descLines) {
                        const trimmedLine = line.trim();

                        // Skip old metadata lines
                        if (trimmedLine.startsWith('Added by:') ||
                            trimmedLine.startsWith('From:') ||
                            trimmedLine.startsWith('Date:') ||
                            trimmedLine.startsWith('User:') ||
                            trimmedLine.startsWith('Chat:')) {
                            continue;
                        }

                        // Process valid content lines
                        if (trimmedLine.startsWith('Details:')) {
                            formattedDesc += '   📝 _Details:_\n';
                        } else if (trimmedLine.startsWith('Links:')) {
                            formattedDesc += '   🔗 _Links:_\n';
                        } else if (trimmedLine.startsWith('-')) {
                            // Format list items with indentation, escaping URLs if present
                            const escapedLine = trimmedLine.replace(/(https?:\/\/[^\s]+)/g, (url) => {
                                return url.replace(/_/g, '\\_');
                            });
                            formattedDesc += `   ${escapedLine}\n`;
                        } else if (trimmedLine) {
                            // Escape URLs in regular lines
                            const escapedLine = trimmedLine.replace(/(https?:\/\/[^\s]+)/g, (url) => {
                                return url.replace(/_/g, '\\_');
                            });
                            formattedDesc += `   ${escapedLine}\n`;
                        }
                    }

                    if (formattedDesc) {
                        messageText += formattedDesc;
                    }
                }

                // Add Trello link and complete link as text
                if (card.url) {
                    const escapedUrl = card.url.replace(/_/g, '\\_');
                    messageText += `   [View in Trello](${escapedUrl}) | `;
                }

                // Add completion link - keep it under 64 char limit
                const completeLink = `https://t.me/${this.botUsername}?start=complete_${card.id}_${listId}`;
                if (i === 0) {
                    console.log('Sample complete link (sendUpdatedCardList):', completeLink);
                }
                messageText += `[✅ Complete](${completeLink})\n`;

                messageText += '\n';  // Add spacing between cards

                // Check message length to avoid Telegram limits
                if (messageText.length > 3000) {
                    messageText += `_...and ${cards.length - i - 1} more cards_`;
                    break;
                }
            }

            // Add note about hidden completed cards
            if (completedCount > 0) {
                messageText += `\n_Note: ${completedCount} completed card${completedCount > 1 ? 's' : ''} hidden_`;
            }

            const sentMsg = await this.bot.sendMessage(chatId, messageText, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });

            // Store the new message ID for future deletion
            this.lastCardListMessages.set(chatId, sentMsg.message_id);
            console.log('Stored new card list message ID:', sentMsg.message_id);

        } catch (error) {
            console.error('Error sending updated card list:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to load updated card list.');
        }
    }

    stop() {
        this.connectionManager.stop();
        this.bot.stopPolling();
        console.log('🛑 Bot stopped.');
    }
}

module.exports = TrelloAssistantBot;
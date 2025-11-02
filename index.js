require('dotenv').config();
const TrelloAssistantBot = require('./src/bot');

const config = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    trelloApiKey: process.env.TRELLO_API_KEY,
    trelloToken: process.env.TRELLO_TOKEN,
    botUsername: process.env.BOT_USERNAME,
    adminUserIds: process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS.split(',') : [],
    defaultBoardId: process.env.DEFAULT_BOARD_ID
};

function validateConfig() {
    const required = ['telegramToken', 'trelloApiKey', 'trelloToken', 'botUsername'];
    const missing = required.filter(key => !config[key]);

    if (missing.length > 0) {
        console.error('❌ Missing required configuration:');
        missing.forEach(key => console.error(`   - ${key}`));
        console.error('\nPlease check your .env file and ensure all required values are set.');
        process.exit(1);
    }
}

validateConfig();

const bot = new TrelloAssistantBot(config);

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    // Don't exit, try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit, try to keep running
});

process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down gracefully...');
    bot.stop();
    process.exit(0);
});

console.log('🚀 Starting Trello Assistant Bot...');
console.log(`📱 Bot username: @${config.botUsername}`);
console.log(`👤 Admin IDs: ${config.adminUserIds.join(', ') || 'None set'}`);

bot.start();

console.log('✅ Bot is running! Press Ctrl+C to stop.');
console.log('📝 Use Ctrl+C to stop the bot gracefully.');
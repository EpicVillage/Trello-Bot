class ErrorHandler {
    static handle(error, context = '') {
        console.error(`[ERROR] ${context}:`, error.message);
        
        if (error.code === 'ETELEGRAM') {
            if (error.message.includes("can't parse entities")) {
                console.error('Markdown parsing error - check message formatting');
                return 'Message formatting error. Please try again.';
            }
            if (error.response && error.response.statusCode === 400) {
                return 'Invalid request. Please check your input.';
            }
            if (error.response && error.response.statusCode === 401) {
                return 'Authentication failed. Please check credentials.';
            }
            if (error.response && error.response.statusCode === 403) {
                return 'Access forbidden. Bot may be blocked or removed from chat.';
            }
            if (error.response && error.response.statusCode === 429) {
                return 'Too many requests. Please wait a moment.';
            }
        }
        
        if (error.message && error.message.includes('ECONNREFUSED')) {
            return 'Connection failed. Please check internet connection.';
        }
        
        if (error.message && error.message.includes('invalid key')) {
            return 'Invalid Trello API key. Please check configuration.';
        }
        
        if (error.message && error.message.includes('unauthorized')) {
            return 'Trello authorization failed. Please check token.';
        }
        
        return 'An error occurred. Please try again.';
    }
    
    static async sendError(bot, chatId, error, context = '') {
        const message = this.handle(error, context);
        try {
            await bot.sendMessage(chatId, `❌ ${message}`);
        } catch (sendError) {
            console.error('Failed to send error message:', sendError);
        }
    }
    
    static escapeMarkdown(text) {
        if (!text) return '';
        // Escape special markdown characters
        return text
            .replace(/\*/g, '\\*')
            .replace(/_/g, '\\_')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/~/g, '\\~')
            .replace(/`/g, '\\`')
            .replace(/>/g, '\\>')
            .replace(/#/g, '\\#')
            .replace(/\+/g, '\\+')
            .replace(/-/g, '\\-')
            .replace(/=/g, '\\=')
            .replace(/\|/g, '\\|')
            .replace(/\{/g, '\\{')
            .replace(/\}/g, '\\}')
            .replace(/\./g, '\\.')
            .replace(/!/g, '\\!');
    }
    
    static safeMarkdown(text) {
        if (!text) return '';
        // Only escape special characters that might break parsing
        return text
            .replace(/([*_`\[\]])/g, '\\$1');
    }
}

module.exports = ErrorHandler;
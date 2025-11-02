const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class TokenManager {
    constructor(defaultApiKey, defaultToken) {
        this.tokensFile = path.join(process.cwd(), 'data', 'tokens.json');
        this.defaultApiKey = defaultApiKey;
        this.defaultToken = defaultToken;
        this.tokens = {};
        this.encryptionKey = this.getOrCreateEncryptionKey();
        this.init();
    }

    async init() {
        try {
            const dataDir = path.join(process.cwd(), 'data');
            await fs.mkdir(dataDir, { recursive: true });

            try {
                await fs.access(this.tokensFile);
                await this.loadTokens();
            } catch {
                // Initialize with empty tokens
                await this.saveTokens();
            }
        } catch (error) {
            console.error('Error initializing token manager:', error);
        }
    }

    getOrCreateEncryptionKey() {
        // Simple encryption key from env or generate one
        // In production, use a proper key management system
        const key = process.env.ENCRYPTION_KEY || 'default-encryption-key-change-this';
        return crypto.createHash('sha256').update(key).digest();
    }

    encrypt(text) {
        try {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            return iv.toString('hex') + ':' + encrypted;
        } catch (error) {
            console.error('Encryption error:', error);
            return text;
        }
    }

    decrypt(text) {
        try {
            const parts = text.split(':');
            const iv = Buffer.from(parts[0], 'hex');
            const encryptedText = parts[1];
            const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            console.error('Decryption error:', error);
            return text;
        }
    }

    async loadTokens() {
        try {
            const data = await fs.readFile(this.tokensFile, 'utf8');
            const encrypted = JSON.parse(data);

            // Decrypt tokens
            this.tokens = {};
            for (const [key, value] of Object.entries(encrypted)) {
                if (value.token) {
                    this.tokens[key] = {
                        ...value,
                        token: this.decrypt(value.token),
                        apiKey: value.apiKey ? this.decrypt(value.apiKey) : this.defaultApiKey
                    };
                }
            }
        } catch (error) {
            console.error('Error loading tokens:', error);
            this.tokens = {};
        }
    }

    async saveTokens() {
        try {
            // Encrypt tokens before saving
            const encrypted = {};
            for (const [key, value] of Object.entries(this.tokens)) {
                encrypted[key] = {
                    ...value,
                    token: this.encrypt(value.token),
                    apiKey: this.encrypt(value.apiKey || this.defaultApiKey),
                    addedAt: value.addedAt || new Date().toISOString()
                };
            }

            await fs.writeFile(this.tokensFile, JSON.stringify(encrypted, null, 2));
        } catch (error) {
            console.error('Error saving tokens:', error);
        }
    }

    async setToken(chatId, token, apiKey = null, workspace = null) {
        this.tokens[chatId.toString()] = {
            token,
            apiKey: apiKey || this.defaultApiKey,
            workspace: workspace || 'Unknown Workspace',
            addedAt: new Date().toISOString(),
            lastUsed: new Date().toISOString()
        };
        await this.saveTokens();
        return true;
    }

    async getToken(chatId) {
        await this.loadTokens();
        const chatIdStr = chatId.toString();

        if (this.tokens[chatIdStr]) {
            // Update last used
            this.tokens[chatIdStr].lastUsed = new Date().toISOString();
            await this.saveTokens();

            return {
                apiKey: this.tokens[chatIdStr].apiKey || this.defaultApiKey,
                token: this.tokens[chatIdStr].token,
                workspace: this.tokens[chatIdStr].workspace
            };
        }

        // Return default token if no specific token set
        return {
            apiKey: this.defaultApiKey,
            token: this.defaultToken,
            workspace: 'Default Workspace'
        };
    }

    async removeToken(chatId) {
        const chatIdStr = chatId.toString();
        if (this.tokens[chatIdStr]) {
            delete this.tokens[chatIdStr];
            await this.saveTokens();
            return true;
        }
        return false;
    }

    async hasCustomToken(chatId) {
        await this.loadTokens();
        return !!this.tokens[chatId.toString()];
    }

    async listTokens() {
        await this.loadTokens();
        const list = [];

        for (const [chatId, data] of Object.entries(this.tokens)) {
            list.push({
                chatId,
                workspace: data.workspace,
                addedAt: data.addedAt,
                lastUsed: data.lastUsed
            });
        }

        return list;
    }

    async getTokenStats() {
        await this.loadTokens();
        return {
            totalCustomTokens: Object.keys(this.tokens).length,
            tokens: this.listTokens()
        };
    }

    async validateToken(apiKey, token) {
        try {
            const axios = require('axios');
            const url = `https://api.trello.com/1/members/me?key=${apiKey}&token=${token}`;
            const response = await axios.get(url);
            return {
                valid: true,
                username: response.data.username,
                fullName: response.data.fullName,
                email: response.data.email
            };
        } catch (error) {
            return {
                valid: false,
                error: error.message
            };
        }
    }

    async copyTokenToChat(fromChatId, toChatId) {
        await this.loadTokens();
        const fromChatIdStr = fromChatId.toString();
        const toChatIdStr = toChatId.toString();

        if (this.tokens[fromChatIdStr]) {
            this.tokens[toChatIdStr] = {
                ...this.tokens[fromChatIdStr],
                copiedFrom: fromChatIdStr,
                addedAt: new Date().toISOString()
            };
            await this.saveTokens();
            return true;
        }
        return false;
    }

    async clearAllTokens() {
        this.tokens = {};
        await this.saveTokens();
    }

    async exportTokens() {
        await this.loadTokens();
        const exported = {};

        for (const [chatId, data] of Object.entries(this.tokens)) {
            exported[chatId] = {
                workspace: data.workspace,
                hasToken: true,
                addedAt: data.addedAt,
                lastUsed: data.lastUsed
            };
        }

        return exported;
    }
}

module.exports = TokenManager;

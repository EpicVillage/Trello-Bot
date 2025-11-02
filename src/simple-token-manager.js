const fs = require('fs').promises;
const path = require('path');

class SimpleTokenManager {
    constructor() {
        this.tokensFile = path.join(process.cwd(), 'data', 'workspace-tokens.json');
        this.tokens = {};
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
                this.tokens = {};
                await this.saveTokens();
            }
        } catch (error) {
            console.error('Error initializing token manager:', error);
        }
    }

    async loadTokens() {
        try {
            const data = await fs.readFile(this.tokensFile, 'utf8');
            this.tokens = JSON.parse(data);
        } catch (error) {
            console.error('Error loading tokens:', error);
            this.tokens = {};
        }
    }

    async saveTokens() {
        try {
            await fs.writeFile(this.tokensFile, JSON.stringify(this.tokens, null, 2));
        } catch (error) {
            console.error('Error saving tokens:', error);
        }
    }

    async setPersonalToken(token) {
        this.tokens.personal = {
            token,
            name: 'Personal Workspace',
            updatedAt: new Date().toISOString()
        };
        await this.saveTokens();
    }

    async setGroupToken(token) {
        this.tokens.group = {
            token,
            name: 'Group Workspace',
            updatedAt: new Date().toISOString()
        };
        await this.saveTokens();
    }

    async getToken(isPersonal = true) {
        await this.loadTokens();
        
        if (isPersonal && this.tokens.personal) {
            return this.tokens.personal.token;
        } else if (!isPersonal && this.tokens.group) {
            return this.tokens.group.token;
        }
        
        // Return default token from env if no custom token set
        return process.env.TRELLO_TOKEN;
    }

    async hasPersonalToken() {
        await this.loadTokens();
        return !!this.tokens.personal;
    }

    async hasGroupToken() {
        await this.loadTokens();
        return !!this.tokens.group;
    }

    async getWorkspaceInfo() {
        await this.loadTokens();
        return {
            personal: this.tokens.personal ? this.tokens.personal.name : 'Default',
            group: this.tokens.group ? this.tokens.group.name : 'Default',
            hasPersonal: !!this.tokens.personal,
            hasGroup: !!this.tokens.group
        };
    }
}

module.exports = SimpleTokenManager;
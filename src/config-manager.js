const fs = require('fs').promises;
const path = require('path');

class ConfigManager {
    constructor() {
        this.configDir = path.join(process.cwd(), 'data');
        this.configFile = path.join(this.configDir, 'config.json');
        this.statsFile = path.join(this.configDir, 'stats.json');
        this.init();
    }

    async init() {
        try {
            await fs.mkdir(this.configDir, { recursive: true });

            try {
                await fs.access(this.configFile);
            } catch {
                await this.saveConfig({});
            }

            try {
                await fs.access(this.statsFile);
            } catch {
                await this.saveStats({});
            }
        } catch (error) {
            console.error('Error initializing config:', error);
        }
    }

    async loadConfig() {
        try {
            const data = await fs.readFile(this.configFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error loading config:', error);
            return {};
        }
    }

    async saveConfig(config) {
        try {
            await fs.writeFile(this.configFile, JSON.stringify(config, null, 2));
        } catch (error) {
            console.error('Error saving config:', error);
        }
    }

    async getChatConfig(chatId) {
        const config = await this.loadConfig();
        return config[chatId] || {};
    }

    async setChatConfig(chatId, settings) {
        const config = await this.loadConfig();
        config[chatId] = {
            ...config[chatId],
            ...settings,
            updatedAt: new Date().toISOString()
        };
        await this.saveConfig(config);
        return config[chatId];
    }

    async clearChatConfig(chatId) {
        const config = await this.loadConfig();
        delete config[chatId];
        await this.saveConfig(config);
    }

    async loadStats() {
        try {
            const data = await fs.readFile(this.statsFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error loading stats:', error);
            return {};
        }
    }

    async saveStats(stats) {
        try {
            await fs.writeFile(this.statsFile, JSON.stringify(stats, null, 2));
        } catch (error) {
            console.error('Error saving stats:', error);
        }
    }

    async incrementStats(chatId, userId) {
        const stats = await this.loadStats();

        if (!stats[chatId]) {
            stats[chatId] = {
                totalCards: 0,
                users: {},
                createdAt: new Date().toISOString()
            };
        }

        stats[chatId].totalCards++;

        if (!stats[chatId].users[userId]) {
            stats[chatId].users[userId] = {
                cardsCreated: 0,
                firstUse: new Date().toISOString()
            };
        }

        stats[chatId].users[userId].cardsCreated++;
        stats[chatId].users[userId].lastUse = new Date().toISOString();

        await this.saveStats(stats);
        return stats[chatId];
    }

    async getStats(chatId) {
        const stats = await this.loadStats();
        const chatStats = stats[chatId] || { totalCards: 0, users: {} };

        return {
            totalCards: chatStats.totalCards,
            activeUsers: Object.keys(chatStats.users).length,
            topUsers: Object.entries(chatStats.users)
                .sort((a, b) => b[1].cardsCreated - a[1].cardsCreated)
                .slice(0, 5)
                .map(([userId, data]) => ({
                    userId,
                    cardsCreated: data.cardsCreated
                }))
        };
    }

    async getGlobalStats() {
        const stats = await this.loadStats();

        let totalCards = 0;
        let totalUsers = new Set();
        let activeChats = 0;

        for (const [chatId, chatData] of Object.entries(stats)) {
            totalCards += chatData.totalCards || 0;
            activeChats++;

            for (const userId of Object.keys(chatData.users || {})) {
                totalUsers.add(userId);
            }
        }

        return {
            totalCards,
            totalUsers: totalUsers.size,
            activeChats
        };
    }

    async getUserSettings(userId) {
        const config = await this.loadConfig();
        return config.userSettings?.[userId] || {};
    }

    async setUserSettings(userId, settings) {
        const config = await this.loadConfig();

        if (!config.userSettings) {
            config.userSettings = {};
        }

        config.userSettings[userId] = {
            ...config.userSettings[userId],
            ...settings,
            updatedAt: new Date().toISOString()
        };

        await this.saveConfig(config);
        return config.userSettings[userId];
    }

    async getRecentActivity(limit = 10) {
        const stats = await this.loadStats();
        const activities = [];

        for (const [chatId, chatData] of Object.entries(stats)) {
            for (const [userId, userData] of Object.entries(chatData.users || {})) {
                if (userData.lastUse) {
                    activities.push({
                        chatId,
                        userId,
                        lastUse: userData.lastUse,
                        cardsCreated: userData.cardsCreated
                    });
                }
            }
        }

        return activities
            .sort((a, b) => new Date(b.lastUse) - new Date(a.lastUse))
            .slice(0, limit);
    }

    async backupData() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(this.configDir, 'backups');

        try {
            await fs.mkdir(backupDir, { recursive: true });

            const config = await this.loadConfig();
            const stats = await this.loadStats();

            const backupData = {
                config,
                stats,
                timestamp,
                version: '1.0.0'
            };

            const backupFile = path.join(backupDir, `backup-${timestamp}.json`);
            await fs.writeFile(backupFile, JSON.stringify(backupData, null, 2));

            return backupFile;
        } catch (error) {
            console.error('Error creating backup:', error);
            throw error;
        }
    }

    async restoreData(backupFile) {
        try {
            const data = await fs.readFile(backupFile, 'utf8');
            const backup = JSON.parse(data);

            if (backup.config) {
                await this.saveConfig(backup.config);
            }

            if (backup.stats) {
                await this.saveStats(backup.stats);
            }

            return true;
        } catch (error) {
            console.error('Error restoring backup:', error);
            throw error;
        }
    }
}

module.exports = ConfigManager;

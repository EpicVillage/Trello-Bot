const fs = require('fs').promises;
const path = require('path');

class AuthManager {
    constructor(adminIds = []) {
        this.authFile = path.join(process.cwd(), 'data', 'authorized.json');
        this.adminIds = adminIds.map(id => id.toString());
        this.authorized = {
            users: [],
            groups: [],
            pendingRequests: []
        };
        this.init();
    }

    async init() {
        try {
            const dataDir = path.join(process.cwd(), 'data');
            await fs.mkdir(dataDir, { recursive: true });

            try {
                await fs.access(this.authFile);
                await this.loadAuthorized();
            } catch {
                // Initialize with admin IDs
                this.authorized.users = [...this.adminIds];
                await this.saveAuthorized();
            }
        } catch (error) {
            console.error('Error initializing auth:', error);
        }
    }

    async loadAuthorized() {
        try {
            const data = await fs.readFile(this.authFile, 'utf8');
            this.authorized = JSON.parse(data);

            // Ensure admin IDs are always authorized
            for (const adminId of this.adminIds) {
                if (!this.authorized.users.includes(adminId)) {
                    this.authorized.users.push(adminId);
                }
            }
        } catch (error) {
            console.error('Error loading authorized list:', error);
        }
    }

    async saveAuthorized() {
        try {
            await fs.writeFile(this.authFile, JSON.stringify(this.authorized, null, 2));
        } catch (error) {
            console.error('Error saving authorized list:', error);
        }
    }

    isAdmin(userId) {
        return this.adminIds.includes(userId.toString());
    }

    async isAuthorizedUser(userId) {
        await this.loadAuthorized();
        return this.authorized.users.includes(userId.toString());
    }

    async isAuthorizedGroup(groupId) {
        await this.loadAuthorized();
        return this.authorized.groups.includes(groupId.toString());
    }

    async isAuthorized(msg) {
        const userId = msg.from.id.toString();
        const chatId = msg.chat.id.toString();
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

        // Admins are always authorized
        if (this.isAdmin(userId)) {
            return true;
        }

        if (isGroup) {
            // Check if group is authorized
            return await this.isAuthorizedGroup(chatId);
        } else {
            // Check if user is authorized for private chat
            return await this.isAuthorizedUser(userId);
        }
    }

    async authorizeUser(userId) {
        await this.loadAuthorized();
        const userIdStr = userId.toString();

        if (!this.authorized.users.includes(userIdStr)) {
            this.authorized.users.push(userIdStr);
            await this.saveAuthorized();
            return true;
        }
        return false;
    }

    async unauthorizeUser(userId) {
        await this.loadAuthorized();
        const userIdStr = userId.toString();

        // Cannot remove admin
        if (this.isAdmin(userIdStr)) {
            return false;
        }

        const index = this.authorized.users.indexOf(userIdStr);
        if (index > -1) {
            this.authorized.users.splice(index, 1);
            await this.saveAuthorized();
            return true;
        }
        return false;
    }

    async authorizeGroup(groupId) {
        await this.loadAuthorized();
        const groupIdStr = groupId.toString();

        if (!this.authorized.groups.includes(groupIdStr)) {
            this.authorized.groups.push(groupIdStr);
            await this.saveAuthorized();
            return true;
        }
        return false;
    }

    async unauthorizeGroup(groupId) {
        await this.loadAuthorized();
        const groupIdStr = groupId.toString();

        const index = this.authorized.groups.indexOf(groupIdStr);
        if (index > -1) {
            this.authorized.groups.splice(index, 1);
            await this.saveAuthorized();
            return true;
        }
        return false;
    }

    async addAccessRequest(userId, userName, chatId, chatTitle, type) {
        await this.loadAuthorized();

        const request = {
            userId: userId.toString(),
            userName,
            chatId: chatId.toString(),
            chatTitle,
            type, // 'user' or 'group'
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        // Check if request already exists
        const exists = this.authorized.pendingRequests.some(
            req => req.userId === request.userId && req.chatId === request.chatId
        );

        if (!exists) {
            this.authorized.pendingRequests.push(request);
            await this.saveAuthorized();
            return request;
        }
        return null;
    }

    async getPendingRequests() {
        await this.loadAuthorized();
        return this.authorized.pendingRequests.filter(req => req.status === 'pending');
    }

    async approveRequest(requestIndex) {
        await this.loadAuthorized();

        if (requestIndex >= 0 && requestIndex < this.authorized.pendingRequests.length) {
            const request = this.authorized.pendingRequests[requestIndex];

            if (request.type === 'group') {
                await this.authorizeGroup(request.chatId);
            } else {
                await this.authorizeUser(request.userId);
            }

            request.status = 'approved';
            await this.saveAuthorized();
            return request;
        }
        return null;
    }

    async rejectRequest(requestIndex) {
        await this.loadAuthorized();

        if (requestIndex >= 0 && requestIndex < this.authorized.pendingRequests.length) {
            const request = this.authorized.pendingRequests[requestIndex];
            request.status = 'rejected';
            await this.saveAuthorized();
            return request;
        }
        return null;
    }

    async getAuthorizedList() {
        await this.loadAuthorized();
        return {
            users: this.authorized.users,
            groups: this.authorized.groups,
            admins: this.adminIds
        };
    }

    async getStats() {
        await this.loadAuthorized();
        return {
            totalUsers: this.authorized.users.length,
            totalGroups: this.authorized.groups.length,
            pendingRequests: this.authorized.pendingRequests.filter(r => r.status === 'pending').length,
            totalRequests: this.authorized.pendingRequests.length
        };
    }

    async clearPendingRequests() {
        await this.loadAuthorized();
        this.authorized.pendingRequests = this.authorized.pendingRequests.filter(
            req => req.status === 'pending'
        );
        await this.saveAuthorized();
    }

    async importAuthorizedList(users = [], groups = []) {
        await this.loadAuthorized();

        for (const userId of users) {
            const userIdStr = userId.toString();
            if (!this.authorized.users.includes(userIdStr)) {
                this.authorized.users.push(userIdStr);
            }
        }

        for (const groupId of groups) {
            const groupIdStr = groupId.toString();
            if (!this.authorized.groups.includes(groupIdStr)) {
                this.authorized.groups.push(groupIdStr);
            }
        }

        await this.saveAuthorized();
    }
}

module.exports = AuthManager;

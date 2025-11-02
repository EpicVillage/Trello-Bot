class ConnectionManager {
    constructor(bot) {
        this.bot = bot;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.healthCheckInterval = null;
        this.lastSuccessfulConnection = null;
    }
    
    startHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        this.healthCheckInterval = setInterval(async () => {
            try {
                const me = await this.bot.getMe();
                if (me) {
                    this.isConnected = true;
                    this.lastSuccessfulConnection = new Date();
                    this.reconnectAttempts = 0;
                    this.reconnectDelay = 5000;
                }
            } catch (error) {
                console.log('⚠️ Health check failed:', error.code || error.message);
                this.isConnected = false;
                await this.handleDisconnection();
            }
        }, 60000);
    }
    
    async handleDisconnection() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached. Manual intervention required.');
            return;
        }
        
        this.reconnectAttempts++;
        console.log(`🔄 Attempting reconnection (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        try {
            await this.bot.stopPolling();
            await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
            await this.bot.startPolling();
            
            console.log('✅ Reconnected successfully!');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.reconnectDelay = 5000;
        } catch (error) {
            console.error('Failed reconnection attempt:', error.message);
            this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 60000);
            
            setTimeout(() => {
                this.handleDisconnection();
            }, this.reconnectDelay);
        }
    }
    
    stop() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }
    
    getStatus() {
        return {
            isConnected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
            lastSuccessfulConnection: this.lastSuccessfulConnection,
            uptime: this.lastSuccessfulConnection ? 
                Math.floor((Date.now() - this.lastSuccessfulConnection.getTime()) / 1000) : 0
        };
    }
}

module.exports = ConnectionManager;
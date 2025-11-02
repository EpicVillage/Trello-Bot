#!/bin/bash

# Trello Assistant Bot Runner with Auto-Restart

echo "🚀 Starting Trello Assistant Bot with auto-restart..."

# Function to run the bot
run_bot() {
    while true; do
        echo "📦 Starting bot..."
        npm start
        
        # Check exit code
        if [ $? -eq 0 ]; then
            echo "✅ Bot stopped normally"
            break
        else
            echo "❌ Bot crashed! Restarting in 5 seconds..."
            sleep 5
        fi
    done
}

# Trap Ctrl+C to exit cleanly
trap 'echo "👋 Stopping bot..."; exit 0' INT TERM

# Run the bot
run_bot
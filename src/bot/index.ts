import { Bot } from "grammy";
import { logError, logInfo } from "../utils/logging";
import config from "../utils/config";

export class BotService {
  private bot: Bot;
  private isInitialized: boolean = false;

  constructor(botToken: string) {
    this.bot = new Bot(botToken);
    this.setupCommands();
  }

  private setupCommands() {
    this.bot.command("status", async (ctx) => {
      try {
        const message = `🤖 Bot is running\nTimestamp: ${new Date().toISOString()}`;
        await ctx.reply(message);
      } catch (error) {
        logError("Error in status command:", error);
      }
    });

    this.bot.catch((err) => {
      logError("Error caught in bot:", err);
    });
  }

  public async start() {
    if (this.isInitialized) {
      logInfo("Bot is already running");
      return;
    }

    try {
      // First verify bot connection
      const botInfo = await this.bot.api.getMe();
      logInfo(`Bot info retrieved: @${botInfo.username}`);

      // Start bot without awaiting
      this.bot
        .start({
          drop_pending_updates: true,
          onStart: (botInfo) => {
            logInfo(`Bot @${botInfo.username} started successfully in webhook`);
            this.isInitialized = true;
          },
        })
        .catch((error) => {
          logError("Error in bot.start():", error);
        });

      // Mark as initialized immediately after starting
      this.isInitialized = true;
      logInfo("Bot marked as initialized");

      // Additional connection test
      await this.testConnection();
      logInfo("Bot start sequence completed");
    } catch (error) {
      logError("Failed to start bot:", error);
      throw error;
    }
  }

  private async testConnection() {
    try {
      logInfo("Testing bot connection...");
      const me = await this.bot.api.getMe();
      logInfo(`Bot connection test successful: @${me.username}`);
    } catch (error) {
      logError("Bot connection test failed:", error);
      throw error;
    }
  }

  public async sendError(error: Error | string) {
    logInfo("Attempting to send error message");
    if (!this.isInitialized) {
      logError("Attempted to send error before bot initialization:", error);
      return;
    }

    try {
      const errorMessage = error instanceof Error ? error.message : error;
      await this.bot.api.sendMessage(
        config.adminChatId,
        `❌ Error:\n${errorMessage}`,
        { parse_mode: "HTML" }
      );
      logInfo("Error message sent successfully");
    } catch (err) {
      logError("Failed to send error message:", err);
      // Don't throw here, just log
      return;
    }
  }

  public async sendInfo(message: string) {
    logInfo("Attempting to send info message");
    if (!this.isInitialized) {
      logError("Attempted to send info before bot initialization:", message);
      return;
    }

    try {
      await this.bot.api.sendMessage(config.adminChatId, `🔔 ${message}`, {
        parse_mode: "HTML",
      });
      logInfo("Info message sent successfully");
    } catch (error) {
      logError("Failed to send info message:", error);
      // Don't throw here, just log
      return;
    }
  }
}

export const botService = new BotService(config.botToken);

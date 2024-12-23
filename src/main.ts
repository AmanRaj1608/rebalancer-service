// main.ts
import * as dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import { Database } from "./types";
import { RebalanceService } from "./services/RebalanceService";
import { TransactionManager } from "./services/TransactionsService";
import { logInfo, logError } from "./utils/logging";
import { BotService } from "./bot";
import config from "./utils/config";

async function initializeServices(botService: BotService) {
  // initialize supabase
  const supabase = createClient<Database>(
    config.supabaseUrl,
    config.supabaseKey
  );

  const txManager = new TransactionManager();

  // create rebalance service, pass botService in the constructor
  const rebalanceService = new RebalanceService(
    supabase,
    txManager,
    botService
  );

  return { botService, rebalanceService };
}

let isShuttingDown = false;

async function startRebalancingLoop(
  rebalanceService: RebalanceService,
  botService: BotService
) {
  try {
    while (!isShuttingDown) {
      try {
        await rebalanceService.checkAndRebalance();

        // todo: can add jitter here if we use a queue
        logInfo(`Waiting for ${config.pollIntervalMs}ms before next check`);

        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      } catch (error) {
        logError("Error in rebalancing iteration:", error);
        await botService.sendError(error as Error);
        logInfo("Waiting 30 seconds before retry after error");
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
      logInfo("Completed rebalance iteration");
    }
  } catch (error) {
    logError("Fatal error in rebalancing loop:", error);
    await botService.sendError(
      "Fatal error in rebalancing loop: " + (error as Error).message
    );
    throw error;
  }
}

async function main() {
  try {
    logInfo("Application starting...");
    const botService = new BotService(config.botToken);

    // Initialize all services
    const { rebalanceService } = await initializeServices(botService);

    await botService.start();
    await botService.sendInfo("🚀 Rebalancing bot started");

    // Start the rebalancing loop in the background
    setImmediate(async () => {
      try {
        await startRebalancingLoop(rebalanceService, botService);
      } catch (error) {
        logError("Rebalancing loop failed:", error);
        await botService.sendError(
          "Rebalancing loop failed: " + (error as Error).message
        );
        process.exit(1);
      }
    });

    // Setup shutdown handler
    async function shutdown(signal: string) {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logInfo(`Received ${signal}. Shutting down...`);
      try {
        await botService.sendInfo("Bot is shutting down...");
      } catch (error) {
        logError("Error sending shutdown message:", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      process.exit(0);
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Keep the process alive
    return new Promise(() => {});
  } catch (error: any) {
    logError("Fatal error during startup:", error);
    process.exit(1);
  }
}

// Start the application
logInfo("Initializing application...");
main().catch((error) => {
  logError("Failed to start application:", error);
  process.exit(1);
});

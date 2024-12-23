import { parseUnits, formatUnits, type Address, Hash } from "viem";
import { SupabaseClient } from "@supabase/supabase-js";
import { Database } from "../types";
import { logInfo, logError } from "../utils/logging";
import { TransactionManager } from "./TransactionsService";
import { BotService } from "../bot";
import config from "../utils/config";
import { RebalanceOperation } from "../types";
import { randomUUID } from 'node:crypto';

export class RebalanceService {
  private supabase: SupabaseClient<Database>;
  private isProcessing: boolean = false;
  private txManager: TransactionManager;
  private botService: BotService;

  constructor(
    supabase: SupabaseClient<Database>,
    txManager: TransactionManager,
    botService: BotService
  ) {
    this.supabase = supabase;
    this.txManager = txManager;
    this.botService = botService;
  }

  async checkAndRebalance(): Promise<void> {
    if (this.isProcessing) {
      logInfo("Rebalance operation already in progress, skipping...");
      return;
    }

    try {
      this.isProcessing = true;
      await this.botService.sendInfo("Checking balances...");

      // Check for pending operations
      const { data: pendingOps } = await this.supabase
        .from("rebalance_operations")
        .select("*")
        .in("status", ["PENDING", "IN_PROGRESS"])
        .order("created_at", { ascending: true })
        .limit(1);

      if (pendingOps && pendingOps.length > 0) {
        await this.resumeOperation(pendingOps[0]);
        return;
      }

      // Get token configuration
      const tokenConfig = {
        token_address: config.ethereumTokenAddress,
        decimals: Number(config.tokenDecimals),
        rebalance_threshold: Number(config.rebalanceThreshold),
      };

      // Check balances on both chains
      const [ethereumBalance, mantleBalance] = await Promise.all([
        this.txManager.checkTokenBalance(
          config.ethereumTokenAddress as Address,
          config.ethAddress as Address,
          "ethereum"
        ),
        this.txManager.checkTokenBalance(
          config.mantleTokenAddress as Address,
          config.mantleAddress as Address,
          "mantle"
        ),
      ]);

      // Format balances for comparison
      const parsedEthereumBalance = Number(
        formatUnits(ethereumBalance, tokenConfig.decimals)
      );
      const parsedMantleBalance = Number(
        formatUnits(mantleBalance, tokenConfig.decimals)
      );

      // Log current state
      await this.botService.sendInfo(
        `Current Balances:\n` +
          `Ethereum Chain (${config.ethAddress}): ${parsedEthereumBalance} ETH\n` +
          `Mantle Chain (${config.mantleAddress}): ${parsedMantleBalance} MNT\n` +
          `Threshold: ${tokenConfig.rebalance_threshold} ${config.tokenSymbol}`
      );

      // Check if addresses have minimum required balance for gas
      // 10% of threshold as minimum required balance
      const minBalance = tokenConfig.rebalance_threshold * 0.1;

      if (parsedEthereumBalance < minBalance) {
        throw new Error(
          `Insufficient balance on Ethereum address: ${parsedEthereumBalance} ${config.tokenSymbol}`
        );
      }

      if (parsedMantleBalance < minBalance) {
        throw new Error(
          `Insufficient balance on Mantle address: ${parsedMantleBalance} ${config.tokenSymbol}`
        );
      }

      // Calculate required rebalancing
      const operation = await this.calculateRebalancing(
        parsedEthereumBalance,
        parsedMantleBalance,
        tokenConfig.rebalance_threshold,
        tokenConfig
      );

      if (operation) {
        await this.executeRebalancing(operation);
      } else {
        logInfo("No rebalancing needed at this time");
      }
    } catch (error: any) {
      logError("Error in rebalance process:", error);
      await this.botService.sendError(error.message);
    } finally {
      this.isProcessing = false;
    }
  }

  private async calculateRebalancing(
    ethereumBalance: number,
    mantleBalance: number,
    threshold: number,
    tokenConfig: any
  ): Promise<RebalanceOperation | null> {
    const totalBalance = ethereumBalance + mantleBalance;

    // Calculate imbalance
    const imbalance = Math.abs(ethereumBalance - mantleBalance);

    // Only rebalance if imbalance is greater than threshold
    if (imbalance <= threshold) {
      return null;
    }

    let direction: "MAINNET_TO_MANTLE" | "MANTLE_TO_MAINNET";
    let amountToMove: number;

    // Min balance to maintain on both chains
    const minRequiredBalance = threshold * 0.1;

    // Determine direction and amount
    if (ethereumBalance > mantleBalance) {
      direction = "MAINNET_TO_MANTLE";
      // Calculate the target balance after rebalancing
      const targetMantleBalance = Math.min(
        mantleBalance + imbalance * 0.5,
        totalBalance * 0.5
      );
      amountToMove = Math.min(
        targetMantleBalance - mantleBalance,
        ethereumBalance - minRequiredBalance
      );
    } else {
      direction = "MANTLE_TO_MAINNET";
      const targetEthBalance = Math.min(
        ethereumBalance + imbalance * 0.5,
        totalBalance * 0.5
      );
      amountToMove = Math.min(
        targetEthBalance - ethereumBalance,
        mantleBalance - minRequiredBalance
      );
    }

    // Ensure the amount to move is significant enough
    if (amountToMove <= threshold * 0.1) {
      return null;
    }

    // Round the amount to reasonable precision (6 decimal places)
    amountToMove = Math.floor(amountToMove * 1e6) / 1e6;

    const operation = {
      id: randomUUID(),
      token_address:
        direction === "MAINNET_TO_MANTLE"
          ? config.ethereumTokenAddress
          : config.mantleTokenAddress,
      token_decimals: tokenConfig.decimals,
      amount_to_bridge: parseUnits(
        amountToMove.toString(),
        tokenConfig.decimals
      ).toString(),
      direction,
      status: "PENDING" as const,
    };

    await this.supabase.from("rebalance_operations").insert([
      {
        ...operation,
        ethereum_chain_balance: ethereumBalance.toString(),
        mantle_chain_balance: mantleBalance.toString(),
        created_at: new Date().toISOString(),
      },
    ]);

    await this.botService.sendInfo(
      `Starting rebalance operation:\n` +
        `Direction: ${direction}\n` +
        `Amount: ${amountToMove} ${
          direction === "MAINNET_TO_MANTLE" ? "ETH" : "MNT"
        }\n` +
        `Current Ethereum Balance: ${ethereumBalance}\n` +
        `Current Mantle Balance: ${mantleBalance}\n` +
        `Threshold: ${tokenConfig.rebalance_threshold}`
    );

    return operation;
  }

  private async executeRebalancing(
    operation: RebalanceOperation
  ): Promise<void> {
    try {
      // operation status in progress
      await this.supabase
        .from("rebalance_operations")
        .update({ status: "IN_PROGRESS" })
        .eq("id", operation.id);

      // Execute the bridge transaction
      const txHash = await this.txManager.bridgeTokens({
        tokenAddress: operation.token_address as Address,
        amount: BigInt(operation.amount_to_bridge),
        direction: operation.direction,
        config,
      });

      await this.botService.sendInfo(`Bridge transaction submitted: ${txHash}`);

      // Monitor transaction status
      await this.monitorTransaction(operation.id, txHash, operation.direction);

      // Update operation status
      await this.supabase
        .from("rebalance_operations")
        .update({
          status: "COMPLETED",
          completed_at: new Date().toISOString(),
          bridge_txhash: txHash,
        })
        .eq("id", operation.id);

      await this.botService.sendInfo(
        "Rebalancing operation completed successfully"
      );
    } catch (error: any) {
      logError(
        `Failed to execute rebalancing for operation ${operation.id}:`,
        error
      );
      await this.botService.sendError(`Rebalancing failed: ${error.message}`);

      await this.supabase
        .from("rebalance_operations")
        .update({
          status: "FAILED",
          error_message: error.message,
        })
        .eq("id", operation.id);
    }
  }

  private async resumeOperation(operation: RebalanceOperation): Promise<void> {
    logInfo(`Resuming operation ${operation.id}`);
    await this.botService.sendInfo(`Resuming previous operation ${operation.id}`);

    if (operation.bridge_txhash) {
      // If we have a transaction hash, monitor it
      await this.monitorTransaction(
        operation.id,
        operation.bridge_txhash,
        operation.direction
      );
    } else {
      // If we don't have a transaction hash, restart the operation
      await this.executeRebalancing(operation);
    }
  }

  private async monitorTransaction(
    operationId: string,
    txHash: string,
    direction: "MAINNET_TO_MANTLE" | "MANTLE_TO_MAINNET"
  ): Promise<void> {
    const maxAttempts = 60; // 10 minutes with 10-second intervals
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const status = await this.txManager.checkBridgeStatus(
          txHash as Hash,
          direction
        );

        if (status === "COMPLETED") {
          await this.botService.sendInfo(`Bridge transaction ${txHash} completed`);
          return;
        }

        if (status === "FAILED") {
          throw new Error(`Bridge transaction ${txHash} failed`);
        }

        // Exponential backoff with jitter
        const baseDelay = Math.min(10000 * Math.pow(1.1, attempts), 30000);
        const jitter = Math.random() * 2000;
        await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
        attempts++;
      } catch (error) {
        logError(`Error monitoring transaction ${txHash}:`, error);
        throw error;
      }
    }

    throw new Error(`Transaction monitoring timed out for ${txHash}`);
  }
}

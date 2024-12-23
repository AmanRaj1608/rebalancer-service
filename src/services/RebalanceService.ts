import { parseUnits, formatUnits, type Address, Hash } from "viem";
import { SupabaseClient } from "@supabase/supabase-js";
import { Database } from "../types";
import { logInfo, logError } from "../utils/logging";
import { TransactionManager } from "./TransactionsService";
import { BotService } from "../bot";
import config from "../utils/config";
import { RebalanceOperation } from "../types";
import { randomUUID } from "node:crypto";
import { getPrice } from "../utils/coinmarketcap";

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

      // Check balances on both chains for the desired token
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
        formatUnits(ethereumBalance, config.ethereumTokenDecimals)
      );
      const parsedMantleBalance = Number(
        formatUnits(mantleBalance, config.mantleTokenDecimals)
      );

      // Log current state
      await this.botService.sendInfo(
        `Current Balances:\n` +
          `Ethereum Chain (${config.ethAddress}): ${parsedEthereumBalance} ${config.ethereumTokenSymbol}\n` +
          `Threshold: ${config.ethereumTokenThreshold} ${config.ethereumTokenSymbol}\n` +
          `Mantle Chain (${config.mantleAddress}): ${parsedMantleBalance} ${config.mantleTokenSymbol}\n` +
          `Threshold: ${config.mantleTokenThreshold} ${config.mantleTokenSymbol}`
      );

      // check if both side have gas balance
      const minBalance = 0.001;
      const ethGasBalance = await this.txManager.checkTokenBalance(
        "0x0000000000000000000000000000000000000000",
        config.ethAddress as Address,
        "ethereum"
      );
      const mantleGasBalance = await this.txManager.checkTokenBalance(
        "0x0000000000000000000000000000000000000000",
        config.mantleAddress as Address,
        "mantle"
      );

      if (ethGasBalance < minBalance || mantleGasBalance < minBalance) {
        await this.botService.sendError(
          `Insufficient gas balance on address: 
          Ethereum: ${ethGasBalance} ${config.ethereumTokenSymbol}
          Mantle: ${mantleGasBalance} ${config.mantleTokenSymbol}`
        );
        throw new Error(
          `Insufficient balance on address: 
          Ethereum: ${ethGasBalance} ${config.ethereumTokenSymbol}
          Mantle: ${mantleGasBalance} ${config.mantleTokenSymbol}`
        );
      }

      // Calculate required rebalancing
      const operation = await this.calculateRebalancing(
        parsedEthereumBalance,
        parsedMantleBalance
      );

      if (operation) {
        await this.executeRebalancing(operation);
      } else {
        logInfo("No rebalancing needed at this time");
        await this.botService.sendInfo("No rebalancing needed at this time");
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
    mantleBalance: number
  ): Promise<RebalanceOperation | null> {
    // calculate how much extra threshold we have on each side
    // whichever has extra threshold, we will rebalance to the other side

    // fetch the price of both tokens in usd, take the sum of balance / price
    const ethereumPrice = await getPrice(
      config.ethereumTokenAddress,
      this.botService
    );
    const mantlePrice = await getPrice(
      config.mantleTokenAddress,
      this.botService
    );
    const ethereumBalanceUsd = ethereumBalance * ethereumPrice;
    const mantleBalanceUsd = mantleBalance * mantlePrice;

    // check which side has more threshold
    const ethereumThresholdUsd = config.ethereumTokenThreshold * ethereumPrice;
    const mantleThresholdUsd = config.mantleTokenThreshold * mantlePrice;
    console.log("ethereumThresholdUsd", ethereumThresholdUsd);
    console.log("mantleThresholdUsd", mantleThresholdUsd);
    console.log("ethereumBalanceUsd", ethereumBalanceUsd);
    console.log("mantleBalanceUsd", mantleBalanceUsd);
    // if balance is greater than threshold, we don't need to rebalance
    if (
      ethereumBalanceUsd > ethereumThresholdUsd &&
      mantleBalanceUsd > mantleThresholdUsd
    ) {
      return null;
    }

    // calculate imbalance
    const totalBalanceUSD =
      ethereumBalanceUsd +
      mantleBalanceUsd -
      ethereumThresholdUsd -
      mantleThresholdUsd;
    const imbalanceToMoveUSD = totalBalanceUSD / 2;
    console.log("ethereumThresholdUsd", ethereumThresholdUsd);
    console.log("mantleThresholdUsd", mantleThresholdUsd);
    console.log("imbalanceToMoveUSD", imbalanceToMoveUSD);
    // check which side has more threshold
    let direction: "MAINNET_TO_MANTLE" | "MANTLE_TO_MAINNET";
    let amountToMove: number;

    if (ethereumThresholdUsd > mantleThresholdUsd) {
      direction = "MAINNET_TO_MANTLE";
      amountToMove =
        (imbalanceToMoveUSD * 10 ** config.ethereumTokenDecimals) /
        ethereumPrice;
    } else {
      direction = "MANTLE_TO_MAINNET";
      amountToMove =
        (imbalanceToMoveUSD * 10 ** config.mantleTokenDecimals) / mantlePrice;
    }

    const operation = {
      id: randomUUID(),
      token_address:
        direction === "MAINNET_TO_MANTLE"
          ? config.ethereumTokenAddress
          : config.mantleTokenAddress,
      token_decimals:
        direction === "MAINNET_TO_MANTLE"
          ? config.ethereumTokenDecimals
          : config.mantleTokenDecimals,
      amount_to_bridge: amountToMove.toString(),
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
        `Ethereum Threshold: ${ethereumThresholdUsd}\n` +
        `Mantle Threshold: ${mantleThresholdUsd}`
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
        amount: BigInt(parseInt(operation.amount_to_bridge, 10)),
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
        `Failed to execute rebalancing for operation ${operation.id}:`
        // error
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
    await this.botService.sendInfo(
      `Resuming previous operation ${operation.id}`
    );

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
          await this.botService.sendInfo(
            `Bridge transaction ${txHash} completed`
          );
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
        logError(`Error monitoring transaction ${txHash}:`);
        throw error;
      }
    }

    throw new Error(`Transaction monitoring timed out for ${txHash}`);
  }
}

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import { logError, logInfo } from "../utils/logging";
import { retry } from "../utils/retry";
import config, { Config } from "../utils/config";
const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
  },
] as const;

export interface TransactionConfig {
  to: Address;
  data?: `0x${string}`;
  value?: bigint;
  gasPrice?: bigint;
  gasLimit?: bigint;
}

interface BridgeQuote {
  route: any;
  approvalData?: {
    spender: Address;
    amount: bigint;
  };
  txData: `0x${string}`;
  txTarget: Address;
  value: bigint;
}

interface SwapQuote {
  txData: `0x${string}`;
  txTarget: Address;
  value: bigint;
  toAmount: bigint;
}

export class TransactionManager {
  private ethereumChainClient: any;
  private mantleChainClient: any;
  private ethereumWalletClient: any;
  private mantleWalletClient: any;
  private bungeeApiClient: any;

  constructor() {
    logInfo("Initializing chain clients...");

    // provider: read only clients
    this.ethereumChainClient = createPublicClient({
      transport: http(config.ethereumRpcUrl),
    });

    this.mantleChainClient = createPublicClient({
      transport: http(config.mantleRpcUrl),
    });

    // private key for accounts/wallet clients
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);

    // signer: wallet clients
    this.ethereumWalletClient = createWalletClient({
      account,
      transport: http(config.ethereumRpcUrl),
    });
    this.mantleWalletClient = createWalletClient({
      account,
      transport: http(config.mantleRpcUrl),
    });

    // bungee api client
    this.bungeeApiClient = axios.create({
      baseURL: "https://api.socket.tech/v2",
      headers: {
        "API-KEY": config.bungeeApiKey,
      },
    });
  }

  async checkTokenBalance(
    tokenAddress: Address,
    walletAddress: Address,
    chainType: "ethereum" | "mantle"
  ): Promise<bigint> {
    const client =
      chainType === "ethereum"
        ? this.ethereumChainClient
        : this.mantleChainClient;

    try {
      if (this.isNativeToken(tokenAddress)) {
        return await client.getBalance({ address: walletAddress });
      }

      const balance = await client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress],
      });

      return balance;
    } catch (error) {
      logError("Error checking token balance:", error);
      throw error;
    }
  }

  async checkAllowance(
    tokenAddress: Address,
    spender: Address,
    owner: Address,
    chainType: "ethereum" | "mantle"
  ): Promise<bigint> {
    if (this.isNativeToken(tokenAddress)) {
      // max
      return BigInt(2) ** BigInt(256) - BigInt(1);
    }

    const client =
      chainType === "ethereum"
        ? this.ethereumChainClient
        : this.mantleChainClient;

    try {
      const allowance = await client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, spender],
      });

      return allowance;
    } catch (error) {
      logError("Error checking allowance:", error);
      throw error;
    }
  }

  async approveToken(
    tokenAddress: Address,
    spender: Address,
    amount: bigint,
    chainType: "ethereum" | "mantle"
  ): Promise<Hash> {
    if (this.isNativeToken(tokenAddress)) {
      throw new Error("Cannot approve native token");
    }

    const walletClient =
      chainType === "ethereum"
        ? this.ethereumWalletClient
        : this.mantleWalletClient;

    try {
      const hash = await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, amount],
      });

      return hash;
    } catch (error) {
      logError("Error approving token:", error);
      throw error;
    }
  }

  async getBridgeQuote(
    fromTokenAddress: Address,
    toTokenAddress: Address,
    amount: bigint,
    direction: "MAINNET_TO_MANTLE" | "MANTLE_TO_MAINNET"
  ): Promise<BridgeQuote> {
    try {
      const fromChainId =
        direction === "MAINNET_TO_MANTLE"
          ? config.ethereumChainId
          : config.mantleChainId;
      const toChainId =
        direction === "MAINNET_TO_MANTLE"
          ? config.mantleChainId
          : config.ethereumChainId;

      // Log request parameters for verification
      const params = {
        fromChainId,
        toChainId,
        fromTokenAddress: fromTokenAddress.toLowerCase(),
        toTokenAddress: toTokenAddress.toLowerCase(),
        fromAmount: amount.toString(),
        userAddress: this.ethereumWalletClient.account.address,
        singleTxOnly: true,
        bridgeWithGas: false,
        sort: "output",
        defaultSwapSlippage: 1,
        isContractCall: false,
        showAutoRoutes: false,
      };

      // logInfo(`Socket API request params: ${JSON.stringify(params, null, 2)}`);

      // Get quote from Socket/Bungee
      const quoteResponse = await this.bungeeApiClient.get("/quote", {
        params,
      });

      // Log the full response for debugging
      // logInfo(
      //   `Socket API response: ${JSON.stringify(quoteResponse.data, null, 2)}`
      // );

      if (
        !quoteResponse.data.success ||
        !quoteResponse.data.result.routes.length
      ) {
        logError(
          `No bridge routes available. Response: ${JSON.stringify(
            quoteResponse.data,
            null,
            2
          )}`
        );
        throw new Error("No bridge routes available");
      }

      const selectedRoute = quoteResponse.data.result.routes[0];

      // Get transaction data with exact same route
      const buildTxResponse = await this.bungeeApiClient.post("/build-tx", {
        route: selectedRoute,
      });

      if (!buildTxResponse.data.success) {
        throw new Error("Failed to build bridge transaction");
      }

      const txData = buildTxResponse.data.result;

      return {
        route: selectedRoute,
        approvalData: txData.approvalData
          ? {
              spender: txData.approvalData.allowanceTarget as Address,
              amount: BigInt(txData.approvalData.minimumApprovalAmount),
            }
          : undefined,
        txData: txData.txData as `0x${string}`,
        txTarget: txData.txTarget as Address,
        value: BigInt(txData.value),
      };
    } catch (error) {
      logError("Error getting bridge quote:", error);
      throw error;
    }
  }

  private async getSwapQuote(
    fromTokenAddress: Address,
    toTokenAddress: Address,
    amount: bigint,
    chainId: number
  ): Promise<SwapQuote> {
    try {
      // Use the correct ETH address for Mantle chain
      const mantleEthAddress =
        "0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111" as Address;
      const ethereumEthAddress =
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;

      // If we're swapping to ETH on Mantle, use the correct address
      const actualToAddress =
        chainId === config.mantleChainId &&
        toTokenAddress.toLowerCase() ===
          "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
          ? mantleEthAddress
          : toTokenAddress;

      logInfo(`Requesting swap quote with params:
        chainId: ${chainId}
        fromTokenAddress: ${fromTokenAddress}
        toTokenAddress: ${actualToAddress}
        fromAmount: ${amount.toString()}
      `);

      const quoteResponse = await this.bungeeApiClient.get("/quote", {
        params: {
          fromChainId: chainId,
          toChainId: chainId,
          fromTokenAddress,
          toTokenAddress: actualToAddress,
          fromAmount: amount.toString(),
          userAddress: this.ethereumWalletClient.account.address,
          singleTxOnly: true,
          sort: "output",
          defaultSwapSlippage: 0.5,
        },
      });
      logInfo(
        `Swap quote response: ${JSON.stringify(quoteResponse.data, null, 2)}`
      );

      if (
        !quoteResponse.data.success ||
        !quoteResponse.data.result.routes.length
      ) {
        throw new Error(`No swap routes available on chain ${chainId}`);
      }

      const selectedRoute = quoteResponse.data.result.routes[0];
      const buildTxResponse = await this.bungeeApiClient.post("/build-tx", {
        route: selectedRoute,
      });

      if (!buildTxResponse.data.success) {
        throw new Error("Failed to build swap transaction");
      }

      const txData = buildTxResponse.data.result;
      return {
        txData: txData.txData as `0x${string}`,
        txTarget: txData.txTarget as Address,
        value: BigInt(txData.value),
        toAmount: BigInt(selectedRoute.toAmount),
      };
    } catch (error) {
      logError("Error getting swap quote:", error);
      throw error;
    }
  }

  async bridgeTokens({
    tokenAddress,
    amount,
    direction,
    config,
  }: {
    tokenAddress: Address;
    amount: bigint;
    direction: "MAINNET_TO_MANTLE" | "MANTLE_TO_MAINNET";
    config: Config;
  }): Promise<Hash> {
    logInfo(`Bridge tokens with params:
      tokenAddress: ${tokenAddress}
      amount: ${amount.toString()}
      direction: ${direction}
    `);

    try {
      const sourceToken =
        direction === "MAINNET_TO_MANTLE"
          ? config.ethereumTokenAddress
          : config.mantleTokenAddress;
      const destToken =
        direction === "MAINNET_TO_MANTLE"
          ? config.mantleTokenAddress
          : config.ethereumTokenAddress;

      logInfo(`Initiating bridge transaction:
        Direction: ${direction}
        Amount: ${amount.toString()}
        Source Token: ${sourceToken}
        Destination Token: ${destToken}
      `);

      // Get bridge quote with correct token addresses
      let quote = await this.getBridgeQuote(
        sourceToken as Address,
        destToken as Address,
        amount,
        direction
      );

      if (quote.route.length === 0) {
        // swap all asset to ETH, then bridge ETH, then swap ETH to destination token
        const swapQuote = await this.getSwapQuote(
          sourceToken as Address,
          config.ethAddress as Address,
          amount,
          direction === "MAINNET_TO_MANTLE"
            ? config.ethereumChainId
            : config.mantleChainId
        );
        const swapTx: TransactionConfig = {
          to: swapQuote.txTarget,
          data: swapQuote.txData,
          value: swapQuote.value,
        };
        const swapHash = await this.sendTransaction(
          swapTx,
          direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
        );
        await this.waitForTransaction(
          swapHash,
          direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
        );
        logInfo(`Swap transaction completed: ${swapHash}`);

        // bridge ETH
        const bridgeQuote = await this.getBridgeQuote(
          config.ethAddress as Address,
          destToken as Address,
          swapQuote.toAmount,
          direction === "MAINNET_TO_MANTLE"
            ? "MAINNET_TO_MANTLE"
            : "MANTLE_TO_MAINNET"
        );
        const bridgeTx: TransactionConfig = {
          to: bridgeQuote.txTarget,
          data: bridgeQuote.txData,
          value: bridgeQuote.value,
        };

        const bridgeHash = await this.sendTransaction(
          bridgeTx,
          direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
        );
        await this.waitForTransaction(
          bridgeHash,
          direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
        );
        logInfo(`Bridge transaction completed: ${bridgeHash}`);

        // todo: add case when bridge takes too long, store txhash and check status later
        // swap ETH to destination token
        const finalSwapQuote = await this.getSwapQuote(
          config.ethAddress as Address,
          destToken as Address,
          bridgeQuote.route.toAmount,
          direction === "MAINNET_TO_MANTLE"
            ? config.ethereumChainId
            : config.mantleChainId
        );
        const finalSwapTx: TransactionConfig = {
          to: finalSwapQuote.txTarget,
          data: finalSwapQuote.txData,
          value: finalSwapQuote.value,
        };
        const finalSwapHash = await this.sendTransaction(
          finalSwapTx,
          direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
        );

        await this.waitForTransaction(
          finalSwapHash,
          direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
        );
        logInfo(`Final swap transaction completed: ${finalSwapHash}`);

        return finalSwapHash;
      } else {
        // bridge directly
        // Check and handle approvals if needed
        if (quote.approvalData) {
          const currentAllowance = await this.checkAllowance(
            tokenAddress,
            quote.approvalData.spender,
            direction === "MAINNET_TO_MANTLE"
              ? (config.ethAddress as Address)
              : (config.mantleAddress as Address),
            direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
          );

          logInfo(
            `Current allowance: ${currentAllowance}, Required: ${quote.approvalData.amount}`
          );

          if (currentAllowance < quote.approvalData.amount) {
            const approvalHash = await this.approveToken(
              tokenAddress,
              quote.approvalData.spender,
              quote.approvalData.amount,
              direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
            );

            // Wait for approval transaction with more confirmations
            await this.waitForTransaction(
              approvalHash,
              direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
            );
          }
        }

        quote = await this.getBridgeQuote(
          sourceToken as Address,
          destToken as Address,
          amount,
          direction
        );

        // Execute bridge transaction
        const tx: TransactionConfig = {
          to: quote.txTarget,
          data: quote.txData,
          value: quote.value,
        };

        // Add more detailed logging
        logInfo(`Constructing transaction:
          to: ${tx.to}
          value: ${tx.value?.toString() || "0"}
          has data: ${tx.data ? "yes" : "no"}
          approval needed: ${quote.approvalData ? "yes" : "no"}
        `);

        try {
          // Estimate gas and add buffer
          const estimatedGas = await this.estimateGas(
            tx,
            direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
          );
          tx.gasLimit = (estimatedGas * BigInt(120)) / BigInt(100);

          logInfo(`Gas estimation successful:
            estimated: ${estimatedGas}
            with buffer: ${tx.gasLimit}
          `);

          const hash = await this.sendTransaction(
            tx,
            direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
          );

          return hash;
        } catch (error) {
          // Log the full error details
          logError("Transaction failed:", {
            tx: {
              to: tx.to,
              value: tx.value?.toString() || "0",
              hasData: !!tx.data,
            },
          });
          // TODO: remove this
          // throw error;
          return "0x";
        }
      }
    } catch (error) {
      logError("Error in bridgeTokens:");
      throw error;
    }
  }

  async sendTransaction(
    tx: TransactionConfig,
    chainType: "ethereum" | "mantle"
  ): Promise<Hash> {
    const walletClient =
      chainType === "ethereum"
        ? this.ethereumWalletClient
        : this.mantleWalletClient;

    try {
      const hash = await walletClient.sendTransaction(tx);
      return hash;
    } catch (error) {
      logError("Error sending transaction:", error);
      throw error;
    }
  }

  async waitForTransaction(
    hash: Hash,
    chainType: "ethereum" | "mantle",
    confirmations = 1
  ): Promise<boolean> {
    const client =
      chainType === "ethereum"
        ? this.ethereumChainClient
        : this.mantleChainClient;

    try {
      const receipt: any = await retry(
        () => client.waitForTransactionReceipt({ hash, confirmations }),
        3,
        5000
      );

      return receipt.status === "success";
    } catch (error) {
      logError("Error waiting for transaction:", error);
      throw error;
    }
  }

  async checkBridgeStatus(
    txHash: Hash,
    direction: "MAINNET_TO_MANTLE" | "MANTLE_TO_MAINNET"
  ): Promise<"PENDING" | "COMPLETED" | "FAILED"> {
    try {
      const response = await this.bungeeApiClient.get("/bridge-status", {
        params: {
          transactionHash: txHash,
          fromChainId:
            direction === "MAINNET_TO_MANTLE"
              ? config.ethereumChainId
              : config.mantleChainId,
          toChainId:
            direction === "MAINNET_TO_MANTLE"
              ? config.mantleChainId
              : config.ethereumChainId,
        },
      });

      if (!response.data.success) {
        throw new Error("Failed to get bridge status");
      }

      const status = response.data.result;

      if (
        status.sourceTxStatus === "FAILED" ||
        status.destinationTxStatus === "FAILED"
      ) {
        return "FAILED";
      }

      if (
        status.sourceTxStatus === "COMPLETED" &&
        status.destinationTxStatus === "COMPLETED"
      ) {
        return "COMPLETED";
      }

      return "PENDING";
    } catch (error) {
      logError("Error checking bridge status:");
      throw error;
    }
  }

  private isNativeToken(tokenAddress: Address): boolean {
    return (
      tokenAddress.toLowerCase() ===
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ||
      tokenAddress.toLowerCase() ===
        "0x0000000000000000000000000000000000000000"
    );
  }

  async getTokenDecimals(
    tokenAddress: Address,
    chainType: "ethereum" | "mantle"
  ): Promise<number> {
    if (this.isNativeToken(tokenAddress)) {
      return 18; // Native tokens (ETH) always have 18 decimals
    }

    const client =
      chainType === "ethereum"
        ? this.ethereumChainClient
        : this.mantleChainClient;

    try {
      const decimals = await client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      });

      return decimals;
    } catch (error) {
      logError("Error getting token decimals:", error);
      throw error;
    }
  }

  async estimateGas(
    tx: TransactionConfig,
    chainType: "ethereum" | "mantle"
  ): Promise<bigint> {
    const client =
      chainType === "ethereum"
        ? this.ethereumChainClient
        : this.mantleChainClient;

    try {
      logInfo(`Estimating gas for transaction:
        to: ${tx.to}
        value: ${tx.value?.toString() || "0"}
        chain: ${chainType}
      `);

      const estimate = await client.estimateGas(tx);
      logInfo(`Gas estimation result: ${estimate}`);
      return estimate;
    } catch (error) {
      logError("Error estimating gas:");
      // Rethrow with more context
      throw new Error(
        `Gas estimation failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}

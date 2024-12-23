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
import config from "../utils/config";

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

      // Use the correct token addresses based on direction
      const sourceToken =
        direction === "MAINNET_TO_MANTLE"
          ? config.ethereumTokenAddress
          : config.mantleTokenAddress;
      const destToken =
        direction === "MAINNET_TO_MANTLE"
          ? config.mantleTokenAddress
          : config.ethereumTokenAddress;

      // Log request parameters
      logInfo(`Requesting bridge quote with params:
        fromChainId: ${fromChainId}
        toChainId: ${toChainId}
        fromTokenAddress: ${sourceToken}
        toTokenAddress: ${destToken}
        fromAmount: ${amount.toString()}
        userAddress: ${this.ethereumWalletClient.account.address}
      `);

      // Get quote from Bungee with correct token addresses
      const quoteResponse = await this.bungeeApiClient.get("/quote", {
        params: {
          fromChainId,
          toChainId,
          fromTokenAddress: sourceToken,
          toTokenAddress: destToken,
          fromAmount: amount.toString(),
          userAddress: this.ethereumWalletClient.account.address,
          singleTxOnly: true,
          bridgeWithGas: false,
          sort: "output",
          defaultSwapSlippage: 0.5,
          isContractCall: false,
          showAutoRoutes: false,
        },
      });

      // Log response
      logInfo(
        `Bridge quote response: ${JSON.stringify(quoteResponse.data, null, 2)}`
      );

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

      // Get transaction data
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
      const mantleEthAddress = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111" as Address;
      
      // If we're swapping to ETH on Mantle, use the correct address
      const actualToAddress = 
        chainId === config.mantleChainId && 
        toTokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" 
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
    config: any;
  }): Promise<Hash> {
    try {
      if (direction === "MANTLE_TO_MAINNET") {
        // First swap MNT to ETH on Mantle
        logInfo("Swapping MNT to ETH on Mantle before bridging");
        const swapQuote = await this.getSwapQuote(
          config.mantleTokenAddress as Address,
          "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address,
          amount,
          config.mantleChainId
        );

        // Execute swap transaction
        const swapTx: TransactionConfig = {
          to: swapQuote.txTarget,
          data: swapQuote.txData,
          value: swapQuote.value,
        };

        const swapHash = await this.sendTransaction(swapTx, "mantle");
        await this.waitForTransaction(swapHash, "mantle");
        logInfo(`Swap transaction completed: ${swapHash}`);

        // Now bridge the ETH from Mantle to Ethereum
        logInfo("Bridging swapped ETH from Mantle to Ethereum");
        const bridgeQuote = await this.getBridgeQuote(
          "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address,
          "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address,
          swapQuote.toAmount,
          direction
        );

        const bridgeTx: TransactionConfig = {
          to: bridgeQuote.txTarget,
          data: bridgeQuote.txData,
          value: bridgeQuote.value,
        };

        return await this.sendTransaction(bridgeTx, "mantle");
      } else {
        // Use correct source and destination token addresses
        const sourceToken = config.ethereumTokenAddress;
        const destToken = config.mantleTokenAddress;

        logInfo(`Initiating bridge transaction:
          Direction: ${direction}
          Amount: ${amount.toString()}
          Source Token: ${sourceToken}
          Destination Token: ${destToken}
        `);

        // Get bridge quote with correct token addresses
        const quote = await this.getBridgeQuote(
          sourceToken as Address,
          destToken as Address,
          amount,
          direction
        );

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

          if (currentAllowance < quote.approvalData.amount) {
            const approvalHash = await this.approveToken(
              tokenAddress,
              quote.approvalData.spender,
              quote.approvalData.amount,
              direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
            );

            // Wait for approval transaction
            await this.waitForTransaction(
              approvalHash,
              direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
            );
          }
        }

        // Execute bridge transaction
        const tx: TransactionConfig = {
          to: quote.txTarget,
          data: quote.txData,
          value: quote.value,
        };

        // Estimate gas and add buffer
        const estimatedGas = await this.estimateGas(
          tx,
          direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
        );
        tx.gasLimit = (estimatedGas * BigInt(120)) / BigInt(100);

        const hash = await this.sendTransaction(
          tx,
          direction === "MAINNET_TO_MANTLE" ? "ethereum" : "mantle"
        );

        return hash;
      }
    } catch (error) {
      logError("Error in bridgeTokens:", error);
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
      logError("Error checking bridge status:", error);
      throw error;
    }
  }

  private isNativeToken(tokenAddress: Address): boolean {
    return (
      tokenAddress.toLowerCase() ===
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
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
      const estimate = await client.estimateGas(tx);
      return estimate;
    } catch (error) {
      logError("Error estimating gas:", error);
      throw error;
    }
  }
}

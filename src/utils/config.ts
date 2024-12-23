import dotenv from "dotenv";
import { logError } from "./logging";
dotenv.config();

interface Config {
  ethereumChainId: number;
  mantleChainId: number;
  ethereumRpcUrl: string;
  mantleRpcUrl: string;
  ethAddress: string;
  mantleAddress: string;
  privateKey: string;
  rebalanceThreshold: number;
  bridgeMode: "fast" | "secure";
  pollIntervalMs: number;
  bungeeApiKey: string;
  botToken: string;
  adminChatId: string;
  supabaseUrl: string;
  supabaseKey: string;
  ethereumTokenAddress: string;
  mantleTokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  minBalancePercentage: number;
}

function validateConfig(config: Partial<Config>): config is Config {
  const requiredFields = [
    "ethereumRpcUrl",
    "mantleRpcUrl",
    "ethAddress",
    "mantleAddress",
    "privateKey",
    "bungeeApiKey",
    "botToken",
    "adminChatId",
  ];

  const missingFields = requiredFields.filter(
    (field) => !config[field as keyof Config]
  );

  if (missingFields.length > 0) {
    throw new Error(
      `Missing required configuration fields: ${missingFields.join(", ")}`
    );
  }

  // validate hex address for viem
  if (!config.ethAddress?.startsWith("0x") || config.ethAddress.length !== 42) {
    throw new Error("Invalid source address format");
  }

  if (
    !config.mantleAddress?.startsWith("0x") ||
    config.mantleAddress.length !== 42
  ) {
    throw new Error("Invalid destination address format");
  }

  if (!config.privateKey?.startsWith("0x")) {
    throw new Error("Private key must start with 0x");
  }

  // Validate numerical values
  if (
    typeof config.rebalanceThreshold === "undefined" ||
    config.rebalanceThreshold <= 0
  ) {
    throw new Error("Rebalance threshold must be greater than 0");
  }

  if (
    typeof config.pollIntervalMs === "undefined" ||
    config.pollIntervalMs < 1000
  ) {
    throw new Error("Poll interval must be at least 1000ms");
  }

  if (!config.ethereumTokenAddress?.startsWith("0x")) {
    throw new Error("Invalid Ethereum token address");
  }
  if (!config.mantleTokenAddress?.startsWith("0x")) {
    throw new Error("Invalid Mantle token address");
  }

  return true;
}

const config: Partial<Config> = {
  // Chain IDs, default sepolia testnet
  ethereumChainId: parseInt(process.env.ETHEREUM_CHAIN_ID || "11155111", 10),
  mantleChainId: parseInt(process.env.MANTLE_CHAIN_ID || "5003", 10),

  // Network RPC URLs
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL,
  mantleRpcUrl: process.env.MANTLE_RPC_URL,

  // Wallet Configuration
  ethAddress: process.env.ETH_ADDRESS,
  mantleAddress: process.env.MANTLE_ADDRESS,
  privateKey: process.env.PRIVATE_KEY,

  // Rebalancing Configuration
  rebalanceThreshold: parseFloat(process.env.REBALANCE_THRESHOLD || "0.0001"),
  bridgeMode: (process.env.BRIDGE_MODE as "fast" | "secure") || "fast",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "60000", 10),
  minBalancePercentage: parseInt(
    process.env.MIN_BALANCE_PERCENTAGE || "10",
    10
  ),

  // API Keys and External Services
  bungeeApiKey: process.env.BUNGEE_API_KEY,
  botToken: process.env.BOT_TOKEN,
  adminChatId: process.env.ADMIN_CHAT_ID,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,

  // Token Configuration
  ethereumTokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  mantleTokenAddress: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000",
  tokenSymbol: process.env.TOKEN_SYMBOL || "ETH",
  tokenDecimals: parseInt(process.env.TOKEN_DECIMALS || "18", 10),
};

try {
  if (!validateConfig(config)) {
    throw new Error("Invalid configuration");
  }
} catch (error) {
  logError("Configuration error:", error);
  process.exit(1);
}

export default config as Config;

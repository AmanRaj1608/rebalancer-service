export interface RebalanceOperation {
  id: string;
  token_address: string;
  token_decimals: number;
  amount_to_bridge: string;
  direction: "MAINNET_TO_MANTLE" | "MANTLE_TO_MAINNET";
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  bridge_txhash?: string;
}

export type Database = {
  public: {
    Tables: {
      rebalance_operations: RebalanceOperation;
    };
  };
};

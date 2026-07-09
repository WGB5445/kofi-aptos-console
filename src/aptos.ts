import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { FULLNODE_URL } from "./constants";

export const aptos = new Aptos(
  new AptosConfig({
    network: Network.MAINNET,
    fullnode: FULLNODE_URL,
  }),
);

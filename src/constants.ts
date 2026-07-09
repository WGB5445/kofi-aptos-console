export const FULLNODE_URL = "https://api.mainnet.aptoslabs.com/v1";
export const APT_METADATA_ADDRESS = "0xa";
export const KOFI_PACKAGE =
  "0x2cc52445acc4c5e5817a0ac475976fbef966fedb6e30e7db792e10619c76181f";
export const KAPT_METADATA_ADDRESS =
  "0x821c94e69bc7ca058c913b7b5e6b0a5c9fd1523d58723a966fb8c1f5ea888105";
export const STKAPT_METADATA_ADDRESS =
  "0x42556039b88593e768c97ab1a3ab0c6a17230825769304482dff8fdebe4c002b";
export const FUNGIBLE_ASSET_METADATA_TYPE = "0x1::fungible_asset::Metadata";
export const BALANCE_VIEW = "0x1::primary_fungible_store::balance";
export const GATEWAY_MODULE = `${KOFI_PACKAGE}::gateway`;
export const WITHDRAWAL_MANAGER_MODULE = `${KOFI_PACKAGE}::withdrawal_manager`;
export const CONFIG_MODULE = `${KOFI_PACKAGE}::config`;
export const REQUEST_EVENT_TYPE = `${WITHDRAWAL_MANAGER_MODULE}::WithdrawalRequestEvent`;
export const FINALIZE_EVENT_TYPE = `${WITHDRAWAL_MANAGER_MODULE}::WithdrawalFinalizedEvent`;
export const NETWORK_LABEL = "Aptos Mainnet";
export const DECIMALS = 8;

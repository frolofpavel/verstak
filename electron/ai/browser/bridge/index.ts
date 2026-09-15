// bridge/index.ts — public surface Connected Eyes.

export {
  EXTENSION_ID,
  EXTENSION_PUBLIC_KEY_B64,
  EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BROWSER_EXTENSION_VERSION,
  NATIVE_HOST_METADATA_FILE,
  MAX_MESSAGE_BYTES,
  BRIDGE_UI_STATES,
  type BridgeUiState,
} from './constants'

export {
  parseInboundMessage,
  serializeOutbound,
  encodeNativeFrame,
  NativeFrameDecoder,
  makeError,
  type BridgeInbound,
  type BridgeOutbound,
  type BridgePageSnapshot,
  type BridgeTabInfo,
} from './protocol'

export {
  createBridgeSessionStore,
  tokenFingerprint,
  BOOTSTRAP_CODE_TTL_MS,
  type BridgeSessionStore,
  type BridgeSessionState,
  type BootstrapCode,
  type PairingFile,
} from './session'

export {
  createBridgeServer,
  type BridgeServer,
  type BridgeServerDeps,
} from './server'

export {
  buildHostManifest,
  validateHostManifest,
  installNativeHost,
  uninstallNativeHost,
  writeNativeMessagingRegistry,
  readNativeMessagingRegistry,
  snapshotNativeMessagingRegistry,
  decodeRegistryOutput,
  removeNativeMessagingRegistry,
  chromeRegistryKey,
  edgeRegistryKey,
  buildHostCmdContent,
  resolveDevHostInstallDir,
  readInstalledManifest,
  resolveNativeHostPolicy,
  resolveDevUserDataOverride,
  browserBridgeVersions,
  readInstalledMetadata,
  validateInstalledHostBundle,
  hasStableInstallOwnerMarker,
  type HostManifest,
  type HostInstallResult,
  type NativeHostPolicy,
  type NativeHostPolicyMode,
  type BrowserBridgeVersions,
  type HostMetadata,
  type NativeMessagingRegistryAdapter,
  type NativeMessagingRegistrySnapshot,
  type NativeMessagingRegistrySnapshotEntry,
} from './host-lifecycle'

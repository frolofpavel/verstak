// bridge/index.ts — public surface Connected Eyes.

export {
  EXTENSION_ID,
  EXTENSION_PUBLIC_KEY_B64,
  EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
  BRIDGE_PROTOCOL_VERSION,
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
  removeNativeMessagingRegistry,
  chromeRegistryKey,
  edgeRegistryKey,
  buildHostCmdContent,
  resolveDevHostInstallDir,
  readInstalledManifest,
  type HostManifest,
  type HostInstallResult,
} from './host-lifecycle'

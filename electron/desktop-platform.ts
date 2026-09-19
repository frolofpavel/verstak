export interface DesktopPlatformCapabilities {
  autoUpdate: boolean
  browserEmployee: boolean
  computerUse: boolean
}

export function desktopPlatformCapabilities(
  platform: NodeJS.Platform = process.platform,
): DesktopPlatformCapabilities {
  const windows = platform === 'win32'
  return {
    autoUpdate: windows,
    browserEmployee: windows,
    computerUse: windows,
  }
}

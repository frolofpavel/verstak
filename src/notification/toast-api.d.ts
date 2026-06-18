declare global {
  interface Window {
    toastApi: {
      onShow: (cb: (payload: {
        title?: string
        body: string
        projectName?: string
        projectPath?: string
        isHelp?: boolean
        helpProjectPath?: string
        isError?: boolean
        theme?: 'nord' | 'light'
      }) => void) => () => void
      focusMain: (projectPath?: string, openHelp?: boolean) => void
      hideWindow: () => void
    }
  }
}

export {}
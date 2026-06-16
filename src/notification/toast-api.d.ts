declare global {
  interface Window {
    toastApi: {
      onShow: (cb: (payload: {
        title?: string
        body: string
        projectName?: string
        isError?: boolean
        theme?: 'nord' | 'light'
      }) => void) => () => void
      focusMain: () => void
      hideWindow: () => void
    }
  }
}

export {}
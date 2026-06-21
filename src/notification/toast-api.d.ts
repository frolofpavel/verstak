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
        reminderId?: number
        chatId?: number
        kind?: 'reminder' | 'chat-reminder-sent'
        persistent?: boolean
      }) => void) => () => void
      focusMain: (projectPath?: string, openHelp?: boolean, chatId?: number) => void
      reminderSnooze: (id: number) => void
      reminderDismiss: (id: number) => void
      reminderOpen: (id: number) => void
      hideWindow: () => void
    }
  }
}

export {}

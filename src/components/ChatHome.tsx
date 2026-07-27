interface ChatHomeProps {
  title: string
}

export function ChatHome({ title }: ChatHomeProps) {
  return (
    <div className="gg-chat-home" role="status">
      <h1 className="gg-chat-home-title">{title}</h1>
    </div>
  )
}

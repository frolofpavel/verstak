import { useState, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/core'

// Load only languages we expect to see in dev chats — keeps bundle small.
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import diffLang from 'highlight.js/lib/languages/diff'
import shell from 'highlight.js/lib/languages/shell'
import 'highlight.js/styles/github-dark.css'
import { isMarkdownCodeBlock, markdownCodeLanguage } from '../lib/markdown-code'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('zsh', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('rs', rust)
hljs.registerLanguage('diff', diffLang)

interface CodeBlockProps {
  language: string
  code: string
}

function highlightForBlock(language: string, code: string): { html: string | null; label: string } {
  if (language && hljs.getLanguage(language)) {
    try {
      return {
        html: hljs.highlight(code, { language, ignoreIllegals: true }).value,
        label: language
      }
    } catch { /* plain text below */ }
  }
  return { html: null, label: language || 'text' }
}

function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const { html, label } = highlightForBlock(language, code)

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard denied */ }
  }

  return (
    <div className="gg-code-block">
      <div className="gg-code-header">
        <span>{label}</span>
        <button type="button" className="gg-code-copy" onClick={copy}>{copied ? 'скопировано' : 'копировать'}</button>
      </div>
      <pre><code className={html ? 'hljs' : undefined}>{html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : code}</code></pre>
    </div>
  )
}

const CodeBlockMemo = memo(CodeBlock)

interface MarkdownProps {
  text: string
}

export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  return (
    <div className="gg-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children } = props
            const code = String(children).replace(/\n$/, '')
            if (!isMarkdownCodeBlock(className, code)) {
              return <code className={className}>{children}</code>
            }
            return <CodeBlockMemo language={markdownCodeLanguage(className)} code={code} />
          },
          pre({ children }) {
            return <>{children}</>
          },
          // Ссылки в чате открываем в системном браузере, а не уводим окно
          // приложения (Electron-footgun). Бэкенд app:open-external пускает
          // только http/https.
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={e => {
                  e.preventDefault()
                  if (href) void window.api.app.openExternal(href)
                }}
              >{children}</a>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
export type SecurityCategory =
  | 'path-escape'
  | 'command-binding'
  | 'ssrf'
  | 'config-mutation'
  | 'dotenv-guard'
  | 'secret-leak'
  // Уничтожение секрета собственным инструментом отката — не утечка: утечку
  // отзывают сменой ключа, затёртое значение восстановить неоткуда.
  | 'secret-destruction'
  | 'prompt-injection'

export interface SecurityRule {
  id: string
  ghsa?: string
  cwe?: string
  category: SecurityCategory
  severity: 'warn' | 'block'
  title: string
  status: 'active' | 'pending'
  testFile?: string
  pendingReason?: string
  source?: string
}

export const SECURITY_RULES: SecurityRule[] = [
  {
    id: 'SEC-PATH-01',
    cwe: 'CWE-22',
    category: 'path-escape',
    severity: 'warn',
    title: 'Explicit absolute read outside project remains read-only',
    status: 'active',
    testFile: './path-escape.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:2432'
  },
  {
    id: 'SEC-PATH-02',
    cwe: 'CWE-22',
    category: 'path-escape',
    severity: 'block',
    title: 'Absolute write is allowed only inside configured external roots',
    status: 'active',
    testFile: './path-escape.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:2770'
  },
  {
    id: 'SEC-PATH-03',
    cwe: 'CWE-22',
    category: 'path-escape',
    severity: 'block',
    title: 'Absolute write outside project, downloads, and allowed roots is blocked',
    status: 'active',
    testFile: './path-escape.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:2770'
  },
  {
    id: 'SEC-PATH-04',
    cwe: 'CWE-22',
    category: 'path-escape',
    severity: 'block',
    title: 'Symlink escape from an allowed writable root is blocked',
    status: 'active',
    testFile: './path-escape.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:2432'
  },
  {
    id: 'SEC-CMD-01',
    cwe: 'CWE-178',
    category: 'command-binding',
    severity: 'block',
    title: 'The command shown for approval is the command executed after approval',
    status: 'active',
    testFile: './command-binding.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:829'
  },
  {
    id: 'SEC-CMD-02',
    cwe: 'CWE-178',
    category: 'command-binding',
    severity: 'block',
    title: 'Dangerous command chains are classified as a whole command',
    status: 'active',
    testFile: './command-binding.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:1937'
  },
  {
    id: 'SEC-CMD-03',
    cwe: 'CWE-78',
    category: 'command-binding',
    severity: 'block',
    title: 'Dangerous command detector covers destructive and obfuscated shell commands',
    status: 'active',
    testFile: '../ai/dangerous-commands.test.ts',
    source: 'Hermes tools/approval.py:546'
  },
  {
    id: 'SEC-CFG-01',
    cwe: 'CWE-922',
    category: 'config-mutation',
    severity: 'block',
    title: 'Agent tool definitions do not expose settings or secret mutation tools',
    status: 'active',
    testFile: './config-mutation.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:3831'
  },
  {
    id: 'SEC-CFG-02',
    cwe: 'CWE-922',
    category: 'config-mutation',
    severity: 'block',
    title: 'Encrypted settings are not stored as plaintext when safeStorage is available',
    status: 'active',
    testFile: './config-mutation.test.ts',
    source: 'Electron safeStorage boundary'
  },
  {
    id: 'SEC-DOTENV-01',
    cwe: 'CWE-200',
    category: 'dotenv-guard',
    severity: 'block',
    title: 'Workspace dotenv files and Verstak/ClawHub/OpenClaw env keys are forbidden agent context',
    status: 'active',
    testFile: './dotenv-guard.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:3831'
  },
  {
    id: 'SEC-SSRF-01',
    cwe: 'CWE-918',
    category: 'ssrf',
    severity: 'block',
    title: 'Literal private and loopback web hosts are blocked',
    status: 'active',
    testFile: './ssrf.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:3709'
  },
  {
    id: 'SEC-SSRF-02',
    cwe: 'CWE-918',
    category: 'ssrf',
    severity: 'block',
    title: 'Redirects to private hosts are revalidated and blocked',
    status: 'active',
    testFile: './ssrf.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:3709'
  },
  {
    id: 'SEC-SSRF-03',
    cwe: 'CWE-918',
    category: 'ssrf',
    severity: 'block',
    title: 'Cloud metadata endpoints are blocked',
    status: 'active',
    testFile: './ssrf.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:1690'
  },
  {
    id: 'SEC-SSRF-04',
    cwe: 'CWE-200',
    category: 'secret-leak',
    severity: 'block',
    title: 'URL query and fragment secrets are redacted before logs or traces',
    status: 'active',
    testFile: './ssrf.test.ts',
    source: 'OpenClaw security/opengrep/precise.yml:3831'
  },
  {
    id: 'SEC-SECRET-01',
    cwe: 'CWE-212',
    category: 'secret-destruction',
    severity: 'block',
    title: 'The write path reads raw content, so an edit and its undo never overwrite a live secret with a scanner placeholder',
    status: 'active',
    testFile: './secret-write-path.test.ts',
    source: 'Verstak incident 2026-07-29: undo restored [REDACTED:...] over the real value'
  },
  {
    id: 'SEC-SECRET-02',
    cwe: 'CWE-200',
    category: 'secret-leak',
    severity: 'block',
    title: 'File content leaves the main process from exactly one place, and it carries a masked secret with type, fingerprint and direction — never the value',
    status: 'active',
    testFile: './secret-write-path.test.ts',
    source: 'Verstak incident 2026-07-29: pending-write events of a phone-started run are forwarded verbatim to an external relay'
  },
  {
    id: 'SEC-SECRET-03',
    cwe: 'CWE-200',
    category: 'secret-leak',
    severity: 'block',
    title: 'The undo stack keeps raw file content inside main only — undo:list hands the renderer a summary with no content at all',
    status: 'active',
    testFile: './undo-list-no-content.test.ts',
    source: 'Verstak 2026-07-29: raw before-content became a real secret once the write path stopped reading through the scanner'
  },
  {
    id: 'SEC-SECRET-04',
    cwe: 'CWE-200',
    category: 'secret-leak',
    severity: 'block',
    title: 'Exact-rewind backups never cross the main boundary — the renderer holds a one-shot token, and unrevert no longer accepts file content from outside',
    status: 'active',
    testFile: './exact-rewind-no-content.test.ts',
    source: 'Verstak 2026-07-30: execute shipped raw backups of every rewound file to the renderer and took them back verbatim'
  }
]

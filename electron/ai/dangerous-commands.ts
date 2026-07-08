export type DangerousSeverity = 'warn' | 'block'

export interface DangerousHit {
  hit: boolean
  pattern?: string
  reason?: string
  severity: DangerousSeverity
  deobfuscated: string
  matchedOn: 'raw' | 'deobfuscated'
}

interface DangerousPattern {
  id: string
  pattern: RegExp
  severity: DangerousSeverity
  reason: string
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { id: 'rm-recursive-force-root', pattern: /\brm\b(?=[^\n]*\b-[a-z]*r[a-z]*\b|[^\n]*-r\b)(?=[^\n]*-[a-z]*f|[^\n]*-f\b)[^\n]*\s+(\/|~|\$HOME|\.\.)/i, severity: 'block', reason: 'Запрещено: rm -r -f за пределами проекта или на корень' },
  { id: 'rm-rf-root', pattern: /\brm\s+(-[a-z]*r[a-z]*f?|-rf|-fr|-r\s+-f|-f\s+-r)\s+(\/|~|\$HOME|\.\.|[A-Za-z]:[\\/])/i, severity: 'block', reason: 'Запрещено: rm -rf за пределами проекта или на корень' },
  { id: 'windows-del-tree', pattern: /\b(?:del|erase|rmdir|rd)\b[^\n]*(?:\/s|\/q)[^\n]*(?:[A-Za-z]:[\\/]|%USERPROFILE%|%HOMEPATH%|\\Windows|\\Users)/i, severity: 'block', reason: 'Запрещено: массовое удаление системных Windows-путей' },
  { id: 'powershell-remove-tree', pattern: /\b(?:remove-item|rm|del|erase)\b[^\n]*(?:-recurse|-r)\b[^\n]*(?:-force|-f)\b[^\n]*(?:[A-Za-z]:[\\/]|~|\$HOME|\.\.)/i, severity: 'block', reason: 'Запрещено: PowerShell Remove-Item -Recurse -Force за пределами проекта' },
  { id: 'disk-tools', pattern: /\b(format|mkfs(?:\.\w+)?|fdisk|diskpart|parted|sfdisk|wipefs)\b/i, severity: 'block', reason: 'Запрещено: операции над дисками / файловой системой' },
  { id: 'dd-raw-device', pattern: /\bdd\b[^\n]*(?:of=\/dev\/|of=\\\\\.\\PhysicalDrive|of=[A-Za-z]:)/i, severity: 'block', reason: 'Запрещено: запись на сырой блочный девайс через dd' },
  { id: 'block-device-redirect', pattern: /(^|\s)>\s*\/dev\/(?:sd|hd|nvme|mapper|disk)\w*/i, severity: 'block', reason: 'Запрещено: перенаправление вывода на блочный девайс' },
  { id: 'fork-bomb', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, severity: 'block', reason: 'Запрещено: fork-bomb' },
  { id: 'system-power', pattern: /\b(shutdown|reboot|halt|poweroff|stop-computer|restart-computer)\b/i, severity: 'block', reason: 'Запрещено: выключение / перезагрузка системы' },
  { id: 'curl-pipe-shell', pattern: /\b(?:curl|curl\.exe)\b[^|]*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)\b/i, severity: 'block', reason: 'Запрещено: pipe curl-вывода в shell (классический RCE-вектор)' },
  { id: 'wget-pipe-shell', pattern: /\b(wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|iex|powershell|pwsh|cmd)\b/i, severity: 'block', reason: 'Запрещено: pipe сетевого ответа в shell' },
  { id: 'base64-pipe-shell', pattern: /\bbase64\b[\s\S]*?(?:-d|--decode)[\s\S]*?\|\s*(?:sh|bash|zsh|powershell|pwsh|cmd|iex)\b/i, severity: 'block', reason: 'Запрещено: декодирование base64 в shell (обфускация RCE)' },
  { id: 'openssl-decode-pipe-shell', pattern: /\bopenssl\b[\s\S]*?\benc\b[\s\S]*?-d[\s\S]*?\|\s*(?:sh|bash|zsh|powershell|pwsh|cmd|iex)\b/i, severity: 'block', reason: 'Запрещено: декодирование payload в shell' },
  { id: 'sudo-rm', pattern: /\b(?:sudo|doas)\s+rm\b/i, severity: 'block', reason: 'Запрещено: sudo rm' },
  { id: 'git-force-push', pattern: /\bgit\s+push\s+.*--force\b/i, severity: 'block', reason: 'Запрещено: git push --force (фиксить вручную при необходимости)' },
  { id: 'git-destructive', pattern: /\bgit\s+(reset\s+--hard\s+HEAD~|clean\s+-fdx|filter-(repo|branch))/i, severity: 'block', reason: 'Запрещено: разрушающие git операции' },
  { id: 'find-exec-rm-recursive', pattern: /\bfind\b[\s\S]*-exec(?:dir)?\b[\s\S]*\brm\b[\s\S]*(?:-[a-z]*r|--recursive)/i, severity: 'block', reason: 'Запрещено: рекурсивное удаление через find -exec rm -r' },
  { id: 'secret-paths', pattern: /\.ssh|\.ss\*|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\bid_[a-z0-9]*\*|\.aws[\/\\]|\.kube[\/\\]|\.docker[\/\\]|\.azure[\/\\]|\.config[\/\\]gcloud|kubeconfig|\.npmrc|\.netrc|\.gnupg|authorized_keys|known_hosts/i, severity: 'block', reason: 'Запрещено: чтение/копирование ключей и токенов' },
  { id: 'powershell-encoded-command', pattern: /\b(?:powershell|pwsh)(\.exe)?\b[^\n]*\s-[eE](?:nc(?:oded(?:command)?)?)?\b/i, severity: 'block', reason: 'Запрещено: powershell/pwsh -EncodedCommand (запутанная команда)' },
  { id: 'cmd-variable-expansion', pattern: /\bcmd(\.exe)?\s+\/[cC]\b[^\n]*(%[^%\s]+%|![\w]+!)/i, severity: 'block', reason: 'Запрещено: cmd /c с переменными расширения — попытка обфускации' },
  { id: 'powershell-eval', pattern: /\b(iex|invoke-expression)\b/i, severity: 'block', reason: 'Запрещено: PowerShell Invoke-Expression / iex' },
  // eval динамики/декодированного payload — обход детектора: сам rm/base64 спрятан
  // в подстановке ($(...)/backtick), переменной ($X) или декодере. eval требуется
  // в командной позиции (начало/после ;&|() ), чтобы не ловить «eval» как подстроку
  // (напр. npm run test:eval). Known-limit: чистая индирекция через переменную без
  // eval (X=rm; $X -rf /) не ловится — нужна shell-семантика, не regex.
  { id: 'shell-eval-dynamic', pattern: /(?:^|[\n;&|(])\s*eval\s+[^\n]*(?:\$\(|`|\$\{?[A-Za-z_]|\bbase64\b|\bxxd\b|\bopenssl\b)/i, severity: 'block', reason: 'Запрещено: eval динамического/декодированного содержимого (обфускация RCE)' },
  { id: 'chmod-world-writable', pattern: /\bchmod\b[^\n]*(?:-R|--recursive)[^\n]*777\b/i, severity: 'block', reason: 'Запрещено: chmod -R 777' },
  { id: 'chown-recursive-system', pattern: /\bchown\b[^\n]*(?:-R|--recursive)[^\n]*(?:\/|~|\$HOME|\.\.)/i, severity: 'block', reason: 'Запрещено: chown -R системных или внешних путей' },
  { id: 'network-shell', pattern: /\b(?:nc|ncat|netcat|socat)\b[^\n]*(?:-e\s|exec:|\/dev\/tcp\/|\bconnect:)/i, severity: 'block', reason: 'Запрещено: сетевой shell / reverse shell' },
  { id: 'bash-dev-tcp', pattern: /\/dev\/tcp\/[^\s]+\/\d+/i, severity: 'block', reason: 'Запрещено: shell-соединение через /dev/tcp' },
  { id: 'python-exec-child-process', pattern: /\bpython(?:3)?\b[^\n]*\s-c\s+['"][\s\S]*(?:subprocess|os\.system|pty\.spawn|socket)/i, severity: 'block', reason: 'Запрещено: python -c с произвольным системным исполнением' },
  { id: 'node-eval-child-process', pattern: /\bnode\b[^\n]*\s-e\s+['"][\s\S]*(?:child_process|require\(['"]fs['"]\)\.rm|process\.env)/i, severity: 'block', reason: 'Запрещено: node -e с child_process/secret access' },
  { id: 'perl-ruby-exec', pattern: /\b(?:perl|ruby)\b[^\n]*\s-e\s+['"][\s\S]*(?:system|exec|open\|)/i, severity: 'block', reason: 'Запрещено: perl/ruby -e с системным исполнением' },
  { id: 'npx-remote-exec', pattern: /\bnpx\b[^\n]*(?:github:|https?:\/\/|--yes|-y)\b/i, severity: 'block', reason: 'Запрещено: npx remote/fetch-and-exec без явного ручного контроля' },
  { id: 'npm-global-install', pattern: /\bnpm\b\s+(?:i|install|add)\b[^\n]*(?:-g|--global)\b/i, severity: 'block', reason: 'Запрещено: глобальная установка npm-пакетов агентом' },
  { id: 'curl-sensitive-upload', pattern: /\bcurl\b[^\n]*(?:-F|--form|-T|--upload-file|--data-binary)\b[^\n]*(?:\.env|\.ssh|id_rsa|id_ed25519|\.npmrc|credentials)/i, severity: 'block', reason: 'Запрещено: отправка секретных файлов наружу' },
  { id: 'scp-sensitive-upload', pattern: /\b(?:scp|rsync)\b[^\n]*(?:\.env|\.ssh|id_rsa|id_ed25519|\.npmrc|credentials)/i, severity: 'block', reason: 'Запрещено: копирование секретных файлов наружу' },
  { id: 'ssh-private-key-print', pattern: /\b(?:cat|type|more|less|head|tail|grep|rg)\b[^\n]*(?:id_rsa|id_ed25519|\.pem|\.key|\.ssh[\/\\])/i, severity: 'block', reason: 'Запрещено: вывод приватных ключей' },
  { id: 'env-dump-network', pattern: /\b(?:env|printenv|set)\b[^\n]*\|\s*(?:curl|wget|nc|ncat|netcat|socat)\b/i, severity: 'block', reason: 'Запрещено: отправка env наружу' },
  { id: 'tar-over-root', pattern: /\btar\b[^\n]*(?:-C\s+\/|--directory\s+\/)[^\n]*(?:-x|--extract)/i, severity: 'block', reason: 'Запрещено: распаковка архива в корень системы' },
  { id: 'chmod-suid', pattern: /\bchmod\b[^\n]*(?:\+s|[475][0-7]{3})\b/i, severity: 'block', reason: 'Запрещено: установка SUID/SGID битов' },
  { id: 'launchctl-system', pattern: /\b(?:launchctl|sc\.exe|schtasks)\b[^\n]*(?:load|create|start|enable|delete|remove)/i, severity: 'block', reason: 'Запрещено: изменение системных автозапусков' },
  { id: 'iptables-firewall', pattern: /\b(?:iptables|ufw|firewall-cmd|netsh)\b[^\n]*(?:-F|flush|disable|reset|delete|add)/i, severity: 'block', reason: 'Запрещено: изменение firewall/network policy агентом' },
  { id: 'docker-host-mount', pattern: /\bdocker\b[^\n]*(?:run|create)[^\n]*-v\s+\/:/i, severity: 'block', reason: 'Запрещено: docker с монтированием корня хоста' },
  { id: 'kubectl-mutating', pattern: /\bkubectl\b\s+(?:apply|delete|replace|patch|scale|cordon|drain|taint)\b/i, severity: 'block', reason: 'Запрещено: мутации Kubernetes без отдельного подтверждения' },
  { id: 'terraform-mutating', pattern: /\bterraform\b\s+(?:apply|destroy)\b/i, severity: 'block', reason: 'Запрещено: terraform apply/destroy агентом' },
  { id: 'cloud-cli-mutating', pattern: /\b(?:aws|gcloud|az)\b[^\n]*(?:delete|remove|terminate|destroy|revoke|put-policy|set-iam-policy)\b/i, severity: 'block', reason: 'Запрещено: опасные cloud CLI мутации' },
  { id: 'registry-delete', pattern: /\b(?:reg\s+delete|regedit\b[^\n]*\/s)\b/i, severity: 'block', reason: 'Запрещено: изменение Windows registry агентом' },
  { id: 'credential-store-read', pattern: /\b(?:security\s+find-generic-password|cmdkey\s+\/list|secret-tool\s+lookup|pass\s+show)\b/i, severity: 'block', reason: 'Запрещено: чтение системного хранилища секретов' },
  { id: 'history-secret-dump', pattern: /\b(?:cat|type|grep|rg)\b[^\n]*(?:\.bash_history|\.zsh_history|ConsoleHost_history\.txt|History\.sqlite)/i, severity: 'block', reason: 'Запрещено: чтение shell/browser history с секретами' },
  { id: 'browser-profile-copy', pattern: /\b(?:cp|copy|robocopy|xcopy|tar|zip)\b[^\n]*(?:Cookies|Login Data|Local State|Default[\/\\]Network)/i, severity: 'block', reason: 'Запрещено: копирование браузерных профилей/куки' },
  { id: 'hosts-file-edit', pattern: /\b(?:echo|printf|set-content|add-content|copy)\b[^\n]*(?:\/etc\/hosts|\\drivers\\etc\\hosts)/i, severity: 'block', reason: 'Запрещено: изменение hosts-файла агентом' },
  { id: 'self-delete', pattern: /\b(?:rm|del|erase|remove-item)\b[^\n]*(?:node_modules|release|out)[^\n]*(?:-r|-recurse|\/s)/i, severity: 'block', reason: 'Запрещено: массовое удаление build/runtime каталогов' }
]

function normalize(s: string): string {
  return s.replace(/[\t ]+/g, ' ').trim()
}

export function deobfuscateShellWord(s: string): string {
  return s
    .replace(/\$\{IFS\}|\$IFS/gi, ' ')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([^\r\n])/g, '$1')
    .replace(/[`'"^]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function detectDangerousCommand(command: string): DangerousHit {
  const raw = normalize(command)
  const deobfuscated = normalize(deobfuscateShellWord(command))

  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(raw)) {
      return { hit: true, pattern: rule.id, reason: rule.reason, severity: rule.severity, deobfuscated, matchedOn: 'raw' }
    }
    if (deobfuscated !== raw && rule.pattern.test(deobfuscated)) {
      return { hit: true, pattern: rule.id, reason: rule.reason, severity: rule.severity, deobfuscated, matchedOn: 'deobfuscated' }
    }
  }

  return { hit: false, severity: 'warn', deobfuscated, matchedOn: 'raw' }
}

export function dangerousCommandReasons(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const rule of DANGEROUS_PATTERNS) {
    if (!seen.has(rule.reason)) {
      seen.add(rule.reason)
      out.push(rule.reason)
    }
  }
  return out
}


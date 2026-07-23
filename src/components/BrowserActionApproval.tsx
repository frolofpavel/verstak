// BrowserActionApproval.tsx — EXT-B0/R1 модалка подтверждения browser action.
//
// Показывается когда controller возвращает decision=require-approval (R3
// mutation). Пользователь видит:
//   • task / client / tenant / account / домен
//   • action type + payload (redacted)
//   • target (elementRef / URL)
//   • риск + ожидаемый postcondition
// Approve/Reject идут через resolveBrowserAction(actionId, digest, taskId, runId,
// approved, sendId) — controller сверит canonical digest с тем, что показал UI.
//
// BR-017: одноразовое, scoped, atomic. После approve контроллер consume'ит
// approval и execute'ит ровно один раз. После reject — handler не вызывает adapter.

import { useProject } from '../store/projectStore'

const RISK_LABEL: Record<string, string> = {
  R0: 'R0 — чтение',
  R1: 'R1 — доказуемо обратимое',
  R2: 'R2 — подготовка черновика',
  R3: 'R3 — внешняя мутация',
  R4: 'R4 — запрещено',
}

export function BrowserActionApproval() {
  const { pendingBrowserAction, setPendingBrowserAction } = useProject()
  if (!pendingBrowserAction) return null
  const ref = pendingBrowserAction
  const snap = ref.snapshot

  async function approve() {
    // digest из event payload — controller сверит его с canonical digest
    // из ledger. Любая подмена actionType/payload/scope → digest не совпадёт.
    await window.api.ai.resolveBrowserAction(
      ref.actionId,
      ref.approvalDigest,
      ref.browserTaskId,
      ref.runId,
      true,
      ref.sendId,
    )
    setPendingBrowserAction(null)
  }
  async function reject() {
    await window.api.ai.resolveBrowserAction(
      ref.actionId,
      ref.approvalDigest,
      ref.browserTaskId,
      ref.runId,
      false,
      ref.sendId,
    )
    setPendingBrowserAction(null)
  }

  const scope = (snap.scope ?? {}) as Record<string, unknown>
  const payload = (snap.payload ?? {}) as Record<string, unknown>
  const postcondition = (snap.expectedPostcondition ?? null) as Record<string, unknown> | null
  // Type-narrowing helpers: unknown → safe primitives for rendering.
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
  const hasStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

  return (
    <div className="gg-modal-backdrop" onClick={reject}>
      <div className="gg-modal gg-modal-large" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div>
            <div className="gg-modal-title">AI хочет выполнить действие в браузере</div>
            <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4 }}>
              {ref.reason}
            </div>
          </div>
        </div>

        <div className="gg-modal-body" style={{ padding: '16px 22px' }}>
          <div className="gg-browser-action-grid">
            <Row label="Действие">
              <code>{String(snap.actionType)}</code>
              <span className="gg-browser-action-risk gg-browser-action-risk-r3">{RISK_LABEL[ref.risk] ?? ref.risk}</span>
            </Row>
            <Row label="Task / Run">
              <div className="gg-text-secondary" style={{ fontSize: 'var(--text-xs)' }}>
                task: <code>{ref.browserTaskId}</code><br />
                run: <code>{ref.runId}</code>
              </div>
            </Row>
            {snap.clientId && (
              <Row label="Клиент"><code>{str(snap.clientId)}</code></Row>
            )}
            {hasStr(scope.origin) && (
              <Row label="Домен (origin)"><code>{str(scope.origin)}</code></Row>
            )}
            {hasStr(scope.url) && (
              <Row label="URL страницы"><code className="gg-browser-action-url">{str(scope.url)}</code></Row>
            )}
            {hasStr(scope.tenant) && (
              <Row label="Кабинет (tenant)"><code>{str(scope.tenant)}</code></Row>
            )}
            {hasStr(scope.account) && (
              <Row label="Аккаунт"><code>{str(scope.account)}</code></Row>
            )}
            {(hasStr(scope.elementRef) || hasStr(payload.elementRef) || hasStr(payload.selector)) && (
              <Row label="Target">
                <code>{str(scope.elementRef ?? payload.elementRef ?? payload.selector)}</code>
              </Row>
            )}
            {hasStr(payload.url) && (
              <Row label="Целевой URL"><code className="gg-browser-action-url">{str(payload.url)}</code></Row>
            )}
            {payload.text != null && (
              <Row label="Текст для ввода">
                <code className="gg-browser-action-text">{str(payload.text)}</code>
              </Row>
            )}
            {hasStr(payload.key) && (
              <Row label="Клавиша"><code>{str(payload.key)}</code></Row>
            )}
            {postcondition && (hasStr(postcondition.urlContains) || hasStr(postcondition.textAppears) || hasStr(postcondition.textDisappears)) && (
              <Row label="Ожидаемый результат">
                <div className="gg-text-secondary" style={{ fontSize: 'var(--text-xs)' }}>
                  {hasStr(postcondition.urlContains) && <div>URL будет содержать: <code>{str(postcondition.urlContains)}</code></div>}
                  {hasStr(postcondition.textAppears) && <div>Появится текст: <code>{str(postcondition.textAppears)}</code></div>}
                  {hasStr(postcondition.textDisappears) && <div>Исчезнет текст: <code>{str(postcondition.textDisappears)}</code></div>}
                </div>
              </Row>
            )}
          </div>

          <div className="gg-browser-action-warning">
            После подтверждения действие выполнится ровно один раз. Approval
            одноразовое, scoped, атомарное — повторное использование невозможно.
            Отмена выполнения требует ручного undo на сайте.
          </div>
        </div>

        <div className="gg-modal-footer">
          <button className="gg-btn gg-btn-danger" onClick={reject}>Отклонить</button>
          <button className="gg-btn gg-btn-success" onClick={approve}>Выполнить один раз</button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="gg-browser-action-row">
      <div className="gg-browser-action-label">{label}</div>
      <div className="gg-browser-action-value">{children}</div>
    </div>
  )
}

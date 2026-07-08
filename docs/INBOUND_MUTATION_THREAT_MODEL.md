# Inbound Mutation Threat Model

Status: decided, design-only.
Date: 2026-07-08.

## Scope

Inbound mutation means any external channel asking Verstak to change local files, run commands, mutate connectors, approve agent actions, send messages, or control app lifecycle.

Examples:

- Telegram, Bitrix, webhook, browser callback, MCP server, connector, or remote operator says "apply this patch".
- External channel asks to run a shell command, send a connector write, stop/restart Verstak, or continue an agent run.
- A scheduled or background flow receives external data that includes instructions.

## Decision

Verstak does not execute inbound mutations directly.

All inbound mutation requests must become pending local approvals first. The human must approve the exact action inside the desktop app before any side effect happens.

Allowed without approval:

- Read-only status queries.
- Notification delivery.
- Proof Pack delivery that was explicitly configured as outgoing opt-in.
- Local UI navigation.

Blocked or approval-required:

- File writes, patch application, command execution.
- Connector writes, messages, webhooks, CRM updates, SSH execution.
- App lifecycle controls: stop, restart, shutdown, kill scheduler.
- Changes to provider keys, auth, model policy, safety policy, or trusted roots.
- Any request containing secrets or asking to reveal stored secrets.

## Safety Rules

- Fail closed when the channel, user identity, or approval state is unclear.
- Store only redacted request summaries in logs.
- Never log API keys, tokens, cookies, env values, or raw external payloads with secrets.
- Approval must show target, action type, source channel, and bounded payload.
- Approval must be one-shot. A previous approval does not authorize future inbound mutations.
- Production or connector writes require the same local approval path as agent tool writes.

## Non-Goals

- No always-on remote control channel in this sprint.
- No mobile/device-pairing clone.
- No broad messaging gateway.
- No automatic external approve over Telegram.

## Implementation Notes

Current sprint keeps this as a guardrail document. Future implementation should route inbound mutation candidates into the existing confirmation model instead of adding a parallel approval path.

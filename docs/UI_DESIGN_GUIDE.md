# Verstak UI Design Guide

Last updated: 2026-07-11
Status: required reference for all new UI work

## Source Of Truth

The current connector card is the visual baseline for Verstak UI.

Use it as the reference for:

- buttons
- cards
- expandable panels
- settings blocks
- selector rows
- inline controls
- tool panels
- empty and error states

Reference implementation:

- `src/components/Settings.tsx`
- `src/styles/layout.css`
- Connector V3 classes: `.gg-connector-service-card-v3`, `.gg-connector-panel-v3`, `.gg-connector-panel-section`, `.gg-input`

If another screen visually conflicts with this card style, adjust that screen toward the connector card style instead of inventing a new visual language.

## Product Scope

Verstak is a universal AI workspace for many types of business and project work, not a tool only for Yandex Direct or advertising.

When designing or editing project-level features, keep the product neutral and cross-domain:

- digital agencies and ads across any platform
- Telegram, VK, Avito, CRM, websites, documents, support, analytics, design, code, layout, internal operations
- Yandex Direct examples are allowed only as one scenario among others
- user-facing copy must not imply that the app is built mainly for one ad platform
- templates and helper blocks should offer several project types when possible

If a feature can support both marketing and non-marketing work, name and structure it in a universal way first, then add marketing-specific examples inside optional templates or presets.

## Core Feel

Verstak UI should feel quiet, technical, compact, and precise.

The interface should not look like a marketing landing page, a generic SaaS template, or a set of unrelated widgets made by different people.

Use:

- restrained dark/light surfaces
- thin cyan/accent borders
- clear hierarchy through spacing and contrast
- recessed input fields
- subtle hover feedback
- compact text
- simple line icons

Avoid:

- oversized cards
- decorative glow blobs
- thick random side bars
- bright one-off colors
- heavy shadows on every element
- big status pills when a small lamp is enough
- text tags that duplicate descriptions
- bold mono labels for normal UI copy

## Card Standard

The standard card is close to the connector card:

- 1px border using `var(--border-subtle)`
- hover/open border using cyan/accent mix
- background from app surface tokens, not hardcoded random hex
- small radius, usually 10-18px depending on component size
- the connector card uses `var(--shadow-sm)` for quiet volume; derivative cards may use the same baseline shadow when matching connector cards
- hover must not add extra shadow, glow, lift, or transform beyond the baseline card volume
- no nested card-in-card look unless the inner block is a real section

The default border must be visible before hover. If `var(--border-subtle)` blends into the local surface, use an accent mix for the normal state:

```css
border-color: color-mix(in srgb, var(--accent) 16-28%, var(--border-subtle));
```

Do not ship cards where the user has to hover to discover the boundary or understand what belongs to the same block.

Current connector card pattern for connector cards:

```css
border: 1px solid var(--border-subtle);
background: var(--connector-identity-card);
box-shadow: var(--shadow-sm);
transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
```

Shadowless derivative for compact controls, inline buttons, selector rows, and dense setting controls:

```css
border: 1px solid var(--border-subtle);
background: var(--connector-identity-card);
box-shadow: none;
transition: border-color 150ms ease, background 150ms ease, color 150ms ease;
```

Hover/open state:

```css
border-color: color-mix(in srgb, var(--accent) 42%, var(--border-subtle));
background: var(--connector-identity-card);
```

Do not add a new hover style with extra glow, lift, large shadow, transform, or unrelated color unless the user explicitly asks for a different visual direction.

For settings cards, model cards, selector cards, and connector-like blocks, hover must be border-first and must preserve the baseline volume:

```css
box-shadow: var(--shadow-sm); /* if the baseline card has volume */
transform: none;
border-color: color-mix(in srgb, var(--accent) 42%, var(--border-subtle));
```

If a compact button, status chip, row, or toggle inherits `box-shadow`, `filter`, `transform`, or glow from shared `.gg-btn`, `.gg-card`, `.gg-settings-*`, or toggle styles, override it inside the component scope. Do not leave old shared hover effects active just because the main card looks correct.

## Internal Panels

Internal fields inside a card should be more contrasted than the card itself, but still in the same palette.

Use the connector section pattern:

```css
background: var(--connector-identity-block);
border: 1px solid color-mix(in srgb, var(--accent) 10%, var(--connector-identity-line));
border-radius: 10px;
```

All internal panels inside the same expanded card should use the same base color. Do not make one section greenish, blueish, or darker unless it is a specific status message.

Status should be shown through a small lamp, border, or text color, not by tinting the whole panel.

Expandable identity cards must open as one connected object:

- the collapsed card and expanded panel must touch with `gap: 0`
- the top card loses bottom radius when open
- the expanded panel loses top radius and top border
- do not leave a visible gap between the card header and its expanded body
- do not create a "card inside a card inside a card" effect for simple lists

For model/provider lists inside an expanded card, prefer a flat list of recessed rows on the panel background. Avoid wrapping the whole list in an additional framed box unless that box has a separate meaning.

For editor helper blocks, use one internal panel with flat divider rows. Do not turn every helper row into a separate framed card. The actual editable textarea/input remains the only clearly recessed writing surface.

## Input Fields

Input fields should look recessed.

Use:

```css
background: var(--connector-identity-field);
border-color: color-mix(in srgb, var(--accent) 12%, var(--border-default));
box-shadow: none;
```

Focus state:

```css
border-color: color-mix(in srgb, var(--accent) 54%, var(--border-subtle));
background: color-mix(in srgb, var(--connector-identity-field) 88%, var(--accent-muted) 12%);
```

Inputs should never look like bright floating pills on top of a dark panel.

## Buttons And Clickable Blocks

Every clickable control must look clickable before hover.

Use:

- visible border
- clear button shape
- restrained background
- hover border that moves toward cyan/accent
- explicit action text when the result is not obvious, such as `Добавить шаблон`, `Выбрать`, `Открыть`, `Проверить`

Do not rely only on cursor change or hover-only styling.

Template cards, quick-start cards, and preset cards must explain what happens after click. A card named only `Маркетинг` or `Базовый проект` is not enough if the action is to insert text into an editor. Add a compact action label such as `Добавить маркетинг` and a helper line like `Нажатие добавит текст в редактор`.

For settings that affect AI behavior, permissions, project memory, instructions, skills, or external tools, explain the effect before the user clicks:

- what will change
- whether it grants new permissions
- whether it can be edited or removed later
- the expected risk level in normal language

Do not make the user infer whether a preset is safe. A recommended preset must say why it is recommended and what it does.

For accordion rows, spoiler blocks, selector cards, and settings actions, use the connector-card hover language: thin accent border, no shadow, no lift, no large glow.

Small helper buttons such as `Где взять ключ` are outline buttons:

- transparent or parent-matching background
- visible 1px border before hover
- compact padding
- no filled dark pill unless the design explicitly calls for a filled primary button
- hover changes border color first, not background weight

If the action is not literally an API key, use the real action text (`Как подключить`, `Скачать`, `Открыть инструкцию`) instead of forcing `Где взять ключ`.

Canonical square icon button:

- use the shared `gg-provider-settings-toggle` visual class for settings, collapse, expand, and compact icon-only actions that match the provider gear button
- use a real `button` element with `gg-btn gg-btn-ghost gg-provider-settings-toggle gg-provider-action-icon` when the control is clickable
- do not recreate the same button with section-specific classes such as a separate model-only background
- the button must stay 32x32px, 10px radius, `var(--providers-field)` background, 1px accent-mixed border, no one-off colors
- hover and open states must use the same shared selector, not local copies
- if a section needs a semantic wrapper class, add it alongside the shared class without overriding background, border, shadow, color, size, or radius

## Status Indicators

Prefer small lamps over large status pills when the status is obvious from context.

Recommended:

- green lamp: connected / ready / available
- red lamp: error / unavailable
- muted lamp: saved but unchecked / inactive
- cyan/accent lamp: checking / active process

Avoid showing redundant labels like `Подключён` directly on compact cards when a lamp plus details inside the card is enough.

Detailed status text belongs inside the expanded panel, not on the compact card.

Standard lamp style:

- outer hit/slot area: 16x16px
- visible dot: 8x8px
- soft glow from the same semantic color
- same colors across the app: `var(--success)`, `var(--error)`, `var(--accent)`, `var(--warning)`
- do not use one-off greens, reds, or cyan tones for different sections

Canonical implementation for small status lamps is the connector status dot:

```css
width: 8px;
height: 8px;
border-radius: 999px;
background: currentColor;
box-shadow: 0 0 8px color-mix(in srgb, currentColor 54%, transparent);
```

Use the semantic lamp tokens everywhere:

- `var(--status-lamp-ok)` for ready, connected, allowed, completed
- `var(--status-lamp-warn)` for needs confirmation, warning, partial access
- `var(--status-lamp-error)` for blocked, error, unavailable
- `var(--status-lamp-work)` for checking, running, active process

Do not create alternate lamp styles with `box-shadow: 0 0 0 3px ...`, large halos, ring-like status dots, hardcoded colors, or section-specific glow sizes. If a lamp needs text next to it, keep the same dot style and place the text in the surrounding chip or row.

For compact settings/model cards, status must live in a stable slot. Do not place status text inside a wrapping metadata row where long provider names, counts, or buttons can push it to another line or another column. Use fixed layout areas such as:

- title/name
- metadata
- connection status
- actions

All cards in the same list must keep the same status position in both dark and light themes.

## Tags And Metadata

Tags may exist for search and matching, but should not be visible by default if the description already explains the item.

Visible tags are allowed only when they help the user make a decision faster than plain text.

Bad:

- `CRM`, `Сделки`, `Задачи`, `Контакты` repeated under a connector description that already says `CRM, сделки, задачи`

Good:

- hidden search metadata in code
- short status or capability chips inside an expanded detail section

## Typography

Use normal readable weights.

Avoid bold mono text for UI labels and chips. It becomes visually noisy and hard to read in Verstak.

Verstak typography scale:

- page title: Inter/sans, 18px, 600
- major card title: Inter/sans, 16px, 600
- card title / row title: Inter/sans, 14px, 600
- body text: Inter/sans, 13px, 400-500, `var(--text-secondary)` when descriptive
- helper text / metadata: Inter/sans, 12px, 400-500, `var(--text-tertiary)` or `var(--text-secondary)`
- compact chips and small buttons: Inter/sans, 12-13px, 500-600
- section eyebrow: JetBrains Mono, 10-11px, 500, uppercase, letter spacing 0.06-0.08em
- code/editor text: JetBrains Mono, 12-13px, 400-500

Rules:

- do not invent new one-off font sizes unless a component has a clear special need
- do not use viewport-based font scaling
- do not use negative letter spacing
- do not make helper text smaller than 12px if it contains useful instructions
- do not make compact cards tall just to look important; reduce padding before shrinking text
- if a card is informational, keep text readable and reduce empty space instead of making the text tiny

Short UI labels, helper text, chips, toggles, and compact descriptions should not end with a period.

Use `Verstak` in product UI, not `Верстак`.

## Icons

Icons should match the custom Verstak line-icon style:

- thin rounded contour
- currentColor
- simple 18x18 SVG
- restrained accent color from parent component
- no filled colorful logos
- no generic heavy library icon look

For brand connectors, use either:

- a simplified recognizable brand mark if it reads well in one color
- a clean functional metaphor if the original logo depends on color or complex shape

Examples:

- GitHub can use the recognizable silhouette
- Яндекс.Директ should use a clear upward arrow / advertising growth metaphor
- Яндекс.Диск should use a clean cloud shape
- 1С OData should use a simple `1C` mark

## Layout And Density

Default density should be compact but not cramped.

Rules:

- cards should not grow just to look expensive
- internal spacing should be consistent
- repeated lists should be scan-friendly
- text must not be clipped
- buttons must fit their labels in both themes and common widths

When reducing height, remove duplicate metadata first. Do not squeeze text until it breaks.

When a list item has several logical zones, use a grid with stable columns instead of one large wrapping flex row. Wrapping flex is allowed only for secondary metadata, not for primary status/action placement.

## Dark And Light Themes

Every visual change must work in both themes.

Use tokens and `color-mix()` with app variables:

- `var(--bg-base)`
- `var(--bg-raised)`
- `var(--bg-surface)`
- `var(--bg-input)`
- `var(--border-subtle)`
- `var(--border-default)`
- `var(--text-primary)`
- `var(--text-secondary)`
- `var(--text-tertiary)`
- `var(--accent)`
- `var(--accent-muted)`

Do not hardcode a color just because it looks good in the current theme.

If a theme needs a separate adjustment, add a scoped rule:

```css
html[data-theme="light"] .component-name {
  ...
}
```

## Animation

Animations should be subtle and purposeful.

Use short transitions around 120-180ms for:

- border color
- background
- text color
- small opacity changes

Avoid:

- bouncy motion
- large transforms
- heavy glow pulses
- animation that changes layout size

## Copy

Interface text should be short and practical.

Write:

- `Стандартный интерфейс`
- `Больше пространства между блоками`
- `Требуется подключение`

Avoid:

- abstract phrases like `ритм интерфейса`
- long explanations where the control is obvious
- technical implementation details in user-facing copy
- final periods in short labels and helper text
- unexplained internal terms like `tools`, `inference`, `endpoint`, `runtime`, `reasoning`, `OpenAI-compatible`

User-facing copy must be understandable without developer knowledge. If a technical term is unavoidable, explain it in the same sentence in normal language. Prefer `инструменты`, `действия модели`, `сервер`, `этапы работы`, `внешняя программа` over raw English/internal terms.

Bad:

- `Полный агентский режим с tools`
- `Очень быстрый inference`
- `OpenAI-compatible endpoint`

Good:

- `Verstak может выполнять действия и показывать этапы работы`
- `Очень быстрые модели для коротких ответов`
- `Свой совместимый сервер: LM Studio, vLLM, локальная модель или корпоративный шлюз`

## Tooltips

Verstak uses a global tooltip host for `title` and `data-tooltip`.

Tooltips must:

- use the standard `gg-global-tooltip` visual style
- be short, readable, and written for the user
- avoid implementation jargon unless it is explained
- not rely on the native browser tooltip appearance

For new UI, use `title` for simple hover help or `data-tooltip` when the element already needs another accessible label.
The app converts native `title` attributes into `data-tooltip` globally, so old browser tooltips must not appear alongside the Verstak tooltip.

## Preset Buttons

Preset buttons such as model visibility shortcuts must follow the connector identity-card baseline:

- `border: 1px solid var(--border-subtle)`
- `border-radius: 18px`
- `background: var(--models-card)` or the section identity-card variable
- `box-shadow: var(--shadow-sm)`, with no extra hover shadow, lift, glow, or transform
- hover changes the border to the standard accent mix, not the layout or size
- helper text is secondary and short

## Implementation Checklist

Before finishing a UI change:

- compare the component to the connector card baseline
- check inherited styles from shared button/card/settings/toggle classes
- check dark theme
- check light theme
- check hover and active states
- check keyboard/focus state if the element is interactive
- check that hover does not add extra shadow, lift, glow, or transform beyond the component baseline
- check that text is not clipped
- check that status labels stay in the same place across short and long item names
- remove duplicate tags or labels
- avoid new one-off colors
- avoid new card styles unless the guide is updated intentionally
- do not leave a visual pattern that conflicts with this guide
- verify visually when the user is complaining about visual behavior; CSS marker checks are not enough

## When In Doubt

If a new UI element could be implemented in multiple ways, choose the version closest to the connector card:

- thin cyan hover border
- quiet surface
- darker recessed fields
- compact readable text
- small status lamps
- clean line icon

This is the current Verstak visual language.

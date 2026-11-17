# Tailwind migration evidence for PR 410

These 152 before/after pairs cover 38 surfaces at 1440×900 and 390×844, in both themes, using an isolated synthetic Hydra.

Before: main at `605f8dd0`. After: the Tailwind worker at `03b351f8`, including the shared icon tokens. The shared workspace, navigation, task layout and composer work is maintained by the other worker in the same PR. Main's Button ink and 1.4 line height are retained. Oracle keeps the approved placement below the new top bar, derived from its shared height token. Relative timestamps differ between captures.

The Select points down while closed and up while open. The browser journeys also check mouse, keyboard and Escape behavior, native Settings/chat disclosures, and the agent popover. Motion timing has a shared off-mode check, including the OS reduced-motion preference.

<img src="select-state.gif" width="470" alt="Select opening and closing with its state chevron">

## Settings

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-desktop-light-before.png" width="360" alt="settings, desktop, light, before"> | <img src="settings-desktop-light-after.png" width="360" alt="settings, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-desktop-dark-before.png" width="360" alt="settings, desktop, dark, before"> | <img src="settings-desktop-dark-after.png" width="360" alt="settings, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-phone-light-before.png" width="360" alt="settings, phone, light, before"> | <img src="settings-phone-light-after.png" width="360" alt="settings, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-phone-dark-before.png" width="360" alt="settings, phone, dark, before"> | <img src="settings-phone-dark-after.png" width="360" alt="settings, phone, dark, after"> |

## Settings layout

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-layout-desktop-light-before.png" width="360" alt="settings-layout, desktop, light, before"> | <img src="settings-layout-desktop-light-after.png" width="360" alt="settings-layout, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-layout-desktop-dark-before.png" width="360" alt="settings-layout, desktop, dark, before"> | <img src="settings-layout-desktop-dark-after.png" width="360" alt="settings-layout, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-layout-phone-light-before.png" width="360" alt="settings-layout, phone, light, before"> | <img src="settings-layout-phone-light-after.png" width="360" alt="settings-layout, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-layout-phone-dark-before.png" width="360" alt="settings-layout, phone, dark, before"> | <img src="settings-layout-phone-dark-after.png" width="360" alt="settings-layout, phone, dark, after"> |

## Settings cards

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-cards-desktop-light-before.png" width="360" alt="settings-cards, desktop, light, before"> | <img src="settings-cards-desktop-light-after.png" width="360" alt="settings-cards, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-cards-desktop-dark-before.png" width="360" alt="settings-cards, desktop, dark, before"> | <img src="settings-cards-desktop-dark-after.png" width="360" alt="settings-cards, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-cards-phone-light-before.png" width="360" alt="settings-cards, phone, light, before"> | <img src="settings-cards-phone-light-after.png" width="360" alt="settings-cards, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-cards-phone-dark-before.png" width="360" alt="settings-cards, phone, dark, before"> | <img src="settings-cards-phone-dark-after.png" width="360" alt="settings-cards, phone, dark, after"> |

## Settings hydra

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-hydra-desktop-light-before.png" width="360" alt="settings-hydra, desktop, light, before"> | <img src="settings-hydra-desktop-light-after.png" width="360" alt="settings-hydra, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-hydra-desktop-dark-before.png" width="360" alt="settings-hydra, desktop, dark, before"> | <img src="settings-hydra-desktop-dark-after.png" width="360" alt="settings-hydra, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-hydra-phone-light-before.png" width="360" alt="settings-hydra, phone, light, before"> | <img src="settings-hydra-phone-light-after.png" width="360" alt="settings-hydra, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-hydra-phone-dark-before.png" width="360" alt="settings-hydra, phone, dark, before"> | <img src="settings-hydra-phone-dark-after.png" width="360" alt="settings-hydra, phone, dark, after"> |

## Settings accounts

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-accounts-desktop-light-before.png" width="360" alt="settings-accounts, desktop, light, before"> | <img src="settings-accounts-desktop-light-after.png" width="360" alt="settings-accounts, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-accounts-desktop-dark-before.png" width="360" alt="settings-accounts, desktop, dark, before"> | <img src="settings-accounts-desktop-dark-after.png" width="360" alt="settings-accounts, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-accounts-phone-light-before.png" width="360" alt="settings-accounts, phone, light, before"> | <img src="settings-accounts-phone-light-after.png" width="360" alt="settings-accounts, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-accounts-phone-dark-before.png" width="360" alt="settings-accounts, phone, dark, before"> | <img src="settings-accounts-phone-dark-after.png" width="360" alt="settings-accounts, phone, dark, after"> |

## Settings routine

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-routine-desktop-light-before.png" width="360" alt="settings-routine, desktop, light, before"> | <img src="settings-routine-desktop-light-after.png" width="360" alt="settings-routine, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-routine-desktop-dark-before.png" width="360" alt="settings-routine, desktop, dark, before"> | <img src="settings-routine-desktop-dark-after.png" width="360" alt="settings-routine, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-routine-phone-light-before.png" width="360" alt="settings-routine, phone, light, before"> | <img src="settings-routine-phone-light-after.png" width="360" alt="settings-routine, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-routine-phone-dark-before.png" width="360" alt="settings-routine, phone, dark, before"> | <img src="settings-routine-phone-dark-after.png" width="360" alt="settings-routine, phone, dark, after"> |

## Settings reviews

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-reviews-desktop-light-before.png" width="360" alt="settings-reviews, desktop, light, before"> | <img src="settings-reviews-desktop-light-after.png" width="360" alt="settings-reviews, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-reviews-desktop-dark-before.png" width="360" alt="settings-reviews, desktop, dark, before"> | <img src="settings-reviews-desktop-dark-after.png" width="360" alt="settings-reviews, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-reviews-phone-light-before.png" width="360" alt="settings-reviews, phone, light, before"> | <img src="settings-reviews-phone-light-after.png" width="360" alt="settings-reviews, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-reviews-phone-dark-before.png" width="360" alt="settings-reviews, phone, dark, before"> | <img src="settings-reviews-phone-dark-after.png" width="360" alt="settings-reviews, phone, dark, after"> |

## Settings agent

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-agent-desktop-light-before.png" width="360" alt="settings-agent, desktop, light, before"> | <img src="settings-agent-desktop-light-after.png" width="360" alt="settings-agent, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-agent-desktop-dark-before.png" width="360" alt="settings-agent, desktop, dark, before"> | <img src="settings-agent-desktop-dark-after.png" width="360" alt="settings-agent, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-agent-phone-light-before.png" width="360" alt="settings-agent, phone, light, before"> | <img src="settings-agent-phone-light-after.png" width="360" alt="settings-agent, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-agent-phone-dark-before.png" width="360" alt="settings-agent, phone, dark, before"> | <img src="settings-agent-phone-dark-after.png" width="360" alt="settings-agent, phone, dark, after"> |

## Settings dispatch

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-dispatch-desktop-light-before.png" width="360" alt="settings-dispatch, desktop, light, before"> | <img src="settings-dispatch-desktop-light-after.png" width="360" alt="settings-dispatch, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-dispatch-desktop-dark-before.png" width="360" alt="settings-dispatch, desktop, dark, before"> | <img src="settings-dispatch-desktop-dark-after.png" width="360" alt="settings-dispatch, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-dispatch-phone-light-before.png" width="360" alt="settings-dispatch, phone, light, before"> | <img src="settings-dispatch-phone-light-after.png" width="360" alt="settings-dispatch, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-dispatch-phone-dark-before.png" width="360" alt="settings-dispatch, phone, dark, before"> | <img src="settings-dispatch-phone-dark-after.png" width="360" alt="settings-dispatch, phone, dark, after"> |

## Settings keyboard

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-keyboard-desktop-light-before.png" width="360" alt="settings-keyboard, desktop, light, before"> | <img src="settings-keyboard-desktop-light-after.png" width="360" alt="settings-keyboard, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-keyboard-desktop-dark-before.png" width="360" alt="settings-keyboard, desktop, dark, before"> | <img src="settings-keyboard-desktop-dark-after.png" width="360" alt="settings-keyboard, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-keyboard-phone-light-before.png" width="360" alt="settings-keyboard, phone, light, before"> | <img src="settings-keyboard-phone-light-after.png" width="360" alt="settings-keyboard, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-keyboard-phone-dark-before.png" width="360" alt="settings-keyboard, phone, dark, before"> | <img src="settings-keyboard-phone-dark-after.png" width="360" alt="settings-keyboard, phone, dark, after"> |

## Settings logs

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-logs-desktop-light-before.png" width="360" alt="settings-logs, desktop, light, before"> | <img src="settings-logs-desktop-light-after.png" width="360" alt="settings-logs, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-logs-desktop-dark-before.png" width="360" alt="settings-logs, desktop, dark, before"> | <img src="settings-logs-desktop-dark-after.png" width="360" alt="settings-logs, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-logs-phone-light-before.png" width="360" alt="settings-logs, phone, light, before"> | <img src="settings-logs-phone-light-after.png" width="360" alt="settings-logs, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-logs-phone-dark-before.png" width="360" alt="settings-logs, phone, dark, before"> | <img src="settings-logs-phone-dark-after.png" width="360" alt="settings-logs, phone, dark, after"> |

## Settings about

### Desktop, light

| Before | After |
| --- | --- |
| <img src="settings-about-desktop-light-before.png" width="360" alt="settings-about, desktop, light, before"> | <img src="settings-about-desktop-light-after.png" width="360" alt="settings-about, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="settings-about-desktop-dark-before.png" width="360" alt="settings-about, desktop, dark, before"> | <img src="settings-about-desktop-dark-after.png" width="360" alt="settings-about, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="settings-about-phone-light-before.png" width="360" alt="settings-about, phone, light, before"> | <img src="settings-about-phone-light-after.png" width="360" alt="settings-about, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="settings-about-phone-dark-before.png" width="360" alt="settings-about, phone, dark, before"> | <img src="settings-about-phone-dark-after.png" width="360" alt="settings-about, phone, dark, after"> |

## Account form

### Desktop, light

| Before | After |
| --- | --- |
| <img src="account-form-desktop-light-before.png" width="360" alt="account-form, desktop, light, before"> | <img src="account-form-desktop-light-after.png" width="360" alt="account-form, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="account-form-desktop-dark-before.png" width="360" alt="account-form, desktop, dark, before"> | <img src="account-form-desktop-dark-after.png" width="360" alt="account-form, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="account-form-phone-light-before.png" width="360" alt="account-form, phone, light, before"> | <img src="account-form-phone-light-after.png" width="360" alt="account-form, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="account-form-phone-dark-before.png" width="360" alt="account-form, phone, dark, before"> | <img src="account-form-phone-dark-after.png" width="360" alt="account-form, phone, dark, after"> |

## Select

### Desktop, light

| Before | After |
| --- | --- |
| <img src="select-desktop-light-before.png" width="360" alt="select, desktop, light, before"> | <img src="select-desktop-light-after.png" width="360" alt="select, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="select-desktop-dark-before.png" width="360" alt="select, desktop, dark, before"> | <img src="select-desktop-dark-after.png" width="360" alt="select, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="select-phone-light-before.png" width="360" alt="select, phone, light, before"> | <img src="select-phone-light-after.png" width="360" alt="select, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="select-phone-dark-before.png" width="360" alt="select, phone, dark, before"> | <img src="select-phone-dark-after.png" width="360" alt="select, phone, dark, after"> |

## Disclosure closed

### Desktop, light

| Before | After |
| --- | --- |
| <img src="disclosure-closed-desktop-light-before.png" width="360" alt="disclosure-closed, desktop, light, before"> | <img src="disclosure-closed-desktop-light-after.png" width="360" alt="disclosure-closed, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="disclosure-closed-desktop-dark-before.png" width="360" alt="disclosure-closed, desktop, dark, before"> | <img src="disclosure-closed-desktop-dark-after.png" width="360" alt="disclosure-closed, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="disclosure-closed-phone-light-before.png" width="360" alt="disclosure-closed, phone, light, before"> | <img src="disclosure-closed-phone-light-after.png" width="360" alt="disclosure-closed, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="disclosure-closed-phone-dark-before.png" width="360" alt="disclosure-closed, phone, dark, before"> | <img src="disclosure-closed-phone-dark-after.png" width="360" alt="disclosure-closed, phone, dark, after"> |

## Disclosure open

### Desktop, light

| Before | After |
| --- | --- |
| <img src="disclosure-open-desktop-light-before.png" width="360" alt="disclosure-open, desktop, light, before"> | <img src="disclosure-open-desktop-light-after.png" width="360" alt="disclosure-open, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="disclosure-open-desktop-dark-before.png" width="360" alt="disclosure-open, desktop, dark, before"> | <img src="disclosure-open-desktop-dark-after.png" width="360" alt="disclosure-open, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="disclosure-open-phone-light-before.png" width="360" alt="disclosure-open, phone, light, before"> | <img src="disclosure-open-phone-light-after.png" width="360" alt="disclosure-open, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="disclosure-open-phone-dark-before.png" width="360" alt="disclosure-open, phone, dark, before"> | <img src="disclosure-open-phone-dark-after.png" width="360" alt="disclosure-open, phone, dark, after"> |

## Chat first

### Desktop, light

| Before | After |
| --- | --- |
| <img src="chat-first-desktop-light-before.png" width="360" alt="chat-first, desktop, light, before"> | <img src="chat-first-desktop-light-after.png" width="360" alt="chat-first, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="chat-first-desktop-dark-before.png" width="360" alt="chat-first, desktop, dark, before"> | <img src="chat-first-desktop-dark-after.png" width="360" alt="chat-first, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="chat-first-phone-light-before.png" width="360" alt="chat-first, phone, light, before"> | <img src="chat-first-phone-light-after.png" width="360" alt="chat-first, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="chat-first-phone-dark-before.png" width="360" alt="chat-first, phone, dark, before"> | <img src="chat-first-phone-dark-after.png" width="360" alt="chat-first, phone, dark, after"> |

## Chat question

### Desktop, light

| Before | After |
| --- | --- |
| <img src="chat-question-desktop-light-before.png" width="360" alt="chat-question, desktop, light, before"> | <img src="chat-question-desktop-light-after.png" width="360" alt="chat-question, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="chat-question-desktop-dark-before.png" width="360" alt="chat-question, desktop, dark, before"> | <img src="chat-question-desktop-dark-after.png" width="360" alt="chat-question, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="chat-question-phone-light-before.png" width="360" alt="chat-question, phone, light, before"> | <img src="chat-question-phone-light-after.png" width="360" alt="chat-question, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="chat-question-phone-dark-before.png" width="360" alt="chat-question, phone, dark, before"> | <img src="chat-question-phone-dark-after.png" width="360" alt="chat-question, phone, dark, after"> |

## Chat progress

### Desktop, light

| Before | After |
| --- | --- |
| <img src="chat-progress-desktop-light-before.png" width="360" alt="chat-progress, desktop, light, before"> | <img src="chat-progress-desktop-light-after.png" width="360" alt="chat-progress, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="chat-progress-desktop-dark-before.png" width="360" alt="chat-progress, desktop, dark, before"> | <img src="chat-progress-desktop-dark-after.png" width="360" alt="chat-progress, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="chat-progress-phone-light-before.png" width="360" alt="chat-progress, phone, light, before"> | <img src="chat-progress-phone-light-after.png" width="360" alt="chat-progress, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="chat-progress-phone-dark-before.png" width="360" alt="chat-progress, phone, dark, before"> | <img src="chat-progress-phone-dark-after.png" width="360" alt="chat-progress, phone, dark, after"> |

## Chat upgrade

### Desktop, light

| Before | After |
| --- | --- |
| <img src="chat-upgrade-desktop-light-before.png" width="360" alt="chat-upgrade, desktop, light, before"> | <img src="chat-upgrade-desktop-light-after.png" width="360" alt="chat-upgrade, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="chat-upgrade-desktop-dark-before.png" width="360" alt="chat-upgrade, desktop, dark, before"> | <img src="chat-upgrade-desktop-dark-after.png" width="360" alt="chat-upgrade, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="chat-upgrade-phone-light-before.png" width="360" alt="chat-upgrade, phone, light, before"> | <img src="chat-upgrade-phone-light-after.png" width="360" alt="chat-upgrade, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="chat-upgrade-phone-dark-before.png" width="360" alt="chat-upgrade, phone, dark, before"> | <img src="chat-upgrade-phone-dark-after.png" width="360" alt="chat-upgrade, phone, dark, after"> |

## Waiting closed

### Desktop, light

| Before | After |
| --- | --- |
| <img src="waiting-closed-desktop-light-before.png" width="360" alt="waiting-closed, desktop, light, before"> | <img src="waiting-closed-desktop-light-after.png" width="360" alt="waiting-closed, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="waiting-closed-desktop-dark-before.png" width="360" alt="waiting-closed, desktop, dark, before"> | <img src="waiting-closed-desktop-dark-after.png" width="360" alt="waiting-closed, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="waiting-closed-phone-light-before.png" width="360" alt="waiting-closed, phone, light, before"> | <img src="waiting-closed-phone-light-after.png" width="360" alt="waiting-closed, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="waiting-closed-phone-dark-before.png" width="360" alt="waiting-closed, phone, dark, before"> | <img src="waiting-closed-phone-dark-after.png" width="360" alt="waiting-closed, phone, dark, after"> |

## Waiting open

### Desktop, light

| Before | After |
| --- | --- |
| <img src="waiting-open-desktop-light-before.png" width="360" alt="waiting-open, desktop, light, before"> | <img src="waiting-open-desktop-light-after.png" width="360" alt="waiting-open, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="waiting-open-desktop-dark-before.png" width="360" alt="waiting-open, desktop, dark, before"> | <img src="waiting-open-desktop-dark-after.png" width="360" alt="waiting-open, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="waiting-open-phone-light-before.png" width="360" alt="waiting-open, phone, light, before"> | <img src="waiting-open-phone-light-after.png" width="360" alt="waiting-open, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="waiting-open-phone-dark-before.png" width="360" alt="waiting-open, phone, dark, before"> | <img src="waiting-open-phone-dark-after.png" width="360" alt="waiting-open, phone, dark, after"> |

## Agent menu

### Desktop, light

| Before | After |
| --- | --- |
| <img src="agent-menu-desktop-light-before.png" width="360" alt="agent-menu, desktop, light, before"> | <img src="agent-menu-desktop-light-after.png" width="360" alt="agent-menu, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="agent-menu-desktop-dark-before.png" width="360" alt="agent-menu, desktop, dark, before"> | <img src="agent-menu-desktop-dark-after.png" width="360" alt="agent-menu, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="agent-menu-phone-light-before.png" width="360" alt="agent-menu, phone, light, before"> | <img src="agent-menu-phone-light-after.png" width="360" alt="agent-menu, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="agent-menu-phone-dark-before.png" width="360" alt="agent-menu, phone, dark, before"> | <img src="agent-menu-phone-dark-after.png" width="360" alt="agent-menu, phone, dark, after"> |

## Model menu

### Desktop, light

| Before | After |
| --- | --- |
| <img src="model-menu-desktop-light-before.png" width="360" alt="model-menu, desktop, light, before"> | <img src="model-menu-desktop-light-after.png" width="360" alt="model-menu, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="model-menu-desktop-dark-before.png" width="360" alt="model-menu, desktop, dark, before"> | <img src="model-menu-desktop-dark-after.png" width="360" alt="model-menu, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="model-menu-phone-light-before.png" width="360" alt="model-menu, phone, light, before"> | <img src="model-menu-phone-light-after.png" width="360" alt="model-menu, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="model-menu-phone-dark-before.png" width="360" alt="model-menu, phone, dark, before"> | <img src="model-menu-phone-dark-after.png" width="360" alt="model-menu, phone, dark, after"> |

## Identity editor

### Desktop, light

| Before | After |
| --- | --- |
| <img src="identity-editor-desktop-light-before.png" width="360" alt="identity-editor, desktop, light, before"> | <img src="identity-editor-desktop-light-after.png" width="360" alt="identity-editor, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="identity-editor-desktop-dark-before.png" width="360" alt="identity-editor, desktop, dark, before"> | <img src="identity-editor-desktop-dark-after.png" width="360" alt="identity-editor, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="identity-editor-phone-light-before.png" width="360" alt="identity-editor, phone, light, before"> | <img src="identity-editor-phone-light-after.png" width="360" alt="identity-editor, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="identity-editor-phone-dark-before.png" width="360" alt="identity-editor, phone, dark, before"> | <img src="identity-editor-phone-dark-after.png" width="360" alt="identity-editor, phone, dark, after"> |

## Question date

### Desktop, light

| Before | After |
| --- | --- |
| <img src="question-date-desktop-light-before.png" width="360" alt="question-date, desktop, light, before"> | <img src="question-date-desktop-light-after.png" width="360" alt="question-date, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="question-date-desktop-dark-before.png" width="360" alt="question-date, desktop, dark, before"> | <img src="question-date-desktop-dark-after.png" width="360" alt="question-date, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="question-date-phone-light-before.png" width="360" alt="question-date, phone, light, before"> | <img src="question-date-phone-light-after.png" width="360" alt="question-date, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="question-date-phone-dark-before.png" width="360" alt="question-date, phone, dark, before"> | <img src="question-date-phone-dark-after.png" width="360" alt="question-date, phone, dark, after"> |

## Oracle

### Desktop, light

| Before | After |
| --- | --- |
| <img src="oracle-desktop-light-before.png" width="360" alt="oracle, desktop, light, before"> | <img src="oracle-desktop-light-after.png" width="360" alt="oracle, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="oracle-desktop-dark-before.png" width="360" alt="oracle, desktop, dark, before"> | <img src="oracle-desktop-dark-after.png" width="360" alt="oracle, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="oracle-phone-light-before.png" width="360" alt="oracle, phone, light, before"> | <img src="oracle-phone-light-after.png" width="360" alt="oracle, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="oracle-phone-dark-before.png" width="360" alt="oracle, phone, dark, before"> | <img src="oracle-phone-dark-after.png" width="360" alt="oracle, phone, dark, after"> |

## Context menu

### Desktop, light

| Before | After |
| --- | --- |
| <img src="context-menu-desktop-light-before.png" width="360" alt="context-menu, desktop, light, before"> | <img src="context-menu-desktop-light-after.png" width="360" alt="context-menu, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="context-menu-desktop-dark-before.png" width="360" alt="context-menu, desktop, dark, before"> | <img src="context-menu-desktop-dark-after.png" width="360" alt="context-menu, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="context-menu-phone-light-before.png" width="360" alt="context-menu, phone, light, before"> | <img src="context-menu-phone-light-after.png" width="360" alt="context-menu, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="context-menu-phone-dark-before.png" width="360" alt="context-menu, phone, dark, before"> | <img src="context-menu-phone-dark-after.png" width="360" alt="context-menu, phone, dark, after"> |

## Icon picker

### Desktop, light

| Before | After |
| --- | --- |
| <img src="icon-picker-desktop-light-before.png" width="360" alt="icon-picker, desktop, light, before"> | <img src="icon-picker-desktop-light-after.png" width="360" alt="icon-picker, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="icon-picker-desktop-dark-before.png" width="360" alt="icon-picker, desktop, dark, before"> | <img src="icon-picker-desktop-dark-after.png" width="360" alt="icon-picker, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="icon-picker-phone-light-before.png" width="360" alt="icon-picker, phone, light, before"> | <img src="icon-picker-phone-light-after.png" width="360" alt="icon-picker, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="icon-picker-phone-dark-before.png" width="360" alt="icon-picker, phone, dark, before"> | <img src="icon-picker-phone-dark-after.png" width="360" alt="icon-picker, phone, dark, after"> |

## Tooltip

### Desktop, light

| Before | After |
| --- | --- |
| <img src="tooltip-desktop-light-before.png" width="360" alt="tooltip, desktop, light, before"> | <img src="tooltip-desktop-light-after.png" width="360" alt="tooltip, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="tooltip-desktop-dark-before.png" width="360" alt="tooltip, desktop, dark, before"> | <img src="tooltip-desktop-dark-after.png" width="360" alt="tooltip, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="tooltip-phone-light-before.png" width="360" alt="tooltip, phone, light, before"> | <img src="tooltip-phone-light-after.png" width="360" alt="tooltip, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="tooltip-phone-dark-before.png" width="360" alt="tooltip, phone, dark, before"> | <img src="tooltip-phone-dark-after.png" width="360" alt="tooltip, phone, dark, after"> |

## Task links

### Desktop, light

| Before | After |
| --- | --- |
| <img src="task-links-desktop-light-before.png" width="360" alt="task-links, desktop, light, before"> | <img src="task-links-desktop-light-after.png" width="360" alt="task-links, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="task-links-desktop-dark-before.png" width="360" alt="task-links, desktop, dark, before"> | <img src="task-links-desktop-dark-after.png" width="360" alt="task-links, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="task-links-phone-light-before.png" width="360" alt="task-links, phone, light, before"> | <img src="task-links-phone-light-after.png" width="360" alt="task-links, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="task-links-phone-dark-before.png" width="360" alt="task-links, phone, dark, before"> | <img src="task-links-phone-dark-after.png" width="360" alt="task-links, phone, dark, after"> |

## Task report

### Desktop, light

| Before | After |
| --- | --- |
| <img src="task-report-desktop-light-before.png" width="360" alt="task-report, desktop, light, before"> | <img src="task-report-desktop-light-after.png" width="360" alt="task-report, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="task-report-desktop-dark-before.png" width="360" alt="task-report, desktop, dark, before"> | <img src="task-report-desktop-dark-after.png" width="360" alt="task-report, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="task-report-phone-light-before.png" width="360" alt="task-report, phone, light, before"> | <img src="task-report-phone-light-after.png" width="360" alt="task-report, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="task-report-phone-dark-before.png" width="360" alt="task-report, phone, dark, before"> | <img src="task-report-phone-dark-after.png" width="360" alt="task-report, phone, dark, after"> |

## Task editor

### Desktop, light

| Before | After |
| --- | --- |
| <img src="task-editor-desktop-light-before.png" width="360" alt="task-editor, desktop, light, before"> | <img src="task-editor-desktop-light-after.png" width="360" alt="task-editor, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="task-editor-desktop-dark-before.png" width="360" alt="task-editor, desktop, dark, before"> | <img src="task-editor-desktop-dark-after.png" width="360" alt="task-editor, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="task-editor-phone-light-before.png" width="360" alt="task-editor, phone, light, before"> | <img src="task-editor-phone-light-after.png" width="360" alt="task-editor, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="task-editor-phone-dark-before.png" width="360" alt="task-editor, phone, dark, before"> | <img src="task-editor-phone-dark-after.png" width="360" alt="task-editor, phone, dark, after"> |

## Task brief

### Desktop, light

| Before | After |
| --- | --- |
| <img src="task-brief-desktop-light-before.png" width="360" alt="task-brief, desktop, light, before"> | <img src="task-brief-desktop-light-after.png" width="360" alt="task-brief, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="task-brief-desktop-dark-before.png" width="360" alt="task-brief, desktop, dark, before"> | <img src="task-brief-desktop-dark-after.png" width="360" alt="task-brief, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="task-brief-phone-light-before.png" width="360" alt="task-brief, phone, light, before"> | <img src="task-brief-phone-light-after.png" width="360" alt="task-brief, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="task-brief-phone-dark-before.png" width="360" alt="task-brief, phone, dark, before"> | <img src="task-brief-phone-dark-after.png" width="360" alt="task-brief, phone, dark, after"> |

## Project form

### Desktop, light

| Before | After |
| --- | --- |
| <img src="project-form-desktop-light-before.png" width="360" alt="project-form, desktop, light, before"> | <img src="project-form-desktop-light-after.png" width="360" alt="project-form, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="project-form-desktop-dark-before.png" width="360" alt="project-form, desktop, dark, before"> | <img src="project-form-desktop-dark-after.png" width="360" alt="project-form, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="project-form-phone-light-before.png" width="360" alt="project-form, phone, light, before"> | <img src="project-form-phone-light-after.png" width="360" alt="project-form, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="project-form-phone-dark-before.png" width="360" alt="project-form, phone, dark, before"> | <img src="project-form-phone-dark-after.png" width="360" alt="project-form, phone, dark, after"> |

## Project clone

### Desktop, light

| Before | After |
| --- | --- |
| <img src="project-clone-desktop-light-before.png" width="360" alt="project-clone, desktop, light, before"> | <img src="project-clone-desktop-light-after.png" width="360" alt="project-clone, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="project-clone-desktop-dark-before.png" width="360" alt="project-clone, desktop, dark, before"> | <img src="project-clone-desktop-dark-after.png" width="360" alt="project-clone, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="project-clone-phone-light-before.png" width="360" alt="project-clone, phone, light, before"> | <img src="project-clone-phone-light-after.png" width="360" alt="project-clone, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="project-clone-phone-dark-before.png" width="360" alt="project-clone, phone, dark, before"> | <img src="project-clone-phone-dark-after.png" width="360" alt="project-clone, phone, dark, after"> |

## Chat comment

### Desktop, light

| Before | After |
| --- | --- |
| <img src="chat-comment-desktop-light-before.png" width="360" alt="chat-comment, desktop, light, before"> | <img src="chat-comment-desktop-light-after.png" width="360" alt="chat-comment, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="chat-comment-desktop-dark-before.png" width="360" alt="chat-comment, desktop, dark, before"> | <img src="chat-comment-desktop-dark-after.png" width="360" alt="chat-comment, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="chat-comment-phone-light-before.png" width="360" alt="chat-comment, phone, light, before"> | <img src="chat-comment-phone-light-after.png" width="360" alt="chat-comment, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="chat-comment-phone-dark-before.png" width="360" alt="chat-comment, phone, dark, before"> | <img src="chat-comment-phone-dark-after.png" width="360" alt="chat-comment, phone, dark, after"> |

## Dialog

### Desktop, light

| Before | After |
| --- | --- |
| <img src="dialog-desktop-light-before.png" width="360" alt="dialog, desktop, light, before"> | <img src="dialog-desktop-light-after.png" width="360" alt="dialog, desktop, light, after"> |

### Desktop, dark

| Before | After |
| --- | --- |
| <img src="dialog-desktop-dark-before.png" width="360" alt="dialog, desktop, dark, before"> | <img src="dialog-desktop-dark-after.png" width="360" alt="dialog, desktop, dark, after"> |

### Phone, light

| Before | After |
| --- | --- |
| <img src="dialog-phone-light-before.png" width="360" alt="dialog, phone, light, before"> | <img src="dialog-phone-light-after.png" width="360" alt="dialog, phone, light, after"> |

### Phone, dark

| Before | After |
| --- | --- |
| <img src="dialog-phone-dark-before.png" width="360" alt="dialog, phone, dark, before"> | <img src="dialog-phone-dark-after.png" width="360" alt="dialog, phone, dark, after"> |

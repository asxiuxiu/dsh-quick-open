/**
 * Client entry of dsh-quick-open: registers the global Ctrl+P listener and
 * mounts the quick-open layer into the official `conversation.input.overlay`
 * slot (the input bar's overlay anchor).
 *
 * The key listener lives at window capture phase inside `ctx.effect`, so it
 * is active for the plugin fiber's whole lifetime — independent of whether
 * any editor, sidebar, or panel is mounted. This is the core difference from
 * editor-embedded quick-open implementations that die with their component.
 */
import { createElement } from 'react'
import type { Context } from './types.ts'
import { createQuickOpenStore } from './store.ts'
import { createQuickOpenController } from './controller.ts'
import { QuickOpenLayer } from './quick-open.tsx'
import { QuickOpenSettings, quickOpenSettingsSection } from './settings.tsx'
import { isImeComposition } from './ime-guard.ts'
import { registerPreviewAugmentations } from './preview/index.ts'

/**
 * Services required before mounting.
 *
 * The quick-open layer needs `slots` (the overlay anchor) and `sessions`
 * (the active cwd and the draft's session scope). File READING is no longer
 * declared: the built-in document preview shows every file, and the
 * augmentations decorate its DOM rather than reading files themselves.
 */
export const inject = ['slots', 'sessions']

export function apply(ctx: Context): void {
  const store = createQuickOpenStore()
  const controller = createQuickOpenController(ctx, store)

  // Decorate DSH's built-in document preview with an in-file find bar and
  // the selection-to-conversation gesture. The stock preview keeps every
  // file address — nothing is taken over — so its renderers (text, code,
  // Markdown, HTML, PDF, images) and controls all stay in charge.
  registerPreviewAugmentations(ctx)

  // Global Ctrl+P: window-level capture, active for the fiber's lifetime.
  // Without a current session the key is NOT swallowed (the overlay slot
  // cannot render then anyway), letting the browser default pass through.
  ctx.effect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isImeComposition(event)) return
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      if (event.key !== 'p' && event.key !== 'P') return
      if (!controller.canServe()) return
      event.preventDefault()
      event.stopPropagation()
      controller.toggle()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, 'dsh-quick-open: global Ctrl+P listener')

  // Tab is claimed at window CAPTURE while the layer is open.
  //
  // DSH's conversation input treats Tab as focus traversal and handles it in
  // the capture phase, which runs before any React handler on our panel — so
  // handling Tab only in the layer's own onKeyDown would be too late and the
  // key would move focus out of the search box instead of completing.
  // Capture phase here mirrors the Ctrl+P listener and wins the race.
  ctx.effect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      if (!controller.store.getSnapshot().open) return
      if (isImeComposition(event)) return
      event.preventDefault()
      event.stopPropagation()
      controller.completeSelected()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, 'dsh-quick-open: Tab completion while open')

  // Switching sessions closes the layer: its matches belong to the old cwd.
  ctx.effect(
    () => ctx.sessions.list.subscribe(() => controller.closeOnSessionChange()),
    'dsh-quick-open: session-switch close',
  )

  // The official overlay anchor of the conversation input bar.
  ctx.slots.inject('conversation.input.overlay', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.overlay',
        id: 'dsh-quick-open',
        order: 10,
      },
      () => createElement(QuickOpenLayer, { controller }),
    ),
  )

  // Settings panel: per-workspace index rules (exclude/include dirs, file
  // filters). Registered unconditionally — the panel itself degrades to a
  // read-only notice when no session supplies a workspace to edit.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      quickOpenSettingsSection,
      () => createElement(QuickOpenSettings, { ctx }),
    ),
  )
}

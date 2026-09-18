/**
 * Mount the preview augmentations.
 *
 * The layer is a singleton with its own React root appended to
 * `document.body`, mounted inside one `ctx.effect` so it lives exactly as
 * long as the plugin fiber. A slot was deliberately NOT used: slots like
 * `conversation.input.overlay` render once per session input, and a global
 * key/selection listener mounted there would fire once per mounted input.
 *
 * React comes from the platform seed table (the bundle leaves `react` /
 * `react-dom` external), so this root shares the host's React instance and
 * no second copy is bundled.
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context } from '../types.ts'
import { ensurePreviewStyles } from './styles.ts'
import { PreviewAugmentations } from './Augmentations.tsx'

export function registerPreviewAugmentations(ctx: Context): void {
  ensurePreviewStyles()
  ctx.effect(() => {
    if (typeof document === 'undefined') return undefined
    const host = document.createElement('div')
    host.dataset.quickOpenPreview = 'true'
    document.body.appendChild(host)
    let root: Root | null = null
    try {
      root = createRoot(host)
      root.render(createElement(PreviewAugmentations, { ctx }))
    } catch (error) {
      // A mount failure must not take the quick-open layer down with it:
      // without this layer the app simply has its stock preview.
      console.warn('[dsh-quick-open] preview augmentations failed to mount:', error)
      host.remove()
      return undefined
    }
    return () => {
      root?.unmount()
      host.remove()
    }
  }, 'dsh-quick-open: preview augmentations')
}

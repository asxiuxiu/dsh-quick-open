/**
 * Preview-augmentation styles as a class map, injected once into a single
 * <style> tag (this plugin has no CSS build chain). Class names are prefixed
 * so the app's stylesheets cannot collide with them.
 *
 * The find bar deliberately wears the Ctrl+P palette's own chrome 鈥?#252526
 * over #3c3c3c with the #454545 separator and the same raised shadow 鈥?so the
 * two search boxes in the app read as one design language rather than two.
 *
 * Two layers here are portal-mounted to `document.body` and must sit above
 * the sidebar's own float host (z-index 60): both use 10000, the layer the
 * Ctrl+P backdrop already occupies.
 */

const TAG_ID = 'dsh-quick-open/preview.css'

const CSS = `
.qo-preview-find {
  position: fixed;
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  padding: 6px;
  background: #252526;
  border: 1px solid #454545;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, .5);
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #eeeeee);
}
.qo-preview-find input {
  flex: auto;
  min-width: 160px;
  font: inherit;
  color: inherit;
  background: #3c3c3c;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 8px;
  outline: none;
}
.qo-preview-find input:focus { border-color: var(--dsw-alias-interactive-border-focus, #007fd4); }
.qo-preview-find-count {
  flex: none;
  min-width: 44px;
  text-align: center;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
  white-space: nowrap;
}
.qo-preview-find-count[data-empty="true"] { color: var(--dsw-alias-label-tertiary, #777777); }
.qo-preview-find-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font: inherit;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}
.qo-preview-find-button:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary, #eeeeee);
  background: var(--dsw-alias-interactive-bg-hover, #3a3a3a);
}
.qo-preview-find-button:disabled { opacity: .4; cursor: default; }

/* The selection button is portaled to the body to escape the pane's clipping,
   and anchored in viewport coordinates over the selection. The z-index must
   outrank the sidebar's float host (60), which portals to the body AFTER this
   layer and would otherwise win the tie by DOM order. */
.qo-preview-selection {
  position: fixed;
  z-index: 10000;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 5px 9px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #eeeeee);
  background: var(--dsw-alias-bg-elevated, #2b2b2b);
  border: 1px solid var(--dsw-alias-border-l3, #4a4a4a);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .32);
}
.qo-preview-selection:hover {
  /* The hover tint token is TRANSLUCENT (it is meant as a wash over a solid
     surface). Assigning it as the background would let the file text
     underneath bleed through the button, so the solid elevated base stays
     underneath and the tint rides on top as an image layer. */
  background-color: var(--dsw-alias-bg-elevated, #2b2b2b);
  background-image: linear-gradient(
    var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08)),
    var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08)));
}
.qo-preview-selection::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: var(--dsw-alias-label-tertiary, #9a9a9a);
}

.qo-preview-notice {
  position: fixed;
  z-index: 10000;
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--dsw-alias-label-primary, #eeeeee);
  background: var(--dsw-alias-bg-elevated, #2b2b2b);
  border: 1px solid var(--dsw-alias-border-l3, #4a4a4a);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .32);
  pointer-events: none;
}

/* The Custom Highlight API paints these; no DOM is touched. */
::highlight(qo-preview-find-match) {
  background-color: rgba(234, 179, 8, .35);
}
::highlight(qo-preview-find-current) {
  background-color: rgba(234, 179, 8, .75);
}
`

let injected = false

/** Inject the stylesheet once per document; a repeat call is a no-op. */
export function ensurePreviewStyles(): void {
  if (injected || typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) {
    injected = true
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-quick-open'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  injected = true
}

/** Stable class names the component applies. */
export const previewCss = {
  find: 'qo-preview-find',
  findCount: 'qo-preview-find-count',
  findButton: 'qo-preview-find-button',
  selection: 'qo-preview-selection',
  notice: 'qo-preview-notice',
} as const

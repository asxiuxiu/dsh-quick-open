/**
 * IME-composition key guard (the DSH core convention, issue #535 — mirrored
 * from dsh-better-sidebar's ime-guard.ts).
 *
 * While a Chinese/Japanese/Korean input method is composing, every pressed
 * key BELONGS to the input method: arrows move the candidate highlight,
 * Enter confirms, Escape cancels. Page code must not process those keys.
 * `isComposing` covers modern engines; `keyCode === 229` covers legacy
 * engines that never set it.
 */
export function isImeComposition(event: { isComposing?: boolean; keyCode: number }): boolean {
  return event.isComposing === true || event.keyCode === 229
}

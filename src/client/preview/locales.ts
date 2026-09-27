/**
 * Preview-augmentation copy.
 *
 * The strings themselves now live in the plugin-wide table (`../i18n.ts`) so
 * every user-visible string ships in one reviewable place and the two surfaces
 * cannot drift into different wording for the same idea. This module keeps the
 * preview surface's own KEY NAMES as a thin, typed alias, because they read
 * better at the call site than the table's namespaced keys and because the
 * augmentation's tests assert against them.
 */
import { messages, type Messages } from '../i18n.ts'

/** The augmentation's message keys, mapped onto the shared table. */
export interface PreviewMessages {
  noConversation: string
  added: string
  addSelection: string
  findPlaceholder: string
  findPrevious: string
  findNext: string
  findClose: string
  findCaseSensitive: string
  noResults: string
  partialCoverage: string
  partialCoverageHint: string
}

/** Preview key -> shared table key. */
const KEYS: Record<keyof PreviewMessages, keyof Messages> = {
  noConversation: 'previewNoConversation',
  added: 'previewAdded',
  addSelection: 'previewAddSelection',
  findPlaceholder: 'previewFindPlaceholder',
  findPrevious: 'previewFindPrevious',
  findNext: 'previewFindNext',
  findClose: 'previewFindClose',
  findCaseSensitive: 'previewFindCaseSensitive',
  noResults: 'previewNoResults',
  partialCoverage: 'previewPartialCoverage',
  partialCoverageHint: 'previewPartialCoverageHint',
}

/**
 * Look up one preview string in the active language.
 *
 * Language resolution lives in `../i18n.ts` (read from `<html lang>` per call,
 * so a locale switch needs no reload).
 */
export function t<K extends keyof PreviewMessages>(key: K): string {
  return messages()[KEYS[key]]
}

/**
 * Preview-augmentation copy. Kept in one dictionary so the surface is
 * translatable as a unit and every user-visible string is reviewable in one
 * place.
 */

/** The augmentation's message keys. */
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

const en: PreviewMessages = {
  noConversation: 'The conversation service is unavailable.',
  added: 'Added to conversation',
  addSelection: 'Add to conversation',
  findPlaceholder: 'Find in file',
  findPrevious: 'Previous match (Shift+Enter)',
  findNext: 'Next match (Enter)',
  findClose: 'Close (Esc)',
  findCaseSensitive: 'Match case',
  noResults: 'No results',
  partialCoverage: 'loaded part',
  partialCoverageHint: 'The file has pages not yet loaded; only the loaded part was searched.',
}

const zh: PreviewMessages = {
  noConversation: '对话服务不可用。',
  added: '已加入会话',
  addSelection: '加入会话',
  findPlaceholder: '在文件中查找',
  findPrevious: '上一个匹配（Shift+Enter）',
  findNext: '下一个匹配（Enter）',
  findClose: '关闭（Esc）',
  findCaseSensitive: '区分大小写',
  noResults: '无结果',
  partialCoverage: '仅已加载',
  partialCoverageHint: '文件还有未加载的部分，搜索结果只覆盖已加载的内容。',
}

/**
 * The active language, read from the document element the app sets it on.
 * Read per call rather than captured, so a locale switch needs no reload.
 */
export function t<K extends keyof PreviewMessages>(key: K): string {
  const lang = typeof document === 'undefined' ? 'en' : document.documentElement.lang
  const dictionary = lang.toLowerCase().startsWith('zh') ? zh : en
  return dictionary[key]
}

/**
 * Load the built client bundle and assert it MOUNTS, without a browser.
 *
 * The failure modes that matter are a top-level throw (a bad import, a
 * missing global) and a registration that silently does nothing. This shims
 * the minimum the module envelope touches — `window.__ModuleLoader__`, a
 * `require` answering React — then calls `apply()` against a fake ctx and
 * drives the two augmentations end to end:
 *
 * - the find bar: a simulated Ctrl+F over a fake built-in preview must open
 *   the bar and count the matches in the preview's text nodes;
 * - the selection popup: a simulated document selection inside the preview
 *   must raise the button, and clicking it must write the reference into the
 *   conversation draft.
 *
 * Since the architecture change the plugin must NOT touch the tab registry:
 * the stock preview keeps every file address, and that is asserted against a
 * registry stub transcribed from the real one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

/** The registrations and listeners the fake runtime collects. */
const log = {
  slots: [],
  effects: [],
  gets: [],
  windowListeners: {},
  documentListeners: {},
  drafts: [],
}

let failures = 0
function fail(message) {
  failures += 1
  console.error(`FAIL ${message}`)
}
function ok(message) {
  console.log(`ok   ${message}`)
}

// ── the React stand-in ──────────────────────────────────────────────────────
// A stub that keeps hook SLOTS stable across renders: effects are queued per
// render and run explicitly, so event-time state changes can be observed by
// re-rendering — the difference between "the listener fired" and "the UI
// actually changed".
const reactRuntime = { current: null, seq: 0 }

function hookSlot(index) {
  const instance = reactRuntime.current
  if (instance.slots.length <= index) instance.slots.push({ value: undefined, deps: undefined })
  return instance.slots[index]
}

function newInstance() {
  return { slots: [], cleanups: new Map(), pending: [] }
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  createPortal: (element) => ({ type: '__portal__', props: {}, children: [element] }),
  useCallback: (fn, deps) => {
    const slot = hookSlot(reactRuntime.seq++)
    if (slot.deps === undefined || deps === undefined || deps.some((d, i) => !Object.is(d, slot.deps[i]))) {
      slot.deps = deps
      slot.value = fn
    }
    return slot.value
  },
  useMemo: (fn, deps) => {
    const slot = hookSlot(reactRuntime.seq++)
    if (slot.deps === undefined || deps === undefined || deps.some((d, i) => !Object.is(d, slot.deps[i]))) {
      slot.deps = deps
      slot.value = fn()
    }
    return slot.value
  },
  useRef: value => {
    const slot = hookSlot(reactRuntime.seq++)
    if (slot.value === undefined) slot.value = { current: value }
    return slot.value
  },
  useState: value => {
    const index = reactRuntime.seq++
    const slot = hookSlot(index)
    if (slot.value === undefined) slot.value = typeof value === 'function' ? value() : value
    const setter = next => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
    }
    setter.__index = index
    return [slot.value, setter]
  },
  useEffect: (fn, deps) => {
    const slot = hookSlot(reactRuntime.seq++)
    const changed = slot.deps === undefined || deps === undefined
      || deps.length !== slot.deps.length
      || deps.some((d, i) => !Object.is(d, slot.deps[i]))
    if (changed) slot.deps = deps
    reactRuntime.current.pending.push({ slot, fn })
  },
  useLayoutEffect: (fn, deps) => reactStub.useEffect(fn, deps),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: 'Fragment',
}

function renderComponent(component, props, instance = newInstance()) {
  const previous = reactRuntime.current
  const previousSeq = reactRuntime.seq
  reactRuntime.current = instance
  reactRuntime.seq = 0
  instance.pending = []
  let element
  try {
    element = component(props)
  } finally {
    reactRuntime.current = previous
    reactRuntime.seq = previousSeq
  }
  return { element, instance }
}

function runEffects(instance) {
  for (const { slot, fn } of instance.pending) {
    const cleanup = fn()
    if (typeof cleanup === 'function') instance.cleanups.set(slot, cleanup)
  }
  instance.pending = []
}

// ── the DOM stand-in ────────────────────────────────────────────────────────
// requestAnimationFrame is QUEUED, never run inline: the find bar's anchor
// loop reschedules itself every frame, so an eager stub would recurse
// forever. The test flushes the queue explicitly, a bounded number of times.
const rafQueue = []
function flushRaf(times = 1) {
  for (let round = 0; round < times; round += 1) {
    const callbacks = rafQueue.splice(0)
    for (const callback of callbacks) callback()
  }
}

function styleStub() {
  return new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : ''),
    set: (target, key, value) => { target[key] = value; return true },
    has: () => true,
  })
}

/** Mutable scene the tests arrange: the visible previews and the selection. */
const domState = {
  roots: [],
  textNodes: [],
  selection: null,
}

let elementSeq = 0
function elementStub(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    style: styleStub(),
    dataset: {},
    childNodes: [],
    parentElement: null,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    appendChild: child => { element.childNodes.push(child); return child },
    removeChild: () => {},
    remove: () => {},
    insertBefore: child => child,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    getClientRects: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    closest: () => null,
    matches: () => false,
    focus: () => {},
    blur: () => {},
    scrollIntoView: () => {},
    get uid() { return elementSeq++ },
  }
  return element
}

const window = {
  __ModuleLoader__: { load: (entry) => { factory = entry.factory } },
  addEventListener: (name, fn) => {
    ;(log.windowListeners[name] ??= []).push(fn)
  },
  removeEventListener: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: callback => { rafQueue.push(callback); return rafQueue.length },
  cancelAnimationFrame: () => {},
  getComputedStyle: () => styleStub(),
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  innerWidth: 1920,
  innerHeight: 1080,
  devicePixelRatio: 1,
  document: undefined,
}

const documentElement = { lang: 'zh', style: styleStub() }
const document = {
  documentElement,
  body: elementStub('body'),
  head: elementStub('head'),
  createElement: tag => elementStub(tag),
  createElementNS: (_ns, tag) => elementStub(tag),
  createTextNode: text => ({ nodeType: 3, textContent: text }),
  createDocumentFragment: () => elementStub('fragment'),
  createTreeWalker: (_root, _what, filter) => {
    const accepted = domState.textNodes.filter(node =>
      filter?.acceptNode === undefined || filter.acceptNode(node) === 1)
    let index = 0
    return { nextNode: () => accepted[index++] ?? null }
  },
  createRange: () => ({
    setStart() {}, setEnd() {}, collapse() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getClientRects: () => [], selectNodeContents() {}, cloneRange() { return this },
    detach() {},
  }),
  querySelector: () => null,
  querySelectorAll: selector => selector === '[data-textpreview-url]' ? domState.roots : [],
  getElementById: () => null,
  getSelection: () => domState.selection,
  addEventListener: (name, fn) => {
    ;(log.documentListeners[name] ??= []).push(fn)
  },
  removeEventListener: () => {},
  hasFocus: () => true,
  hidden: false,
  visibilityState: 'visible',
  contains: () => true,
  defaultView: undefined,
}
document.defaultView = { document, getComputedStyle: () => styleStub() }
window.document = document

const navigator = { userAgent: 'node', platform: 'node', clipboard: { writeText: async () => {} } }

let factory
globalThis.window = window
globalThis.document = document
// Node 24 defines `navigator` as a getter-only global, so it is redefined
// rather than assigned.
Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true, writable: true })
globalThis.getComputedStyle = () => styleStub()
globalThis.requestAnimationFrame = callback => { rafQueue.push(callback); return rafQueue.length }
globalThis.cancelAnimationFrame = () => {}
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.AbortController = globalThis.AbortController ?? class { constructor() { this.signal = {} } abort() {} }
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => null })
// The augmentation code type-checks DOM nodes with `instanceof HTMLElement`
// and the tree walk with the NodeFilter constants; both are browser globals
// the stub must name.
globalThis.HTMLElement = Object
globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 }

// Evaluate the bundle: it self-registers through window.__ModuleLoader__.load.
new Function('window', 'document', source).call(globalThis, window, document)

if (factory === undefined) {
  fail('the bundle never registered a module')
  process.exit(1)
}
ok('module envelope registered')

// ── the runtime faces ───────────────────────────────────────────────────────
// A registry faithful to DSH's SidebarRightTabRegistry, seeded with the stock
// document preview exactly as the real composition has it. Since the
// architecture change the plugin must register NOTHING here — the stock
// preview keeps every file address — and the assertions below hold it to
// that.
const RANKS = { extension: 3, builtin: 2, fallback: 1 }
const registry = {
  ids: new Set(),
  kinds: new Map(),
  registrations: 0,
  register(definition) {
    const band = definition.priority ?? 'extension'
    if (this.ids.has(definition.id)) {
      throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`)
    }
    this.registrations += 1
    this.ids.add(definition.id)
    this.kinds.set(definition.kind, { band, definition, order: this.registrations })
    return () => {}
  },
  claim(address) {
    const ranked = [...this.kinds.values()]
      .map(entry => ({ entry, length: longestMatch(entry.definition.patterns ?? [], address) }))
      .filter(candidate => candidate.length >= 0)
      .filter(candidate => candidate.entry.definition.canOpen?.(address) !== false)
      .sort((left, right) => RANKS[right.entry.band] - RANKS[left.entry.band]
        || right.length - left.length
        || left.entry.order - right.entry.order)
    return ranked[0]?.entry.definition
  },
}

/** picomatch-lite: only the `**`-suffixed whole-address pattern is used here. */
function longestMatch(patterns, address) {
  let longest = -1
  for (const pattern of patterns) {
    const matched = pattern.endsWith('**')
      ? address.startsWith(pattern.slice(0, -2))
      : pattern === address
    if (matched && pattern.length > longest) longest = pattern.length
  }
  return longest
}

// The stock document preview, as registered by
// @deepseek-ai/dsh-client-ui-sidebar-documentpreview (textDefinition()).
registry.register({
  id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  kind: 'text',
  patterns: ['dsh-resource://file/**'],
  priority: 'fallback',
  canOpen: () => true,
})

const ctx = {
  remote: {
    workspaceFiles: {
      read: async () => ({ ok: true, value: { text: '', lines: 0, offset: 1, eof: true } }),
    },
  },
  slots: {
    inject: (name, body) => { body() },
    register: (entry, component) => {
      const name = typeof entry === 'string' ? entry : entry.name
      log.slots.push({ name, key: typeof entry === 'string' ? undefined : entry.key, entry, component })
      return () => {}
    },
  },
  sessions: {
    list: {
      subscribe: () => () => {},
      getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { cwd: 'E:/cb2_master/dev/chaos' } } }),
    },
    scope: () => ({ emit: () => {} }),
  },
  get: (name) => {
    log.gets.push(name)
    if (name === 'sidebarRightTabs') return registry
    if (name === 'sidebarRight') return { openResource: () => {} }
    if (name === 'conversation') {
      return {
        input: {
          for: () => ({
            state: { getSnapshot: () => ({ draft: '' }) },
            setDraft: text => { log.drafts.push(text) },
          }),
        },
      }
    }
    return undefined
  },
  effect: (body, label) => { log.effects.push(label ?? '(unlabelled)'); return body() },
  logger: { warn: (...args) => console.log('  warn:', ...args) },
}

/** The React root the augmentation bootstrap mounted, captured by the stub. */
const mounted = { host: null, element: null, component: null, props: null, instance: null }

const module = factory((name) => {
  if (name === 'react' || name === 'react-dom') return reactStub
  if (name === 'react/jsx-runtime') return reactStub
  if (name === 'react-dom/client') {
    return {
      createRoot: (host) => {
        mounted.host = host
        return {
          render: (element) => {
            mounted.element = element
            mounted.component = element.type
            mounted.props = element.props ?? {}
            const rendered = renderComponent(mounted.component, mounted.props)
            mounted.instance = rendered.instance
            mounted.element = rendered.element
            runEffects(mounted.instance)
          },
          unmount: () => {},
        }
      },
    }
  }
  throw new Error(`unexpected external require: ${name}`)
})

try {
  module.apply(ctx)
  ok('apply() did not throw')
} catch (error) {
  fail(`apply() threw: ${error.stack ?? error}`)
}

/** Re-render the mounted augmentation component after event-time state changes. */
function rerender() {
  const rendered = renderComponent(mounted.component, mounted.props, mounted.instance)
  mounted.element = rendered.element
  runEffects(mounted.instance)
  return mounted.element
}

// The declared service list is load-bearing: cordis binds an injected service
// onto the context. File READING is deliberately absent — the built-in
// preview reads files; the augmentations only decorate its DOM.
const declared = module.inject ?? []
ok(`inject declared: ${JSON.stringify(declared)}`)
for (const service of ['slots', 'sessions']) {
  if (!declared.includes(service)) fail(`service "${service}" is not declared in the client inject list`)
}
if (declared.some(service => service.startsWith('remote'))) {
  fail('the client still declares the remote file-read services — the augmentations read the preview DOM, not files')
}

// ── non-interference with the tab registry ──────────────────────────────────
// The whole point of the architecture: the stock preview keeps every file
// address. The plugin registering a tab type again is exactly the takeover
// this change removed.
if (registry.registrations !== 1) {
  fail(`the plugin registered a tab type (${registry.registrations - 1} beyond the stock preview) — the augmentations must not touch the tab registry`)
} else {
  ok('the plugin registered no tab type')
}
const claimed = registry.claim('dsh-resource://file/session/s/main.cpp')
if (claimed?.id !== '@deepseek-ai/dsh-client-ui-sidebar-documentpreview') {
  fail(`a file address claims "${claimed?.id}" — the stock preview must keep file addresses`)
} else {
  ok('the stock preview still claims file addresses')
}
if (log.slots.some(entry => entry.name === 'sidebar.right.pane.tab')) {
  fail('a pane body was registered — the plugin no longer owns a tab body')
} else {
  ok('no pane body registered')
}
for (const required of ['conversation.input.overlay', 'settings.section']) {
  if (!log.slots.some(entry => entry.name === required)) fail(`slot "${required}" was never registered`)
}

// ── the augmentation mount ──────────────────────────────────────────────────
if (mounted.host === null || mounted.host.dataset.quickOpenPreview !== 'true') {
  fail('the augmentation layer did not mount its own React root')
} else if (!document.body.childNodes.includes(mounted.host)) {
  fail('the augmentation host was never appended to document.body')
} else {
  ok('augmentation layer mounted into its own root')
}
if (mounted.component === null) {
  fail('createRoot was never rendered')
} else if (mounted.element === undefined) {
  fail('the augmentation component threw on first render')
} else {
  ok('augmentation component rendered')
}

// ── listener registration ───────────────────────────────────────────────────
const keydownHandlers = log.windowListeners.keydown ?? []
if (keydownHandlers.length < 2) {
  fail(`expected several window keydown listeners (Ctrl+P, Tab, Ctrl+F), got ${keydownHandlers.length}`)
} else {
  ok(`${keydownHandlers.length} window keydown listeners registered`)
}
for (const name of ['selectionchange', 'mousedown']) {
  if ((log.documentListeners[name] ?? []).length === 0) {
    fail(`no document "${name}" listener — the selection popup cannot work`)
  } else {
    ok(`document "${name}" listener registered`)
  }
}

// ── tree walking helpers ────────────────────────────────────────────────────
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      collectText(renderComponent(node.type, node.props ?? {}).element, out)
      return out
    }
    for (const child of node.children ?? []) collectText(child, out)
    if (node.props?.children !== undefined) collectText(node.props.children, out)
  }
  return out
}

function collectByProp(node, prop, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByProp(child, prop, out)
    return out
  }
  if (typeof node.type === 'function') {
    collectByProp(renderComponent(node.type, node.props ?? {}).element, prop, out)
    return out
  }
  if (node.props != null && prop in node.props) out.push(node.props)
  for (const child of node.children ?? []) collectByProp(child, prop, out)
  if (node.props?.children !== undefined) collectByProp(node.props.children, prop, out)
  return out
}

/** Fire one synthetic keydown at every window keydown listener. */
function fireKeydown(event) {
  const full = {
    altKey: false, shiftKey: false, metaKey: false, ctrlKey: false,
    preventDefault() { full.prevented = true },
    stopPropagation() {},
    prevented: false,
    ...event,
  }
  for (const handler of log.windowListeners.keydown ?? []) handler(full)
  return full
}

// ── the find bar ────────────────────────────────────────────────────────────
// With NO visible preview the gesture must pass through: the browser or app
// default is then correct, and swallowing it would break every other surface.
const passed = fireKeydown({ key: 'f', ctrlKey: true })
if (passed.prevented) {
  fail('Ctrl+F was swallowed with no file preview visible — it must pass through')
} else {
  ok('Ctrl+F passes through with no preview visible')
}

// A fake built-in preview: the root carries the address, one line element
// carries the line marker, and two text nodes make the searchable content.
// The attributes used are the stock preview's own instrumentation
// (data-textpreview-url, data-textpreview-line).
const ADDRESS = 'dsh-resource://file/session/sess-1/_source/main.cpp'
const fakeRoot = elementStub('div')
fakeRoot.dataset.textpreviewUrl = ADDRESS
fakeRoot.getBoundingClientRect = () => ({ top: 50, left: 200, right: 600, bottom: 800, width: 400, height: 750, x: 200, y: 50 })
fakeRoot.contains = () => true
const lineEl = elementStub('div')
lineEl.parentElement = fakeRoot
lineEl.closest = selector => {
  if (selector === '[data-textpreview-line]') return lineEl
  if (selector === '[data-textpreview-url]') return fakeRoot
  return null
}
lineEl.getAttribute = name => name === 'data-textpreview-line' ? '12' : null
lineEl.contains = () => true
const textNode1 = { nodeType: 3, textContent: 'hello world ', parentElement: lineEl }
const textNode2 = { nodeType: 3, textContent: 'hello', parentElement: lineEl }
domState.roots.push(fakeRoot)
domState.textNodes.push(textNode1, textNode2)

const swallowed = fireKeydown({ key: 'f', ctrlKey: true })
if (!swallowed.prevented) {
  fail('Ctrl+F was NOT claimed over a visible file preview')
} else {
  ok('Ctrl+F is claimed over a visible preview')
}
rerender()
flushRaf(3)
let el = rerender()
let bars = collectByProp(el, 'data-preview-find')
if (bars.length === 0) {
  fail('the find bar did not render after Ctrl+F over a visible preview')
} else {
  ok('find bar renders after Ctrl+F')
  const input = collectByProp(el, 'data-preview-find-input')[0]
  if (input?.onChange === undefined) {
    fail('the find bar has no input to type into')
  } else {
    input.onChange({ target: { value: 'hello' } })
    el = rerender()
    flushRaf(2)
    el = rerender()
    const text = collectText(el).join(' ')
    // 'hello world ' + 'hello' holds two hits; the bar reports "current/total".
    if (!text.includes('1/2')) {
      fail(`the find bar counted no matches over the preview's text nodes (rendered: ${JSON.stringify(text.slice(0, 120))})`)
    } else {
      ok('find bar counts matches in the preview DOM (1/2)')
    }
  }
}

// ── the selection popup ─────────────────────────────────────────────────────
const fakeRange = {
  startContainer: textNode1,
  getBoundingClientRect: () => ({ top: 100, left: 120, right: 160, bottom: 114, width: 40, height: 14, x: 120, y: 100 }),
  cloneRange() { return this },
}
domState.selection = {
  isCollapsed: false,
  rangeCount: 1,
  anchorNode: textNode1,
  focusNode: textNode2,
  toString: () => 'hello world hello',
  getRangeAt: () => fakeRange,
}
for (const handler of log.documentListeners.selectionchange ?? []) handler()
flushRaf(3)
el = rerender()
const popups = collectByProp(el, 'data-preview-selection-popup')
if (popups.length === 0) {
  fail('selecting text inside the preview raised no popup')
} else {
  ok('selection inside the preview raises the popup')
  popups[0].onClick?.()
  // The reference carries the line the preview's own marker exposed, and the
  // draft write went through the conversation service.
  const draft = log.drafts[log.drafts.length - 1]
  if (draft !== '@_source/main.cpp:12') {
    fail(`the committed reference is ${JSON.stringify(draft)}, expected "@_source/main.cpp:12"`)
  } else {
    ok('popup commit writes the line-qualified reference into the draft')
  }
  el = rerender()
  if (collectByProp(el, 'data-preview-notice').length === 0) {
    fail('no confirmation notice rendered after the commit')
  } else {
    ok('commit confirmation renders')
  }
}

// A collapsed or out-of-preview selection must raise nothing.
domState.selection = { isCollapsed: true, rangeCount: 0, anchorNode: null, focusNode: null, toString: () => '', getRangeAt: () => fakeRange }
for (const handler of log.documentListeners.selectionchange ?? []) handler()
flushRaf(2)
el = rerender()
if (collectByProp(el, 'data-preview-selection-popup').length !== 0) {
  fail('a collapsed selection left the popup visible')
} else {
  ok('collapsed selection shows no popup')
}

// ── the quick-open layer's escape from the slot's stacking context ─────────
// The layer is MOUNTED through the conversation.input.overlay slot but must
// be PORTALED to document.body: any ancestor establishing a containing block
// or stacking context (transform, paint containment, a clipped scroller)
// would trap the fixed backdrop inside the conversation column, capping its
// z-index below the sidebar's layers and clipping it. This is the regression
// behind "Ctrl+P 浮框被遮挡" — assert the portal, not just the z-index.
const quickOpenSource = readFileSync(join(root, 'src/client/quick-open.tsx'), 'utf8')
if (!/createPortal\([\s\S]*document\.body/.test(quickOpenSource)) {
  fail('the quick-open layer is not portaled to document.body — an ancestor stacking context can trap and clip the backdrop')
} else {
  ok('quick-open layer portals its backdrop to document.body')
}

// ── the stylesheet contract ─────────────────────────────────────────────────
// Both floating layers portal to document.body and must outrank the sidebar's
// float host (z-index 60, itself portaled AFTER this layer, so a tie loses by
// DOM order). 10000 is the layer the Ctrl+P backdrop occupies.
const stylesText = readFileSync(join(root, 'src/client/preview/styles.ts'), 'utf8')
for (const selector of ['.qo-preview-selection', '.qo-preview-find']) {
  const rule = new RegExp(selector.replace(/[.]/g, '\\.') + '\\s*\\{[^}]*z-index:\\s*10000')
  if (!rule.test(stylesText)) {
    fail(`${selector} is not at z-index 10000 — the sidebar's float host (60, later in the body) would cover it`)
  } else {
    ok(`${selector} sits at z-index 10000`)
  }
}
// The selection popup's hover must layer the (translucent) tint token over
// the SOLID elevated base: assigning the tint as the background lets the file
// text bleed through the button.
const hoverRule = /\.qo-preview-selection:hover\s*\{([^}]*)\}/.exec(stylesText)
if (hoverRule === null || !hoverRule[1].includes('background-color') || !hoverRule[1].includes('background-image')) {
  fail('the selection popup hover does not layer the tint over a solid base — the translucent token shows the file through the button')
} else {
  ok('selection popup hover layers the tint over a solid base')
}
// The highlight names the stylesheet paints must be the names find.ts
// registers, or matches are computed but never visible.
const findSource = readFileSync(join(root, 'src/client/preview/find.ts'), 'utf8')
for (const name of ['qo-preview-find-match', 'qo-preview-find-current']) {
  if (!stylesText.includes(`::highlight(${name})`)) fail(`the stylesheet paints no ::highlight(${name})`)
  if (!findSource.includes(`'${name}'`)) fail(`find.ts never registers the "${name}" highlight`)
}
// The find bar wears the Ctrl+P palette's chrome so the two search boxes in
// the app read as one design language.
for (const token of ['#252526', '#3c3c3c', '#454545']) {
  if (!stylesText.includes(token)) fail(`the find bar does not use the palette token ${token}`)
  if (!quickOpenSource.includes(token)) fail(`the Ctrl+P palette no longer uses ${token}; the find bar's colours are stale`)
}
ok('find bar matches the Ctrl+P palette (surfaces, border)')

console.log(failures === 0 ? '\nclient bundle mounts cleanly' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

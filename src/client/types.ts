/**
 * Minimal service faces for the DSH client runtime, narrowed to exactly what
 * dsh-quick-open touches. Modeled on the real contracts:
 * - `slots` / `sessions`: cordis services of the official client runtime
 *   (consumed via `inject`).
 * - `conversation`: provided by @deepseek-ai/dsh-client-ui-conversation,
 *   read inject-free through `ctx.get` (the same pattern the app's own
 *   plugins use).
 * - `sidebarRight`: provided by @deepseek-ai/dsh-client-ui-sidebar-right, the
 *   native right Sidebar navigation face every file open goes through.
 */

/** A session-scoped cordis context (what `ctx.sessions.scope(id)` returns). */
export interface SessionContext {
  emit(name: string, payload: unknown): void
}

export interface SessionsService {
  list: {
    subscribe(listener: () => void): () => void
    getSnapshot(): {
      current?: string
      byId: Record<string, { cwd?: string } | undefined>
    }
  }
  scope(sessionId: string): SessionContext | undefined
}

export interface SlotEntry {
  name: string
  id?: string
  order?: number
  label?: string
  /** The kind a keyed slot body is registered under (the tab registry routes by it). */
  key?: string
  locale?: string
  /**
   * Props factory: its RETURN VALUE becomes the registered component's props.
   * The pane renders a tab body with an EMPTY custom-props argument, so this is
   * the only channel through which a slot body receives plugin-owned values —
   * the client context included. Anything not returned here is `undefined` in
   * the component.
   */
  inject?: (...args: unknown[]) => Record<string, unknown>
}

export interface SlotsService {
  inject(name: string, body: () => unknown): void
  register(entry: SlotEntry, component: unknown): void
}

export interface ConversationInputState {
  draft: string
  draftRev?: number
}

export interface ConversationInput {
  state: { getSnapshot(): ConversationInputState }
  setDraft(text: string): void
}

export interface ConversationService {
  input: { for(actx: SessionContext): ConversationInput }
}

/** One request's session scope: the conversation id plus its cwd when known. */
export interface SessionScope {
  sessionId: string
  cwd?: string
}

/** One navigation option every native right-Sidebar open accepts. */
export interface SidebarRightOpenOptions {
  /** Navigation parameters the claimed tab type receives (`line` jumps to a line). */
  params?: Record<string, unknown>
  /** The tab type to claim the address with, when the caller wants to name it. */
  kind?: string
}

/**
 * The native right Sidebar's navigation face (`ctx.sidebarRight`).
 *
 * `openResource` takes a `dsh-resource://<type>/…` address and hands it to
 * whichever registered tab type claims that type — the same entry point the
 * sidebar's own file tree uses, so a file opens exactly as a click there
 * would. An unclaimed or malformed address throws.
 */
export interface SidebarRightServiceLike {
  openResource(address: string, options?: SidebarRightOpenOptions): void
}

/**
 * The native right Sidebar's tab registry (`ctx.sidebarRightTabs`).
 *
 * Its bands are ranked `extension` (3) > `builtin` (2) > `fallback` (1), and
 * an `extension` may take over a kind a `builtin` already holds — which is
 * how the file viewer replaces the stock document preview without patching
 * any DSH package.
 */
export interface SidebarRightTabRegistryLike {
  register(definition: {
    id: string
    kind: string
    patterns?: readonly string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?: (address: string) => boolean
    title?: (address: string) => string
  }): () => void
}

/** The client cordis context, narrowed to the members this plugin uses. */
export interface Context {
  slots: SlotsService
  sessions: SessionsService
  get(name: 'sidebarRight'): SidebarRightServiceLike | undefined
  get(name: 'sidebarRightTabs'): SidebarRightTabRegistryLike | undefined
  get(name: 'conversation'): ConversationService | undefined
  get(name: string): unknown
  effect(body: () => (() => void) | void, label?: string): void
}

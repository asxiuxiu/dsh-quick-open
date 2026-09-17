/**
 * Minimal service faces for the DSH client runtime, narrowed to exactly what
 * dsh-quick-open touches. Modeled on the real contracts:
 * - `slots` / `sessions`: cordis services of the official client runtime
 *   (consumed via `inject`).
 * - `conversation`: provided by @deepseek-ai/dsh-client-ui-conversation,
 *   read inject-free through `ctx.get` (the same pattern the app's own
 *   plugins and dsh-better-sidebar use).
 * - `betterSidebar`: provided by dsh-better-sidebar (v0.12.0+ capability
 *   list; features are never removed — gate usage on membership).
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

export interface BetterSidebarServiceLike {
  readonly features: readonly string[]
  openFile(scope: SessionScope, path: string, title?: string): void
}

/** The client cordis context, narrowed to the members this plugin uses. */
export interface Context {
  slots: SlotsService
  sessions: SessionsService
  get(name: 'betterSidebar'): BetterSidebarServiceLike | undefined
  get(name: 'conversation'): ConversationService | undefined
  get(name: string): unknown
  effect(body: () => (() => void) | void, label?: string): void
}

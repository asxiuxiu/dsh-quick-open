window.__ModuleLoader__.load({
	id: "dsh-quick-open",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react3 = require("react");

// src/client/store.ts
var INITIAL = {
  open: false,
  sessionId: void 0,
  query: "",
  matches: [],
  listKind: "search",
  truncated: false,
  selected: 0,
  searching: false,
  error: null,
  notice: null,
  indexInfo: null,
  focusSeq: 0
};
function createQuickOpenStore() {
  let state = INITIAL;
  const listeners = /* @__PURE__ */ new Set();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    set(patch) {
      state = { ...state, ...patch };
      emit();
    },
    reset() {
      state = INITIAL;
      emit();
    }
  };
}

// src/client/controller.ts
var SEARCH_DEBOUNCE_MS = 100;
var NOTICE_MS = 1600;
var REFOCUS_RETRY_MS = 80;
var RECENTS_CAP = 15;
var QUERY_CACHE_CAP = 10;
function isAbsolutePath(path) {
  return /^(?:[\\/]|[a-zA-Z]:[\\/]|\\\\)/.test(path);
}
function resolveWorkspacePath(cwd, path) {
  if (isAbsolutePath(path)) return path;
  const base = cwd ?? "";
  if (base === "") return path;
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${path}`;
}
function absolutePathOf(scope, entry) {
  if (entry.absolute === true || isAbsolutePath(entry.path)) return entry.path;
  return resolveWorkspacePath(scope.cwd, entry.path);
}
function fileMention(relativePath) {
  const path = relativePath.replace(/[\\/]+$/, "");
  if (/[\u0000-\u001f\u007f-\u009f\u0022]/u.test(path)) return void 0;
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}
async function apiCall(base, method, payload, signal) {
  const response = await fetch(`${base}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === void 0) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
  }
  return parsed.value;
}
function scopePayload(scope, extra) {
  return {
    sessionId: scope.sessionId,
    ...scope.cwd !== void 0 && scope.cwd !== "" ? { cwd: scope.cwd } : {},
    ...extra
  };
}
async function probeIsDir(scope, relativePath) {
  try {
    await apiCall("/sidebar/api", "fs.tree", scopePayload(scope, { path: relativePath }));
    return true;
  } catch {
    return false;
  }
}
function rankMatches(entries, query) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return entries;
  const score = (rel) => {
    const name = nameLowerOf(rel);
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    return 2;
  };
  return entries.map((entry, index) => ({ entry, index, score: score(entry.path) })).sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.index - b.index).map((item) => item.entry);
}
function nameLowerOf(rel) {
  const at = rel.lastIndexOf("/");
  return (at === -1 ? rel : rel.slice(at + 1)).toLowerCase();
}
function createQuickOpenController(ctx, store) {
  let debounceTimer;
  let noticeTimer;
  let inFlight;
  let searchSeq = 0;
  let fastRoute;
  const queryCache = /* @__PURE__ */ new Map();
  const currentScope = () => {
    const snapshot = ctx.sessions.list.getSnapshot();
    const sessionId = snapshot.current;
    if (sessionId === void 0) return void 0;
    const cwd = snapshot.byId[sessionId]?.cwd;
    return { sessionId, ...cwd !== void 0 && cwd !== "" ? { cwd } : {} };
  };
  const scopeKeyOf = (scope) => `${scope.sessionId}
${scope.cwd ?? ""}`;
  const sidebar = () => {
    const service = ctx.get("betterSidebar");
    if (service === void 0 || !service.features.includes("openFile")) return void 0;
    return service;
  };
  const recentsKey = () => {
    const cwd = currentScope()?.cwd;
    return cwd === void 0 ? void 0 : `dsh-quick-open:recents:${cwd}`;
  };
  const loadRecents = () => {
    const key = recentsKey();
    if (key === void 0) return [];
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out = [];
      for (const item of parsed) {
        if (typeof item === "string") {
          out.push({ path: item });
          continue;
        }
        if (typeof item !== "object" || item === null) continue;
        const record = item;
        if (typeof record.path !== "string" || record.path === "") continue;
        out.push({
          path: record.path,
          ...record.absolute === true ? { absolute: true } : {},
          ...typeof record.label === "string" && record.label !== "" ? { rootLabel: record.label } : {}
        });
      }
      return out;
    } catch {
      return [];
    }
  };
  const pushRecent = (entry) => {
    const key = recentsKey();
    if (key === void 0) return;
    const rest = loadRecents().filter((item) => item.path !== entry.path);
    const next = [entry, ...rest].slice(0, RECENTS_CAP);
    const serialized = next.map((item) => item.absolute === true ? { path: item.path, absolute: true, ...item.rootLabel !== void 0 ? { label: item.rootLabel } : {} } : item.path);
    try {
      window.localStorage.setItem(key, JSON.stringify(serialized));
    } catch {
    }
    const state = store.getSnapshot();
    if (state.open && state.listKind === "recents") {
      store.set({ matches: next, selected: 0 });
    }
  };
  const notice = (text) => {
    if (noticeTimer !== void 0) window.clearTimeout(noticeTimer);
    store.set({ notice: text });
    noticeTimer = window.setTimeout(() => {
      noticeTimer = void 0;
      store.set({ notice: null });
    }, NOTICE_MS);
  };
  const reclaimFocus = () => {
    store.set({ focusSeq: store.getSnapshot().focusSeq + 1 });
    window.setTimeout(() => {
      if (store.getSnapshot().open) store.set({ focusSeq: store.getSnapshot().focusSeq + 1 });
    }, REFOCUS_RETRY_MS);
  };
  const cancelSearch = () => {
    if (debounceTimer !== void 0) {
      window.clearTimeout(debounceTimer);
      debounceTimer = void 0;
    }
    inFlight?.abort();
    inFlight = void 0;
  };
  const canServe = () => currentScope() !== void 0;
  const open = () => {
    const scope = currentScope();
    if (scope === void 0) return;
    cancelSearch();
    const query = store.getSnapshot().query;
    store.set({
      open: true,
      sessionId: scope.sessionId,
      selected: 0,
      error: null,
      indexInfo: null,
      focusSeq: store.getSnapshot().focusSeq + 1,
      // An empty query shows the recent-files list; a preserved query
      // re-searches below (cache-hit first).
      ...query.trim() === "" ? { matches: loadRecents(), listKind: "recents" } : {}
    });
    if (query.trim() !== "") runSearch(query.trim());
  };
  const close = () => {
    if (!store.getSnapshot().open) return;
    cancelSearch();
    store.reset();
  };
  const toggle = () => {
    if (store.getSnapshot().open) close();
    else open();
  };
  const closeOnSessionChange = () => {
    const state = store.getSnapshot();
    if (!state.open) return;
    if (state.sessionId !== currentScope()?.sessionId) close();
  };
  const fetchEntries = async (scope, query, signal) => {
    if (fastRoute !== false) {
      try {
        const found = await apiCall("/quick-open/api", "search", scopePayload(scope, { query }), signal);
        fastRoute = true;
        const indexInfo = found.indexedEntries !== void 0 ? `\u7D22\u5F15 ${found.indexedEntries.toLocaleString()} \u9879 \xB7 ${Math.round((found.indexAge ?? 0) / 1e3)}s \u524D` : null;
        return { entries: found.matches, truncated: found.truncated, indexInfo };
      } catch (error) {
        if (signal.aborted) throw error;
        fastRoute = false;
      }
    }
    const legacy = await apiCall("/sidebar/api", "fs.search", scopePayload(scope, { query }), signal);
    return {
      entries: rankMatches(legacy.matches.map((path) => ({ path })), query),
      truncated: legacy.truncated,
      indexInfo: null
    };
  };
  const cachePut = (key, value) => {
    queryCache.delete(key);
    queryCache.set(key, value);
    while (queryCache.size > QUERY_CACHE_CAP) {
      const oldest = queryCache.keys().next().value;
      if (oldest === void 0) break;
      queryCache.delete(oldest);
    }
  };
  const runSearch = (query) => {
    const scope = currentScope();
    if (scope === void 0) return;
    const scopeKey = scopeKeyOf(scope);
    const needle = query.toLowerCase();
    cancelSearch();
    const seq = ++searchSeq;
    const controller = new AbortController();
    inFlight = controller;
    const cached = queryCache.get(`${scopeKey}
${needle}`);
    if (cached !== void 0) {
      store.set({
        searching: true,
        matches: cached.entries,
        truncated: !cached.complete,
        selected: 0,
        error: null,
        listKind: "search"
      });
    } else {
      store.set({ searching: true, error: null, listKind: "search" });
    }
    fetchEntries(scope, query, controller.signal).then((found) => {
      if (seq !== searchSeq || controller.signal.aborted) return;
      const complete = !found.truncated;
      cachePut(`${scopeKey}
${needle}`, { entries: found.entries, complete });
      store.set({
        searching: false,
        matches: found.entries,
        truncated: found.truncated,
        selected: 0,
        error: null,
        indexInfo: found.indexInfo
      });
    }).catch((failure) => {
      if (seq !== searchSeq || controller.signal.aborted) return;
      store.set({
        searching: false,
        matches: [],
        truncated: false,
        error: failure instanceof Error ? failure.message : String(failure)
      });
    });
  };
  const setQuery = (query) => {
    store.set({ query });
    if (debounceTimer !== void 0) window.clearTimeout(debounceTimer);
    if (query.trim() === "") {
      cancelSearch();
      searchSeq += 1;
      store.set({ matches: loadRecents(), listKind: "recents", truncated: false, selected: 0, searching: false, error: null });
      return;
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = void 0;
      runSearch(query.trim());
    }, SEARCH_DEBOUNCE_MS);
  };
  const move = (delta) => {
    const { matches, selected } = store.getSnapshot();
    if (matches.length === 0) return;
    const next = (selected + delta + matches.length) % matches.length;
    store.set({ selected: next });
  };
  const select = (index) => {
    store.set({ selected: index });
  };
  const jump = (where) => {
    const { matches } = store.getSnapshot();
    if (matches.length === 0) return;
    store.set({ selected: where === "first" ? 0 : matches.length - 1 });
  };
  const selectedMatch = () => {
    const { matches, selected } = store.getSnapshot();
    return matches[selected];
  };
  const resolveIsDir = (scope, entry) => {
    if (entry.isDir !== void 0) return Promise.resolve(entry.isDir);
    return probeIsDir(scope, absolutePathOf(scope, entry));
  };
  const completeSelected = () => {
    const entry = selectedMatch();
    if (entry === void 0) return;
    const state = store.getSnapshot();
    if (state.listKind === "recents") return;
    const trimmed = state.query.trim();
    const tokens = trimmed.split(/\s+/u).filter((token) => token !== "");
    const lastToken = tokens[tokens.length - 1] ?? "";
    const prefixMatch = /^(dir:|d:|file:|f:)/u.exec(lastToken);
    const scope = prefixMatch === null ? "any" : prefixMatch[1].startsWith("f") ? "name" : "dir";
    const head = tokens.slice(0, Math.max(0, tokens.length - 1));
    const headText = head.filter((token) => !/^(?:dir:|d:|file:|f:)$/u.test(token)).join(" ");
    const path = entry.path;
    const basename = path.slice(path.lastIndexOf("/") + 1);
    let completed;
    if (scope === "name") {
      completed = basename;
    } else if (entry.isDir === true) {
      completed = `${path.replace(/\/+$/, "")}/`;
    } else {
      completed = path;
    }
    const prefixText = prefixMatch === null ? "" : prefixMatch[1];
    const next = `${headText === "" ? "" : `${headText} `}${prefixText}${completed}`;
    applyQuery(next);
  };
  const applyQuery = (text) => {
    store.set({ query: text });
    cancelSearch();
    const trimmed = text.trim();
    if (trimmed === "") {
      searchSeq += 1;
      store.set({ matches: loadRecents(), listKind: "recents", truncated: false, selected: 0, searching: false, error: null });
      return;
    }
    runSearch(trimmed);
  };
  const openSelected = async () => {
    const entry = selectedMatch();
    if (entry === void 0) return;
    const scope = currentScope();
    if (scope === void 0) return;
    if (await resolveIsDir(scope, entry)) {
      notice("\u8FD9\u662F\u76EE\u5F55\uFF1ACtrl+Enter \u4EE5 @dir/ \u5F15\u7528");
      reclaimFocus();
      return;
    }
    const service = sidebar();
    if (service === void 0) {
      notice("\u9700\u8981 dsh-better-sidebar \u624D\u80FD\u6253\u5F00\u6587\u4EF6\uFF08\u641C\u7D22\u4E0E\u5F15\u7528\u4E0D\u53D7\u5F71\u54CD\uFF09");
      reclaimFocus();
      return;
    }
    service.openFile(scope, absolutePathOf(scope, entry));
    pushRecent(entry);
    close();
  };
  const appendReferenceText = (sessionId, mention) => {
    const actx = ctx.sessions.scope(sessionId);
    const conversation = ctx.get("conversation");
    if (actx === void 0 || conversation === void 0) return false;
    const input = conversation.input.for(actx);
    const draft = input.state.getSnapshot().draft;
    const trimmed = draft.replace(/\s+$/u, "");
    input.setDraft(trimmed === "" ? mention : `${trimmed} ${mention}`);
    return true;
  };
  const referenceSelected = async () => {
    const entry = selectedMatch();
    if (entry === void 0) return;
    const scope = currentScope();
    if (scope === void 0) return;
    const referencePath = absolutePathOf(scope, entry);
    if (await resolveIsDir(scope, entry)) {
      const mention = `@${referencePath.replace(/[\\/]+$/, "")}/`;
      if (appendReferenceText(scope.sessionId, mention)) {
        pushRecent(entry);
      } else {
        notice("\u5BF9\u8BDD\u670D\u52A1\u4E0D\u53EF\u7528");
      }
      reclaimFocus();
      return;
    }
    const reference = fileMention(referencePath);
    if (reference === void 0) {
      notice("\u8DEF\u5F84\u5305\u542B\u65E0\u6CD5\u5F15\u7528\u7684\u5B57\u7B26");
      reclaimFocus();
      return;
    }
    if (appendReferenceText(scope.sessionId, reference)) {
      pushRecent(entry);
    } else {
      notice("\u5BF9\u8BDD\u670D\u52A1\u4E0D\u53EF\u7528");
    }
    reclaimFocus();
  };
  return {
    store,
    canServe,
    toggle,
    open,
    close,
    closeOnSessionChange,
    setQuery,
    move,
    select,
    jump,
    completeSelected,
    openSelected,
    referenceSelected
  };
}

// src/client/quick-open.tsx
var import_react = require("react");

// src/client/ime-guard.ts
function isImeComposition(event) {
  return event.isComposing === true || event.keyCode === 229;
}

// src/client/quick-open.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.35)",
    zIndex: 1e4,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start"
  },
  panel: {
    marginTop: "12vh",
    width: "min(640px, 90vw)",
    background: "#252526",
    border: "1px solid #454545",
    borderRadius: 8,
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column"
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    fontSize: 14,
    color: "#cccccc",
    background: "#3c3c3c",
    border: "none",
    outline: "none"
  },
  section: {
    padding: "4px 12px 2px",
    fontSize: 11,
    color: "#7a7a7a",
    letterSpacing: "0.04em"
  },
  list: {
    maxHeight: 320,
    overflowY: "auto"
  },
  row: {
    padding: "6px 12px",
    fontSize: 13,
    color: "#cccccc",
    cursor: "default",
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    whiteSpace: "nowrap",
    overflow: "hidden",
    // Rows are click targets, not text: a drag across one should not look like
    // a selection. The text spans below opt back in.
    userSelect: "none"
  },
  rowSelected: {
    background: "#094771"
  },
  rowName: {
    color: "#e8e8e8",
    flexShrink: 0,
    userSelect: "text"
  },
  rowDirName: {
    color: "#4fc1ff",
    flexShrink: 0,
    userSelect: "text"
  },
  rowHit: {
    color: "#4ec9b0"
  },
  /**
   * The directory as a right-aligned suffix, front-elided in JS rather than by
   * CSS. CSS `text-overflow: ellipsis` clips the TAIL, which is exactly the
   * part that distinguishes two rows of the same file name — so a deep shared
   * prefix (`E:/cb2_master/dev/.../client/public/chaos/client/`) would hide the
   * one segment the user actually needs to compare.
   */
  rowDirPinned: {
    color: "#8a8a8a",
    fontSize: 12,
    whiteSpace: "nowrap",
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    userSelect: "text"
  },
  /** The elided leading portion of a path, dimmed to read as "omitted". */
  pathDim: {
    color: "#6a6a6a"
  },
  rowRoot: {
    flexShrink: 0,
    padding: "0 6px",
    borderRadius: 3,
    background: "#3a3d41",
    color: "#bdbdbd",
    fontSize: 11
  },
  rowAction: {
    flexShrink: 0,
    fontSize: 11,
    color: "#cccccc",
    background: "rgba(255, 255, 255, 0.08)",
    border: "1px solid #555555",
    borderRadius: 4,
    padding: "1px 8px",
    cursor: "pointer"
  },
  status: {
    padding: "10px 12px",
    fontSize: 12,
    color: "#8a8a8a"
  },
  notice: {
    padding: "8px 12px",
    fontSize: 12,
    color: "#cca700",
    borderTop: "1px solid #454545"
  },
  error: {
    padding: "8px 12px",
    fontSize: 12,
    color: "#f48771",
    borderTop: "1px solid #454545"
  },
  footer: {
    padding: "6px 12px",
    fontSize: 11,
    color: "#7a7a7a",
    borderTop: "1px solid #454545",
    display: "flex",
    gap: 16,
    flexWrap: "wrap"
  }
};
function splitPath(rel) {
  const at = rel.lastIndexOf("/");
  return at === -1 ? { dir: "", name: rel } : { dir: rel.slice(0, at + 1), name: rel.slice(at + 1) };
}
var PINNED_SEGMENTS = 3;
function compactDir(dir, spans) {
  if (dir === "") return { text: "", spans: [], elided: false };
  const bounds = [];
  let start = 0;
  for (let i = 0; i < dir.length; i++) {
    if (dir[i] === "/") {
      bounds.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < dir.length) bounds.push({ start, end: dir.length });
  const keep = /* @__PURE__ */ new Set();
  const tailFrom = Math.max(0, bounds.length - PINNED_SEGMENTS);
  for (let i = tailFrom; i < bounds.length; i++) keep.add(i);
  if (spans !== void 0) {
    for (const span of spans) {
      for (let i = 0; i < bounds.length; i++) {
        if (span.start < bounds[i].end && span.end > bounds[i].start) keep.add(i);
      }
    }
  }
  const kept = [...keep].sort((a, b) => a - b);
  if (kept.length === bounds.length) {
    return { text: dir, spans: spans === void 0 ? [] : [...spans], elided: false };
  }
  const segments = kept.map((i) => dir.slice(bounds[i].start, bounds[i].end));
  const text = `\u2026${segments.join("")}`;
  const shift = bounds[kept[0]].start - 1;
  const shifted = [];
  for (const span of spans ?? []) {
    const s = Math.max(0, span.start - shift);
    const e = Math.min(text.length, span.end - shift);
    if (e > s) shifted.push({ start: s, end: e });
  }
  return { text, spans: shifted, elided: true };
}
function highlight(text, spans) {
  if (spans === void 0 || spans.length === 0) return text;
  const parts = [];
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > cursor) parts.push(text.slice(cursor, start));
    if (end > start) parts.push(/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowHit, children: text.slice(start, end) }, start));
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
function highlightDir(dir, spans) {
  const compact = compactDir(dir, spans);
  if (compact.text === "") return null;
  const body = highlight(compact.text, compact.spans);
  if (!compact.elided) return body;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.pathDim, children: body });
}
var PAGE_STEP = 10;
function QuickOpenLayer({ controller }) {
  const state = (0, import_react.useSyncExternalStore)(controller.store.subscribe, controller.store.getSnapshot);
  const inputRef = (0, import_react.useRef)(null);
  const listRef = (0, import_react.useRef)(null);
  const wasOpenRef = (0, import_react.useRef)(false);
  (0, import_react.useEffect)(() => {
    if (!state.open) {
      wasOpenRef.current = false;
      return;
    }
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    if (!wasOpenRef.current) input.select();
    wasOpenRef.current = true;
  }, [state.open, state.focusSeq]);
  (0, import_react.useEffect)(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = 0;
  }, [state.matches]);
  (0, import_react.useEffect)(() => {
    const list = listRef.current;
    if (list === null) return;
    const row = list.children[state.selected];
    row?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  if (!state.open) return null;
  const onKeyDown = (event) => {
    if (isImeComposition(event.nativeEvent)) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        event.stopPropagation();
        controller.move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        event.stopPropagation();
        controller.move(-1);
        return;
      case "PageDown":
        event.preventDefault();
        event.stopPropagation();
        controller.move(PAGE_STEP);
        return;
      case "PageUp":
        event.preventDefault();
        event.stopPropagation();
        controller.move(-PAGE_STEP);
        return;
      case "Home":
        event.preventDefault();
        event.stopPropagation();
        controller.jump("first");
        return;
      case "End":
        event.preventDefault();
        event.stopPropagation();
        controller.jump("last");
        return;
      case "Enter":
        event.preventDefault();
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) void controller.referenceSelected();
        else void controller.openSelected();
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        controller.close();
        return;
      default:
    }
  };
  const keepFocus = (event) => {
    event.preventDefault();
  };
  const onBackdropMouseDown = (event) => {
    if (event.target === event.currentTarget) controller.close();
  };
  const onRowClick = (index, event) => {
    controller.select(index);
    if (event.ctrlKey || event.metaKey) void controller.referenceSelected();
    else void controller.openSelected();
  };
  const onRowReference = (index, event) => {
    event.stopPropagation();
    controller.select(index);
    void controller.referenceSelected();
  };
  const body = () => {
    if (state.listKind === "recents") {
      if (state.matches.length === 0) {
        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.status, children: "\u8F93\u5165\u4EE5\u641C\u7D22\u5F53\u524D\u5DE5\u4F5C\u533A\u7684\u6587\u4EF6" });
      }
    } else if (state.searching && state.matches.length === 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.status, children: "\u641C\u7D22\u4E2D\u2026" });
    } else if (!state.searching && state.matches.length === 0 && state.error === null) {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.status, children: "\u65E0\u5339\u914D\u6587\u4EF6" });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      state.listKind === "recents" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.section, children: "\u6700\u8FD1\u4F7F\u7528" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { ref: listRef, style: styles.list, role: "listbox", children: state.matches.map((entry, index) => {
        const { dir, name } = splitPath(entry.path);
        const selected = index === state.selected;
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "div",
          {
            role: "option",
            "aria-selected": selected,
            style: selected ? { ...styles.row, ...styles.rowSelected } : styles.row,
            onMouseDown: keepFocus,
            onMouseEnter: () => controller.select(index),
            onClick: (event) => onRowClick(index, event),
            children: [
              entry.rootLabel !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowRoot, children: entry.rootLabel }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: entry.isDir === true ? styles.rowDirName : styles.rowName, children: [
                highlight(name, entry.nameSpans),
                entry.isDir === true && "/"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowDirPinned, title: dir, children: highlightDir(dir, entry.dirSpans) }),
              selected && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  style: styles.rowAction,
                  title: "\u52A0\u5165\u5BF9\u8BDD\uFF08Ctrl+Enter\uFF09",
                  onMouseDown: keepFocus,
                  onClick: (event) => onRowReference(index, event),
                  children: "+ \u5F15\u7528"
                }
              )
            ]
          },
          entry.path
        );
      }) })
    ] });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.backdrop, onMouseDown: onBackdropMouseDown, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: styles.panel,
      role: "dialog",
      "aria-label": "\u5FEB\u901F\u6253\u5F00\u6587\u4EF6",
      onKeyDown,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            ref: inputRef,
            style: styles.input,
            value: state.query,
            placeholder: "\u6A21\u7CCA\u641C\u7D22\u6587\u4EF6\u540D\uFF1B\u7A7A\u683C\u5206\u8BCD\uFF0Cdir: \u524D\u7F00\u9650\u5B9A\u76EE\u5F55\uFF08\u5982 dir:ui index.html\uFF09",
            spellCheck: false,
            onChange: (event) => controller.setQuery(event.target.value)
          }
        ),
        body(),
        state.error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.error, children: [
          "\u641C\u7D22\u5931\u8D25\uFF1A",
          state.error
        ] }),
        state.notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.notice, children: state.notice }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.footer, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u2191\u2193 \u5BFC\u822A" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Tab \u8865\u5168\u8DEF\u5F84" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Enter \u6253\u5F00" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Ctrl+Enter \u52A0\u5165\u5BF9\u8BDD\uFF08\u4E0D\u5173\u95ED\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "dir: \u9650\u5B9A\u76EE\u5F55" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "file: \u9650\u5B9A\u6587\u4EF6\u540D" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Esc \u5173\u95ED" }),
          state.truncated && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u7ED3\u679C\u5DF2\u622A\u65AD\uFF0C\u8BF7\u7EC6\u5316\u5173\u952E\u8BCD" }),
          state.indexInfo !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: "auto" }, children: state.indexInfo })
        ] })
      ]
    }
  ) });
}

// src/client/settings.tsx
var import_react2 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var styles2 = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    fontSize: 13,
    color: "#cccccc",
    maxWidth: 720
  },
  banner: {
    padding: "8px 12px",
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.5
  },
  bannerOk: {
    background: "#1e3a24",
    border: "1px solid #2d5a37",
    color: "#b8e0c0"
  },
  bannerWarn: {
    background: "#3a341e",
    border: "1px solid #5a532d",
    color: "#e6dcae"
  },
  path: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    color: "#9cdcfe",
    wordBreak: "break-all"
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 4
  },
  label: {
    fontSize: 12,
    color: "#9a9a9a"
  },
  hint: {
    fontSize: 11,
    color: "#6a6a6a",
    lineHeight: 1.5
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 68,
    padding: "6px 8px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.6,
    color: "#cccccc",
    background: "#3c3c3c",
    border: "1px solid #555555",
    borderRadius: 4,
    outline: "none",
    resize: "vertical"
  },
  textareaReadonly: {
    background: "#2d2d2d",
    color: "#8a8a8a"
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8
  },
  checkbox: {
    accentColor: "#0e639c"
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    paddingTop: 4
  },
  button: {
    padding: "5px 14px",
    fontSize: 12,
    color: "#ffffff",
    background: "#0e639c",
    border: "none",
    borderRadius: 4,
    cursor: "pointer"
  },
  buttonSecondary: {
    padding: "5px 14px",
    fontSize: 12,
    color: "#cccccc",
    background: "#3a3a3a",
    border: "1px solid #555555",
    borderRadius: 4,
    cursor: "pointer"
  },
  buttonDisabled: {
    opacity: 0.45,
    cursor: "default"
  },
  status: {
    fontSize: 12,
    color: "#9a9a9a"
  },
  statusError: {
    fontSize: 12,
    color: "#f48771"
  }
};
var EMPTY_RULES = {
  excludeDirs: [],
  includeDirs: [],
  includeExtensions: [],
  includeFilenames: [],
  includeDirectories: true,
  extraRoots: []
};
async function post(method, payload) {
  const response = await fetch(`/quick-open/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === void 0) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
  }
  return parsed.value;
}
function toLines(values) {
  return values.join("\n");
}
function fromLines(text) {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}
function parseExtraRootLine(line) {
  const separator = line.indexOf("|");
  if (separator === -1) return { path: line.trim() };
  const path = line.slice(0, separator).trim();
  const label = line.slice(separator + 1).trim();
  return label === "" ? { path } : { path, label };
}
function QuickOpenSettings({ ctx }) {
  const [scope, setScope] = (0, import_react2.useState)(() => readScope(ctx));
  const [rules, setRules] = (0, import_react2.useState)(EMPTY_RULES);
  const [configPath, setConfigPath] = (0, import_react2.useState)("");
  const [configExists, setConfigExists] = (0, import_react2.useState)(false);
  const [indexedEntries, setIndexedEntries] = (0, import_react2.useState)(0);
  const [loading, setLoading] = (0, import_react2.useState)(true);
  const [saving, setSaving] = (0, import_react2.useState)(false);
  const [status, setStatus] = (0, import_react2.useState)(null);
  const [error, setError] = (0, import_react2.useState)(null);
  (0, import_react2.useEffect)(() => ctx.sessions.list.subscribe(() => {
    setScope(readScope(ctx));
  }), [ctx]);
  const hasWorkspace = scope?.cwd !== void 0 && scope.cwd !== "";
  const load = (0, import_react2.useCallback)(async (target) => {
    if (target === void 0 || target.cwd === void 0 || target.cwd === "") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const value = await post("config.get", {
        sessionId: target.sessionId,
        cwd: target.cwd
      });
      setRules(value.rules);
      setConfigPath(value.configPath);
      setConfigExists(value.configExists);
      setIndexedEntries(value.indexedEntries);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  (0, import_react2.useEffect)(() => {
    void load(scope);
  }, [load, scope]);
  const save = (0, import_react2.useCallback)(async () => {
    if (scope?.cwd === void 0 || scope.cwd === "") return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      await post("config.set", { sessionId: scope.sessionId, cwd: scope.cwd, rules });
      setStatus("\u5DF2\u4FDD\u5B58\uFF0C\u6B63\u5728\u6309\u65B0\u89C4\u5219\u91CD\u5EFA\u7D22\u5F15\u2026");
      setConfigExists(true);
      window.setTimeout(() => {
        void load(scope);
        setStatus(null);
      }, 1200);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, [load, rules, scope]);
  const reset = (0, import_react2.useCallback)(async () => {
    if (scope?.cwd === void 0 || scope.cwd === "") return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      await post("config.reset", { sessionId: scope.sessionId, cwd: scope.cwd });
      await load(scope);
      setStatus("\u5DF2\u5220\u9664\u914D\u7F6E\u6587\u4EF6\uFF0C\u6062\u590D\u5185\u7F6E\u9ED8\u8BA4\u89C4\u5219\u3002");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, [load, scope]);
  const readOnly = !hasWorkspace || loading;
  if (!hasWorkspace) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.root, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...styles2.banner, ...styles2.bannerWarn }, children: [
      "\u5F53\u524D\u6CA1\u6709\u6D3B\u8DC3\u4F1A\u8BDD\uFF0C\u65E0\u6CD5\u786E\u5B9A\u8981\u7F16\u8F91\u54EA\u4E2A\u5DE5\u4F5C\u533A\u3002",
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("br", {}),
      "\u7D22\u5F15\u89C4\u5219\u6309\u5DE5\u4F5C\u533A\u5B58\u653E\uFF08",
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: ".dsh/quick-open.json" }),
      " \u4F4D\u4E8E\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\u4E0B\uFF09\uFF0C \u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD\u518D\u56DE\u5230\u6B64\u9762\u677F\u3002"
    ] }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.root, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...styles2.banner, ...styles2.bannerOk }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { children: "\u5F53\u524D\u5DE5\u4F5C\u533A" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.path, children: scope?.cwd }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...styles2.hint, marginTop: 6 }, children: [
        "\u914D\u7F6E\u6587\u4EF6\uFF1A",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.path, children: configPath }),
        configExists ? "\uFF08\u5DF2\u5B58\u5728\uFF09" : "\uFF08\u4E0D\u5B58\u5728\uFF0C\u5F53\u524D\u4F7F\u7528\u5185\u7F6E\u9ED8\u8BA4\u89C4\u5219\uFF09",
        " \xB7 ",
        "\u5DF2\u7D22\u5F15 ",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: indexedEntries.toLocaleString() }),
        " \u9879"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.field, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.label, children: "\u6392\u9664\u76EE\u5F55 excludeDirs" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "textarea",
        {
          style: { ...styles2.textarea, ...readOnly ? styles2.textareaReadonly : {} },
          readOnly,
          spellCheck: false,
          value: toLines(rules.excludeDirs),
          onChange: (event) => setRules((prev) => ({ ...prev, excludeDirs: fromLines(event.target.value) }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.hint, children: [
        "\u6BCF\u884C\u4E00\u4E2A\uFF0C\u76F8\u5BF9\u5DE5\u4F5C\u533A\u6839\u3002",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: "build/go" }),
        " \u53EA\u5339\u914D\u8BE5\u76EE\u5F55\uFF1B",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: "**/shaders/d3d11" }),
        " \u5339\u914D\u4EFB\u610F\u6DF1\u5EA6\u4E0B\u540C\u540D\u76EE\u5F55\u3002\u76EE\u5F55\u88AB\u6392\u9664\u540E\u6574\u68F5\u5B50\u6811\u90FD\u4E0D\u904D\u5386\u3002"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.field, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.label, children: "\u5F3A\u5236\u5305\u542B\u76EE\u5F55 includeDirs" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "textarea",
        {
          style: { ...styles2.textarea, ...readOnly ? styles2.textareaReadonly : {} },
          readOnly,
          spellCheck: false,
          value: toLines(rules.includeDirs),
          onChange: (event) => setRules((prev) => ({ ...prev, includeDirs: fromLines(event.target.value) }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.hint, children: [
        "\u4F18\u5148\u7EA7\u9AD8\u4E8E\u6392\u9664\u76EE\u5F55\u3002\u7528\u4E8E\u6551\u56DE\u88AB\u7236\u7EA7\u6392\u9664\u4F46\u786E\u5B9E\u9700\u8981\u7684\u751F\u6210\u6811\uFF0C \u4F8B\u5982 ",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: "build/p/include" }),
        "\uFF08\u751F\u6210\u7684\u5934\u6587\u4EF6\uFF0C\u6E90\u7801\u4F1A include\uFF09\u3002"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.field, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.label, children: "\u5305\u542B\u540E\u7F00 includeExtensions" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "textarea",
        {
          style: { ...styles2.textarea, ...readOnly ? styles2.textareaReadonly : {} },
          readOnly,
          spellCheck: false,
          value: toLines(rules.includeExtensions),
          onChange: (event) => setRules((prev) => ({ ...prev, includeExtensions: fromLines(event.target.value) }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.hint, children: [
        "\u6BCF\u884C\u4E00\u4E2A\uFF0C\u5E26\u70B9\uFF0C\u5982 ",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: ".cpp" }),
        "\u3002\u53EA\u6709\u8FD9\u4E9B\u540E\u7F00\u7684\u6587\u4EF6\u8FDB\u7D22\u5F15\u3002",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: "\u7559\u7A7A\u8868\u793A\u4E0D\u6309\u540E\u7F00\u8FC7\u6EE4" }),
        "\uFF08\u7D22\u5F15\u904D\u5386\u5230\u7684\u6240\u6709\u6587\u4EF6\uFF09\u3002"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.field, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.label, children: "\u5305\u542B\u6587\u4EF6\u540D includeFilenames" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "textarea",
        {
          style: { ...styles2.textarea, ...readOnly ? styles2.textareaReadonly : {} },
          readOnly,
          spellCheck: false,
          value: toLines(rules.includeFilenames),
          onChange: (event) => setRules((prev) => ({ ...prev, includeFilenames: fromLines(event.target.value) }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.hint, children: [
        "\u6BCF\u884C\u4E00\u4E2A\u5B8C\u6574\u6587\u4EF6\u540D\uFF08\u4E0D\u533A\u5206\u5927\u5C0F\u5199\uFF09\uFF0C\u4E0D\u53D7\u540E\u7F00\u8FC7\u6EE4\u9650\u5236\u3002 \u7528\u4E8E ",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: "CMakeLists.txt" }),
        " \u8FD9\u7C7B\u9700\u8981\u4FDD\u7559\u7684\u540D\u5B57\u3002"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.field, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { style: styles2.row, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          type: "checkbox",
          style: styles2.checkbox,
          disabled: readOnly,
          checked: rules.includeDirectories,
          onChange: (event) => setRules((prev) => ({ ...prev, includeDirectories: event.target.checked }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
        "\u7D22\u5F15\u76EE\u5F55\u6761\u76EE\uFF08\u5173\u95ED\u540E\u65E0\u6CD5\u7528 Ctrl+P \u5F15\u7528 ",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: "@dir/" }),
        "\uFF09"
      ] })
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.field, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.label, children: "\u989D\u5916\u7D22\u5F15\u6839 extraRoots" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "textarea",
        {
          style: { ...styles2.textarea, ...readOnly ? styles2.textareaReadonly : {} },
          readOnly,
          spellCheck: false,
          value: toLines(rules.extraRoots.map((root) => root.label === void 0 ? root.path : `${root.path} | ${root.label}`)),
          onChange: (event) => setRules((prev) => ({
            ...prev,
            extraRoots: fromLines(event.target.value).map(parseExtraRootLine)
          }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.hint, children: [
        "\u6BCF\u884C\u4E00\u4E2A",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: "\u7EDD\u5BF9\u76EE\u5F55\u8DEF\u5F84" }),
        "\uFF0C\u53EF\u52A0 ",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: "| \u522B\u540D" }),
        " \u6307\u5B9A\u7ED3\u679C\u884C\u91CC\u663E\u793A\u7684\u524D\u7F00\u3002 \u7528\u4E8E\u7D22\u5F15\u5DE5\u4F5C\u533A",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("b", { children: "\u4E4B\u5916" }),
        "\u7684\u76EE\u5F55\u2014\u2014\u4F8B\u5982\u5F15\u64CE\u4ED3\u5E93\u4E0E\u6E38\u620F\u4ED3\u5E93\u662F\u5E76\u5217\u7684\u4E24\u4E2A\u6587\u4EF6\u5939\uFF0C\u5F00\u53D1\u65F6\u9700\u8981\u4E92\u67E5\u3002 \u8FD9\u4E9B\u76EE\u5F55\u7528\u4E0E\u5DE5\u4F5C\u533A\u76F8\u540C\u7684\u76EE\u5F55/\u540E\u7F00\u89C4\u5219\u904D\u5386\uFF0C\u7ED3\u679C\u884C\u4EE5\u5B8C\u6574\u7EDD\u5BF9\u8DEF\u5F84\u663E\u793A\u3002"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.actions, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          style: { ...styles2.button, ...readOnly || saving ? styles2.buttonDisabled : {} },
          disabled: readOnly || saving,
          onClick: () => void save(),
          children: saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u5230\u5DE5\u4F5C\u533A"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          style: { ...styles2.buttonSecondary, ...readOnly || saving ? styles2.buttonDisabled : {} },
          disabled: readOnly || saving,
          onClick: () => void reset(),
          children: "\u6062\u590D\u9ED8\u8BA4"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          style: { ...styles2.buttonSecondary, ...readOnly || saving ? styles2.buttonDisabled : {} },
          disabled: readOnly || saving,
          onClick: () => void load(scope),
          children: "\u91CD\u65B0\u8BFB\u53D6"
        }
      ),
      status !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.status, children: status }) : null,
      error !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.statusError, children: error }) : null
    ] })
  ] });
}
function readScope(ctx) {
  const snapshot = ctx.sessions.list.getSnapshot();
  const sessionId = snapshot.current;
  if (sessionId === void 0) return void 0;
  const cwd = snapshot.byId[sessionId]?.cwd;
  return { sessionId, ...cwd !== void 0 && cwd !== "" ? { cwd } : {} };
}
var quickOpenSettingsSection = {
  name: "settings.section",
  id: "dsh-quick-open",
  order: 60,
  label: "Quick Open \u7D22\u5F15"
};

// src/client/index.tsx
var inject = ["slots", "sessions"];
function apply(ctx) {
  const store = createQuickOpenStore();
  const controller = createQuickOpenController(ctx, store);
  ctx.effect(() => {
    const onKey = (event) => {
      if (isImeComposition(event)) return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key !== "p" && event.key !== "P") return;
      if (!controller.canServe()) return;
      event.preventDefault();
      event.stopPropagation();
      controller.toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, "dsh-quick-open: global Ctrl+P listener");
  ctx.effect(() => {
    const onKey = (event) => {
      if (event.key !== "Tab") return;
      if (!controller.store.getSnapshot().open) return;
      if (isImeComposition(event)) return;
      event.preventDefault();
      event.stopPropagation();
      controller.completeSelected();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, "dsh-quick-open: Tab completion while open");
  ctx.effect(
    () => ctx.sessions.list.subscribe(() => controller.closeOnSessionChange()),
    "dsh-quick-open: session-switch close"
  );
  ctx.slots.inject(
    "conversation.input.overlay",
    () => ctx.slots.register(
      {
        name: "conversation.input.overlay",
        id: "dsh-quick-open",
        order: 10
      },
      () => (0, import_react3.createElement)(QuickOpenLayer, { controller })
    )
  );
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      quickOpenSettingsSection,
      () => (0, import_react3.createElement)(QuickOpenSettings, { ctx })
    )
  );
}
		return module.exports;
	}
});

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
var import_react2 = require("react");

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
function fileMention(relativePath) {
  const path = relativePath.replace(/[\\/]+$/, "");
  if (/[\u0000-\u001f\u007f-\u009f\u0022]/u.test(path)) return void 0;
  const mention = /\s/u.test(path) ? `@"${path}"` : `@${path}`;
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const label = at === -1 ? path : path.slice(at + 1);
  return { mention, label };
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
    const at = rel.lastIndexOf("/");
    const name = (at === -1 ? rel : rel.slice(at + 1)).toLowerCase();
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
  let lastServed = null;
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
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string").map((path) => ({ path })) : [];
    } catch {
      return [];
    }
  };
  const pushRecent = (rel) => {
    const key = recentsKey();
    if (key === void 0) return;
    const paths = [rel, ...loadRecents().map((e) => e.path).filter((x) => x !== rel)].slice(0, RECENTS_CAP);
    try {
      window.localStorage.setItem(key, JSON.stringify(paths));
    } catch {
    }
    const state = store.getSnapshot();
    if (state.open && state.listKind === "recents") {
      store.set({ matches: paths.map((path) => ({ path })), selected: 0 });
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
      entries: legacy.matches.map((path) => ({ path })),
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
    if (lastServed !== null && lastServed.complete && lastServed.scopeKey === scopeKey && lastServed.needle !== "" && needle.startsWith(lastServed.needle) && needle !== lastServed.needle) {
      const filtered = lastServed.entries.filter((entry) => nameLowerOf(entry.path).includes(needle));
      const ranked = rankMatches(filtered, query);
      lastServed = { scopeKey, needle, entries: ranked, complete: true };
      cachePut(`${scopeKey}
${needle}`, { entries: ranked, complete: true });
      cancelSearch();
      searchSeq += 1;
      store.set({
        searching: false,
        matches: ranked,
        truncated: false,
        selected: 0,
        error: null,
        listKind: "search"
      });
      return;
    }
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
      const ranked = rankMatches(found.entries, query);
      const complete = !found.truncated;
      lastServed = { scopeKey, needle, entries: ranked, complete };
      cachePut(`${scopeKey}
${needle}`, { entries: ranked, complete });
      store.set({
        searching: false,
        matches: ranked,
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
    return probeIsDir(scope, entry.path);
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
    service.openFile(scope, resolveWorkspacePath(scope.cwd, entry.path));
    pushRecent(entry.path);
    close();
  };
  const appendMentionText = (sessionId, mention) => {
    const actx = ctx.sessions.scope(sessionId);
    const conversation = ctx.get("conversation");
    if (actx === void 0 || conversation === void 0) return false;
    const input = conversation.input.for(actx);
    const draft = input.state.getSnapshot().draft;
    input.setDraft(draft.trim() === "" ? mention : `${draft} ${mention}`);
    return true;
  };
  const referenceSelected = async () => {
    const entry = selectedMatch();
    if (entry === void 0) return;
    const scope = currentScope();
    if (scope === void 0) return;
    if (await resolveIsDir(scope, entry)) {
      const mention = `@${entry.path.replace(/[\\/]+$/, "")}/`;
      if (appendMentionText(scope.sessionId, mention)) {
        pushRecent(entry.path);
        notice(`\u5DF2\u52A0\u5165\u5BF9\u8BDD ${mention}`);
      } else {
        notice("\u5BF9\u8BDD\u670D\u52A1\u4E0D\u53EF\u7528");
      }
      reclaimFocus();
      return;
    }
    const reference = fileMention(entry.path);
    if (reference === void 0) {
      notice("\u8DEF\u5F84\u5305\u542B\u65E0\u6CD5\u5F15\u7528\u7684\u5B57\u7B26");
      reclaimFocus();
      return;
    }
    const actx = ctx.sessions.scope(scope.sessionId);
    const conversation = ctx.get("conversation");
    if (actx === void 0 || conversation === void 0) {
      notice("\u5BF9\u8BDD\u670D\u52A1\u4E0D\u53EF\u7528");
      reclaimFocus();
      return;
    }
    const input = conversation.input.for(actx);
    const before = input.state.getSnapshot();
    let inserted = false;
    if (before.draftRev !== void 0) {
      try {
        actx.emit("slash/input-insert-reference", {
          reference: {
            source: "reference",
            ref: reference.mention,
            label: reference.label,
            appearance: "file",
            clipboardText: reference.mention
          },
          span: {
            draftRev: before.draftRev,
            start: before.draft.length,
            end: before.draft.length
          }
        });
        inserted = input.state.getSnapshot().draftRev !== before.draftRev;
      } catch {
        inserted = false;
      }
    }
    if (!inserted) {
      const draft = before.draft;
      input.setDraft(draft.trim() === "" ? reference.mention : `${draft} ${reference.mention}`);
    }
    pushRecent(entry.path);
    notice(`\u5DF2\u52A0\u5165\u5BF9\u8BDD ${reference.mention}`);
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
    overflow: "hidden"
  },
  rowSelected: {
    background: "#094771"
  },
  rowName: {
    color: "#e8e8e8",
    flexShrink: 0
  },
  rowDirName: {
    color: "#4fc1ff",
    flexShrink: 0
  },
  rowHit: {
    color: "#4ec9b0"
  },
  rowDir: {
    color: "#8a8a8a",
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1
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
function highlightName(name, query) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return name;
  const at = name.toLowerCase().indexOf(needle);
  if (at === -1) return name;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    name.slice(0, at),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowHit, children: name.slice(at, at + needle.length) }),
    name.slice(at + needle.length)
  ] });
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
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: entry.isDir === true ? styles.rowDirName : styles.rowName, children: [
                highlightName(name, state.query),
                entry.isDir === true && "/"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowDir, children: dir }),
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
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.backdrop, onMouseDown: keepFocus, onClick: () => controller.close(), children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: styles.panel,
      role: "dialog",
      "aria-label": "\u5FEB\u901F\u6253\u5F00\u6587\u4EF6",
      onClick: (event) => event.stopPropagation(),
      onKeyDown,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            ref: inputRef,
            style: styles.input,
            value: state.query,
            placeholder: "\u6309\u6587\u4EF6\u540D\u641C\u7D22\uFF08Enter \u6253\u5F00\uFF0CCtrl+Enter \u52A0\u5165\u5BF9\u8BDD\uFF09",
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
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Enter \u6253\u5F00" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Ctrl+Enter \u52A0\u5165\u5BF9\u8BDD\uFF08\u4E0D\u5173\u95ED\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Esc \u5173\u95ED" }),
          state.truncated && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u7ED3\u679C\u5DF2\u622A\u65AD\uFF0C\u8BF7\u7EC6\u5316\u5173\u952E\u8BCD" }),
          state.indexInfo !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: "auto" }, children: state.indexInfo })
        ] })
      ]
    }
  ) });
}

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
      () => (0, import_react2.createElement)(QuickOpenLayer, { controller })
    )
  );
}
		return module.exports;
	}
});

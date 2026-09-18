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
var import_react6 = require("react");

// src/client/store.ts
var INITIAL = {
  open: false,
  sessionId: void 0,
  query: "",
  matches: [],
  listKind: "search",
  drillPrefix: void 0,
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
function splitLineSuffix(query) {
  const match = /:(\d+)$/u.exec(query);
  if (match === null) return { query };
  const line = Number(match[1]);
  if (!Number.isSafeInteger(line) || line < 1) return { query };
  return { query: query.slice(0, match.index).trimEnd(), line };
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
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}
function fileAddressFor(sessionId, cwd, path) {
  const normalized = path.replace(/\\/g, "/");
  const root = cwd === void 0 ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = !isAbsolutePath(normalized) ? normalized.replace(/^(?:\.\/)+/, "") : root !== "" && normalized === root ? "" : root !== "" && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  const encoded = relative.split("/").map(encodeSegment).join("/");
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`;
}
function fileMention(path, kind) {
  const base = path.replace(/[\\/]+$/, "");
  const text = kind === "directory" ? `${base}/` : base;
  if (/[\u0000-\u001f\u007f-\u009f\u0022]/u.test(text)) return void 0;
  if (!/\s/u.test(text)) return `@${text}`;
  return kind === "directory" ? `@"${text}` : `@"${text}"`;
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
    const result = await apiCall("/quick-open/api", "probe", scopePayload(scope, { path: relativePath }));
    return result.isDir === true;
  } catch {
    return false;
  }
}
function createQuickOpenController(ctx, store) {
  let debounceTimer;
  let noticeTimer;
  let inFlight;
  let searchSeq = 0;
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
  const sidebarRight = () => ctx.get("sidebarRight");
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
    const found = await apiCall("/quick-open/api", "search", scopePayload(scope, { query }), signal);
    const indexInfo = found.indexedEntries !== void 0 ? `\u7D22\u5F15 ${found.indexedEntries.toLocaleString()} \u9879 \xB7 ${Math.round((found.indexAge ?? 0) / 1e3)}s \u524D` : null;
    return { entries: found.matches, truncated: found.truncated, indexInfo };
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
    const { query: searchText } = splitLineSuffix(query);
    if (searchText === "") {
      cancelSearch();
      searchSeq += 1;
      store.set({ matches: loadRecents(), listKind: "recents", truncated: false, selected: 0, searching: false, error: null });
      return;
    }
    const scopeKey = scopeKeyOf(scope);
    const needle = searchText.toLowerCase();
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
    fetchEntries(scope, searchText, controller.signal).then((found) => {
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
    const state = store.getSnapshot();
    if (state.listKind === "drill" && query.trim() !== `${state.drillPrefix ?? ""}/`) {
      store.set({ listKind: "search", drillPrefix: void 0 });
    }
    store.set({ query });
    if (debounceTimer !== void 0) window.clearTimeout(debounceTimer);
    if (query.trim() === "") {
      cancelSearch();
      searchSeq += 1;
      store.set({ matches: loadRecents(), listKind: "recents", drillPrefix: void 0, truncated: false, selected: 0, searching: false, error: null });
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
    const { query: trimmed, line } = splitLineSuffix(state.query.trim());
    const lineSuffix = line === void 0 ? "" : `:${line}`;
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
    const next = `${headText === "" ? "" : `${headText} `}${prefixText}${completed}${lineSuffix}`;
    const drillable = entry.isDir === true && scope !== "name" && lineSuffix === "";
    if (drillable) {
      cancelSearch();
      searchSeq += 1;
      store.set({ query: next });
      drillInto(path.replace(/\/+$/, ""));
      return;
    }
    applyQuery(next);
  };
  const drillInto = (prefix) => {
    const scope = currentScope();
    if (scope === void 0) return;
    cancelSearch();
    const seq = ++searchSeq;
    const controller = new AbortController();
    inFlight = controller;
    store.set({ searching: true, error: null });
    apiCall("/quick-open/api", "children", scopePayload(scope, { prefix }), controller.signal).then((found) => {
      if (seq !== searchSeq || controller.signal.aborted) return;
      const indexInfo = found.indexedEntries !== void 0 ? `\u7D22\u5F15 ${found.indexedEntries.toLocaleString()} \u9879 \xB7 ${Math.round((found.indexAge ?? 0) / 1e3)}s \u524D` : null;
      store.set({
        searching: false,
        matches: found.matches,
        truncated: found.truncated,
        listKind: "drill",
        drillPrefix: prefix,
        selected: 0,
        error: null,
        indexInfo,
        notice: prefix === "" ? "\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55" : `\u8FDB\u5165 ${prefix}/`
      });
    }).catch((failure) => {
      if (seq !== searchSeq || controller.signal.aborted) return;
      store.set({
        searching: false,
        matches: [],
        truncated: false,
        listKind: "search",
        drillPrefix: void 0,
        error: failure instanceof Error ? failure.message : String(failure)
      });
    });
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
    const service = sidebarRight();
    if (service === void 0) {
      notice("\u4FA7\u8FB9\u680F\u670D\u52A1\u672A\u5C31\u7EEA\uFF0C\u6682\u65F6\u65E0\u6CD5\u6253\u5F00\u6587\u4EF6");
      reclaimFocus();
      return;
    }
    const line = splitLineSuffix(store.getSnapshot().query.trim()).line;
    try {
      service.openResource(
        fileAddressFor(scope.sessionId, scope.cwd, absolutePathOf(scope, entry)),
        line === void 0 ? void 0 : { params: { line } }
      );
    } catch (error) {
      notice(error instanceof Error ? error.message : "\u65E0\u6CD5\u6253\u5F00\u8FD9\u4E2A\u6587\u4EF6");
      reclaimFocus();
      return;
    }
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
    const kind = await resolveIsDir(scope, entry) ? "directory" : "file";
    const reference = fileMention(referencePath, kind);
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
var import_react_dom = require("react-dom");

// src/client/ime-guard.ts
function isImeComposition(event) {
  return event.isComposing === true || event.keyCode === 229;
}

// src/client/shortcut.ts
var DEFAULT_SHORTCUT = {
  mod: true,
  ctrl: false,
  shift: false,
  alt: false,
  key: "p"
};
var SHORTCUT_KEY = "dsh-quick-open:shortcut";
function isMacPlatform() {
  const nav = globalThis.navigator;
  if (nav === void 0) return false;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
  return /mac|iphone|ipad|ipod/iu.test(platform);
}
function bindableKey(eventKey) {
  if (eventKey === " ") return "space";
  if (eventKey.length !== 1) return void 0;
  return eventKey.toLowerCase();
}
function matchesShortcut(shortcut, event, mac = isMacPlatform()) {
  const key = bindableKey(event.key);
  if (key === void 0 || key !== shortcut.key) return false;
  const eventMod = mac ? event.metaKey : event.ctrlKey;
  const eventCtrl = mac ? event.ctrlKey : false;
  if (shortcut.mod !== eventMod) return false;
  if (shortcut.ctrl !== eventCtrl) return false;
  if (shortcut.shift !== event.shiftKey) return false;
  if (shortcut.alt !== event.altKey) return false;
  return true;
}
function describeShortcut(shortcut, mac = isMacPlatform()) {
  const parts = [];
  if (shortcut.mod) parts.push(mac ? "Cmd" : "Ctrl");
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.shift) parts.push("Shift");
  if (shortcut.alt) parts.push(mac ? "Option" : "Alt");
  parts.push(shortcut.key === "space" ? "Space" : shortcut.key.toUpperCase());
  return parts.join("+");
}
function validateShortcut(shortcut) {
  if (!shortcut.mod && !shortcut.ctrl && !shortcut.shift && !shortcut.alt) {
    return "\u81F3\u5C11\u9700\u8981\u4E00\u4E2A\u4FEE\u9970\u952E\uFF08Ctrl / Cmd / Shift / Alt\uFF09";
  }
  if (shortcut.key === "") return "\u7F3A\u5C11\u4E3B\u952E";
  return void 0;
}
function readShortcut() {
  try {
    const raw = window.localStorage.getItem(SHORTCUT_KEY);
    if (raw === null) return DEFAULT_SHORTCUT;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SHORTCUT;
    const record = parsed;
    const key = record.key;
    if (typeof key !== "string" || bindableKey(key) !== key) return DEFAULT_SHORTCUT;
    const shortcut = {
      mod: record.mod === true,
      ctrl: record.ctrl === true,
      shift: record.shift === true,
      alt: record.alt === true,
      key
    };
    return validateShortcut(shortcut) === void 0 ? shortcut : DEFAULT_SHORTCUT;
  } catch {
    return DEFAULT_SHORTCUT;
  }
}
function writeShortcut(shortcut) {
  try {
    window.localStorage.setItem(SHORTCUT_KEY, JSON.stringify(shortcut));
  } catch {
  }
}
function shortcutFromEvent(event, mac = isMacPlatform()) {
  const key = bindableKey(event.key);
  if (key === void 0) return "\u8BF7\u6309\u4E00\u4E2A\u5B57\u6BCD\u3001\u6570\u5B57\u6216\u7B26\u53F7\u952E\uFF08\u4E0D\u80FD\u53EA\u6309\u4FEE\u9970\u952E\uFF09";
  const shortcut = {
    mod: mac ? event.metaKey : event.ctrlKey,
    ctrl: mac ? event.ctrlKey : false,
    shift: event.shiftKey,
    alt: event.altKey,
    key
  };
  const problem = validateShortcut(shortcut);
  return problem === void 0 ? shortcut : problem;
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
  const boundShortcut = readShortcut();
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
    } else if (state.listKind === "drill" && !state.searching && state.matches.length === 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.status, children: "\u8BE5\u76EE\u5F55\u4E3A\u7A7A" });
    } else if (state.searching && state.matches.length === 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.status, children: "\u641C\u7D22\u4E2D\u2026" });
    } else if (!state.searching && state.matches.length === 0 && state.error === null) {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.status, children: "\u65E0\u5339\u914D\u6587\u4EF6" });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      state.listKind === "recents" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.section, children: "\u6700\u8FD1\u4F7F\u7528" }),
      state.listKind === "drill" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.section, children: state.drillPrefix === "" ? "\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55" : `${state.drillPrefix}/` }),
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
  return (0, import_react_dom.createPortal)(
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.backdrop, onMouseDown: onBackdropMouseDown, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
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
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: ":\u884C\u53F7 \u8DF3\u884C" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Ctrl+Enter \u52A0\u5165\u5BF9\u8BDD\uFF08\u4E0D\u5173\u95ED\uFF09" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "dir: \u9650\u5B9A\u76EE\u5F55" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "file: \u9650\u5B9A\u6587\u4EF6\u540D" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Esc \u5173\u95ED" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
              describeShortcut(boundShortcut),
              " \u5F00\u5173"
            ] }),
            state.truncated && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u7ED3\u679C\u5DF2\u622A\u65AD\uFF0C\u8BF7\u7EC6\u5316\u5173\u952E\u8BCD" }),
            state.indexInfo !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: "auto" }, children: state.indexInfo })
          ] })
        ]
      }
    ) }),
    document.body
  );
}

// src/client/settings.tsx
var import_react2 = require("react");

// src/client/preview/selection.ts
var DEFAULT_SELECTION_FORMAT = "path";
var SELECTION_FORMAT_KEY = "dsh-quick-open:selection-format";
function readSelectionFormat() {
  try {
    const raw = window.localStorage.getItem(SELECTION_FORMAT_KEY);
    return raw === "path" || raw === "path-hint" || raw === "content" ? raw : DEFAULT_SELECTION_FORMAT;
  } catch {
    return DEFAULT_SELECTION_FORMAT;
  }
}
function writeSelectionFormat(value) {
  try {
    window.localStorage.setItem(SELECTION_FORMAT_KEY, value);
  } catch {
  }
}
var CONTENT_LIMIT = 4e3;
var HINT_LINES_SUGGESTED = 60;
function mentionOf(relativePath) {
  const path = relativePath.replace(/^\/+/u, "");
  if (/[\u0000-\u001f\u007f-\u009f\u0022]/u.test(path)) return void 0;
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}
function locationOf(relativePath, lines) {
  return lines.end > lines.start ? `${relativePath}:${lines.start}-${lines.end}` : `${relativePath}:${lines.start}`;
}
function buildSelectionText(input) {
  const { relativePath, lines, selected, format } = input;
  const mention = mentionOf(relativePath);
  if (mention === void 0) return void 0;
  const location = lines === void 0 ? mention : `${mention}:${lines.end > lines.start ? `${lines.start}-${lines.end}` : lines.start}`;
  if (format === "content") {
    if (selected.length > CONTENT_LIMIT) return location;
    const head = lines === void 0 ? relativePath : locationOf(relativePath, lines);
    return `\`\`\`${head}
${selected}
\`\`\``;
  }
  if (format === "path-hint") {
    if (lines === void 0) return location;
    const span = lines.end > lines.start ? `\u7B2C ${lines.start}-${lines.end} \u884C` : `\u7B2C ${lines.start} \u884C`;
    const tooLong = lines.end - lines.start + 1 > HINT_LINES_SUGGESTED ? "\u8303\u56F4\u8F83\u957F\uFF0C\u53EF\u53EA\u8BFB\u53D6\u5176\u4E2D\u76F8\u5173\u90E8\u5206\u3002" : "";
    return `${location}\uFF08${span}\uFF0C\u8BF7\u7528 read \u5DE5\u5177\u8BFB\u53D6\u8BE5\u6587\u4EF6\u7684\u8FD9\u4E00\u6BB5\uFF09${tooLong}`;
  }
  return location;
}
function appendToDraft(ctx, sessionId, text) {
  try {
    const actx = ctx?.sessions?.scope?.(sessionId);
    if (actx === void 0) return false;
    const conversation = ctx?.get("conversation");
    if (conversation === void 0) return false;
    const input = conversation.input.for(actx);
    const draft = input.state.getSnapshot().draft;
    const trimmed = draft.replace(/\s+$/u, "");
    input.setDraft(trimmed === "" ? text : `${trimmed} ${text}`);
    return true;
  } catch (error) {
    console.warn("[dsh-quick-open] draft fill failed:", error);
    return false;
  }
}

// src/client/settings.tsx
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
  select: {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    fontSize: 12,
    color: "#cccccc",
    background: "#3c3c3c",
    border: "1px solid #555555",
    borderRadius: 4,
    outline: "none"
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
  buttonRecording: {
    background: "#7a3d0e",
    outline: "1px dashed #d7a05a",
    outlineOffset: 1
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
  const [selectionFormat, setSelectionFormat] = (0, import_react2.useState)(() => readSelectionFormat());
  const [shortcut, setShortcut] = (0, import_react2.useState)(() => readShortcut());
  const [recording, setRecording] = (0, import_react2.useState)(false);
  const [shortcutError, setShortcutError] = (0, import_react2.useState)(null);
  const onRecorderKeyDown = (0, import_react2.useCallback)((event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      setShortcutError(null);
      return;
    }
    const next = shortcutFromEvent(event.nativeEvent);
    if (typeof next === "string") {
      setShortcutError(next);
      return;
    }
    setShortcutError(null);
    setShortcut(next);
    writeShortcut(next);
    setRecording(false);
  }, [recording]);
  const resetShortcut = (0, import_react2.useCallback)(() => {
    setShortcut(DEFAULT_SHORTCUT);
    writeShortcut(DEFAULT_SHORTCUT);
    setShortcutError(null);
    setRecording(false);
  }, []);
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
  const viewerSection = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.field, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.label, children: "\u6587\u4EF6\u67E5\u770B\u5668\uFF1A\u9009\u4E2D\u6587\u672C\u52A0\u5165\u4F1A\u8BDD\u7684\u683C\u5F0F" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "select",
      {
        style: styles2.select,
        value: selectionFormat,
        onChange: (event) => {
          const next = event.target.value;
          setSelectionFormat(next);
          writeSelectionFormat(next);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "path", children: "\u4EC5\u4F4D\u7F6E\uFF1A@path/file.cpp:12-15" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "path-hint", children: "\u4F4D\u7F6E + \u63D0\u793A\u6A21\u578B\u53BB\u8BFB\u53D6\u8BE5\u6BB5" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "content", children: "\u4F4D\u7F6E + \u56F4\u680F\u4EE3\u7801\u5757\uFF08\u5E26\u4E0A\u9009\u4E2D\u5185\u5BB9\uFF09" })
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.hint, children: [
      "\u5728\u4FA7\u8FB9\u680F\u6587\u4EF6\u91CC\u9009\u4E2D\u6587\u672C\u540E\u70B9\u300C\u52A0\u5165\u4F1A\u8BDD\u300D\u65F6\u63D2\u5165\u7684\u5185\u5BB9\u3002",
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("br", {}),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: "\u4EC5\u4F4D\u7F6E" }),
      "\u6700\u7701\u4E0A\u4E0B\u6587\uFF0C\u6A21\u578B\u81EA\u884C\u8BFB\u53D6\u6240\u9700\u8303\u56F4\uFF1B",
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: "\u4F4D\u7F6E + \u63D0\u793A" }),
      "\u591A\u4E00\u53E5\u300C\u8BF7\u7528 read \u8BFB\u53D6\u8BE5\u6BB5\u300D\uFF0C\u80FD\u51CF\u5C11\u6A21\u578B\u5FFD\u7565\u884C\u53F7\u7684\u60C5\u51B5\uFF1B",
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: "\u56F4\u680F\u4EE3\u7801\u5757" }),
      "\u628A\u9009\u4E2D\u5185\u5BB9\u4E00\u5E76\u5E26\u5165\uFF0C\u4EE3\u4EF7\u662F\u6BCF\u8F6E\u90FD\u91CD\u590D\u8FD9\u6BB5\u4EE3\u7801\u3002"
    ] })
  ] });
  const shortcutSection = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.field, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: styles2.label, children: "\u547C\u51FA\u5FEB\u901F\u6253\u5F00\u9762\u677F\u7684\u5FEB\u6377\u952E" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          style: { ...styles2.button, ...recording ? styles2.buttonRecording : {} },
          onClick: () => setRecording(true),
          onBlur: () => setRecording(false),
          onKeyDown: onRecorderKeyDown,
          children: recording ? "\u6309\u4E0B\u65B0\u7684\u5FEB\u6377\u952E\u2026\uFF08Esc \u53D6\u6D88\uFF09" : describeShortcut(shortcut, isMacPlatform())
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          style: styles2.button,
          onClick: resetShortcut,
          disabled: recording,
          children: "\u6062\u590D\u9ED8\u8BA4"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.hint, children: [
      "\u70B9\u4E0A\u9762\u7684\u6309\u94AE\u518D\u6309\u4E00\u6B21\u65B0\u7684\u7EC4\u5408\u952E\u5373\u53EF\uFF08\u5FC5\u987B\u5E26\u4FEE\u9970\u952E\uFF09\u3002",
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("br", {}),
      "\u9ED8\u8BA4\uFF1A",
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: describeShortcut(DEFAULT_SHORTCUT, isMacPlatform()) }),
      "\uFF0C\u5176\u4E2D ",
      isMacPlatform() ? "Cmd" : "Ctrl",
      " \u662F",
      isMacPlatform() ? "macOS" : "\u672C\u5E73\u53F0",
      "\u7684\u4E3B\u4FEE\u9970\u952E\u2014\u2014\u540C\u4E00\u4EFD\u914D\u7F6E\u6362\u5230",
      isMacPlatform() ? " Windows \u4F1A\u6309 Ctrl" : " macOS \u4F1A\u6309 Cmd",
      " \u89E3\u91CA\uFF0C \u6240\u4EE5\u8DE8\u5E73\u53F0\u7684\u4E60\u60EF\u90FD\u80FD\u5BF9\u4E0A\u3002",
      shortcutError !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("br", {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "#e6a0a0" }, children: shortcutError })
      ] })
    ] })
  ] });
  if (!hasWorkspace) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: styles2.root, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...styles2.banner, ...styles2.bannerWarn }, children: [
        "\u5F53\u524D\u6CA1\u6709\u6D3B\u8DC3\u4F1A\u8BDD\uFF0C\u65E0\u6CD5\u786E\u5B9A\u8981\u7F16\u8F91\u54EA\u4E2A\u5DE5\u4F5C\u533A\u3002",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("br", {}),
        "\u7D22\u5F15\u89C4\u5219\u6309\u5DE5\u4F5C\u533A\u5B58\u653E\uFF08",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: ".dsh/quick-open.json" }),
        " \u4F4D\u4E8E\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\u4E0B\uFF09\uFF0C \u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD\u518D\u56DE\u5230\u6B64\u9762\u677F\u3002"
      ] }),
      viewerSection,
      shortcutSection
    ] });
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
    viewerSection,
    shortcutSection,
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
        "\u7D22\u5F15\u76EE\u5F55\u6761\u76EE\uFF08\u5173\u95ED\u540E\u65E0\u6CD5\u5728\u5FEB\u901F\u6253\u5F00\u9762\u677F\u91CC\u5F15\u7528 ",
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

// src/client/preview/index.ts
var import_react5 = require("react");
var import_client = require("react-dom/client");

// src/client/preview/styles.ts
var TAG_ID = "dsh-quick-open/preview.css";
var CSS = `
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
.qo-preview-find-button[aria-pressed="true"] {
  color: var(--dsw-alias-label-primary, #eeeeee);
  background: var(--dsw-alias-interactive-bg-active, #094771);
  border-color: var(--dsw-alias-interactive-border-focus, #007fd4);
}
.qo-preview-find-partial {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #777777);
  white-space: nowrap;
}

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
`;
var injected = false;
function ensurePreviewStyles() {
  if (injected || typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) {
    injected = true;
    return;
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-quick-open";
  tag.dataset.pluginCss = TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
  injected = true;
}
var previewCss = {
  find: "qo-preview-find",
  findCount: "qo-preview-find-count",
  findButton: "qo-preview-find-button",
  findPartial: "qo-preview-find-partial",
  selection: "qo-preview-selection",
  notice: "qo-preview-notice"
};

// src/client/preview/Augmentations.tsx
var import_react3 = require("react");
var import_react4 = require("react");
var import_react_dom2 = require("react-dom");

// src/client/preview/address.ts
var FILE_ADDRESS_PREFIX = "dsh-resource://file/";
function parseFileAddress(address) {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return void 0;
  const end = address.search(/[?#]/u);
  const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? void 0 : end);
  const [scope, ...rest] = body.split("/");
  if (scope !== "session") return void 0;
  const [id, ...segments] = rest;
  if (id === void 0 || id === "" || segments.length === 0) return void 0;
  try {
    return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join("/") };
  } catch {
    return void 0;
  }
}

// src/client/preview/probe.ts
var PREVIEW_ROOT_SELECTOR = "[data-textpreview-url]";
function previewRootOf(node) {
  if (node === null) return null;
  const element = node.nodeType === 1 ? node : node.parentElement;
  return element?.closest(PREVIEW_ROOT_SELECTOR) ?? null;
}
function isVisible(element) {
  let node = element;
  while (node !== null) {
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    node = node.parentElement;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function visiblePreviews() {
  const out = [];
  for (const element of document.querySelectorAll(PREVIEW_ROOT_SELECTOR)) {
    if (!(element instanceof HTMLElement)) continue;
    const raw = element.dataset.textpreviewUrl;
    if (raw === void 0) continue;
    const address = parseFileAddress(raw);
    if (address === void 0) continue;
    if (!isVisible(element)) continue;
    out.push({ root: element, address });
  }
  return out;
}
function addressOfRoot(root) {
  const raw = root.dataset.textpreviewUrl;
  return raw === void 0 ? void 0 : parseFileAddress(raw);
}
function lineOfNode(root, node) {
  const element = node.nodeType === 1 ? node : node.parentElement;
  if (element === null) return void 0;
  const plain = element.closest("[data-textpreview-line]");
  if (plain !== null && root.contains(plain)) {
    const parsed = Number(plain.getAttribute("data-textpreview-line"));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
  }
  const codeLine = element.closest("pre .line");
  if (codeLine !== null && root.contains(codeLine)) {
    const pre = codeLine.closest("pre");
    if (pre === null || !root.contains(pre)) return void 0;
    const lines = pre.querySelectorAll(".line");
    const index = Array.prototype.indexOf.call(lines, codeLine);
    return index >= 0 ? index + 1 : void 0;
  }
  return void 0;
}

// src/client/preview/find.ts
var MATCH_LIMIT = 1e3;
var HIGHLIGHT_MATCH = "qo-preview-find-match";
var HIGHLIGHT_CURRENT = "qo-preview-find-current";
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function matchSpans(pieces, query, caseSensitive = false) {
  if (query === "") return [];
  const joined = pieces.map((piece) => piece.text).join("");
  const pattern = new RegExp(escapeRegExp(query), caseSensitive ? "gu" : "giu");
  const spans = [];
  for (; ; ) {
    const hit = pattern.exec(joined);
    if (hit === null) break;
    spans.push({ from: hit.index, to: hit.index + hit[0].length });
    if (spans.length >= MATCH_LIMIT) break;
  }
  return spans;
}
function collectTextPieces(root) {
  const scope = root.querySelector("[data-textpreview-plain], [data-code-preview]") ?? root;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      if ((node.textContent ?? "") === "") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const pieces = [];
  let start = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    pieces.push({ node, start, text });
    start += text.length;
  }
  return pieces;
}
function rangeForSpan(pieces, span) {
  const first = pieces.find((piece) => span.from < piece.start + piece.text.length);
  const last = pieces.find((piece) => span.to <= piece.start + piece.text.length);
  if (first === void 0 || last === void 0) return void 0;
  const range = document.createRange();
  range.setStart(first.node, span.from - first.start);
  range.setEnd(last.node, span.to - last.start);
  return range;
}
function highlightRegistry() {
  const css = globalThis.CSS;
  return css?.highlights;
}
function highlightCtor() {
  return globalThis.Highlight;
}
function paintMatches(pieces, spans, current) {
  const ranges = [];
  for (const span of spans) {
    const range = rangeForSpan(pieces, span);
    if (range !== void 0) ranges.push(range);
  }
  const registry = highlightRegistry();
  const Ctor = highlightCtor();
  if (registry !== void 0 && Ctor !== void 0) {
    const rest = ranges.filter((_, index) => index !== current);
    const active = ranges[current];
    if (rest.length > 0) registry.set(HIGHLIGHT_MATCH, new Ctor(...rest));
    else registry.delete(HIGHLIGHT_MATCH);
    if (active !== void 0) registry.set(HIGHLIGHT_CURRENT, new Ctor(active));
    else registry.delete(HIGHLIGHT_CURRENT);
  }
  return ranges;
}
function clearMatches() {
  const registry = highlightRegistry();
  if (registry === void 0) return;
  registry.delete(HIGHLIGHT_MATCH);
  registry.delete(HIGHLIGHT_CURRENT);
}
function revealMatch(range) {
  const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  element?.scrollIntoView({ block: "center", behavior: "auto" });
}

// src/client/preview/locales.ts
var en = {
  noConversation: "The conversation service is unavailable.",
  added: "Added to conversation",
  addSelection: "Add to conversation",
  findPlaceholder: "Find in file",
  findPrevious: "Previous match (Shift+Enter)",
  findNext: "Next match (Enter)",
  findClose: "Close (Esc)",
  findCaseSensitive: "Match case",
  noResults: "No results",
  partialCoverage: "loaded part",
  partialCoverageHint: "The file has pages not yet loaded; only the loaded part was searched."
};
var zh = {
  noConversation: "\u5BF9\u8BDD\u670D\u52A1\u4E0D\u53EF\u7528\u3002",
  added: "\u5DF2\u52A0\u5165\u4F1A\u8BDD",
  addSelection: "\u52A0\u5165\u4F1A\u8BDD",
  findPlaceholder: "\u5728\u6587\u4EF6\u4E2D\u67E5\u627E",
  findPrevious: "\u4E0A\u4E00\u4E2A\u5339\u914D\uFF08Shift+Enter\uFF09",
  findNext: "\u4E0B\u4E00\u4E2A\u5339\u914D\uFF08Enter\uFF09",
  findClose: "\u5173\u95ED\uFF08Esc\uFF09",
  findCaseSensitive: "\u533A\u5206\u5927\u5C0F\u5199",
  noResults: "\u65E0\u7ED3\u679C",
  partialCoverage: "\u4EC5\u5DF2\u52A0\u8F7D",
  partialCoverageHint: "\u6587\u4EF6\u8FD8\u6709\u672A\u52A0\u8F7D\u7684\u90E8\u5206\uFF0C\u641C\u7D22\u7ED3\u679C\u53EA\u8986\u76D6\u5DF2\u52A0\u8F7D\u7684\u5185\u5BB9\u3002"
};
function t(key) {
  const lang = typeof document === "undefined" ? "en" : document.documentElement.lang;
  const dictionary = lang.toLowerCase().startsWith("zh") ? zh : en;
  return dictionary[key];
}

// src/client/preview/Augmentations.tsx
function readCwd(ctx, sessionId) {
  const sessions = ctx?.get("sessions");
  return sessions?.list?.getSnapshot().byId[sessionId]?.cwd;
}
function relativeTo(cwd, path) {
  if (cwd === void 0 || cwd === "") return path;
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/u, "");
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}
function isInFindBar(node) {
  if (node === null || node === void 0) return false;
  const element = node.nodeType === 1 ? node : node.parentElement;
  return element?.closest("[data-preview-find]") != null;
}
var EDGE_MARGIN = 60;
var BUTTON_RISE = 30;
var CASE_SENSITIVE_KEY = "dsh-quick-open:find-case-sensitive";
function readCaseSensitive() {
  try {
    return window.localStorage.getItem(CASE_SENSITIVE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCaseSensitive(value) {
  try {
    window.localStorage.setItem(CASE_SENSITIVE_KEY, value ? "1" : "0");
  } catch {
  }
}
function PreviewAugmentations(props) {
  const { ctx, isQuickOpenOpen } = props;
  const [findOpen, setFindOpen] = (0, import_react3.useState)(false);
  const [query, setQuery] = (0, import_react3.useState)("");
  const [matchTotal, setMatchTotal] = (0, import_react3.useState)(0);
  const [current, setCurrent] = (0, import_react3.useState)(0);
  const [barPos, setBarPos] = (0, import_react3.useState)(null);
  const [partial, setPartial] = (0, import_react3.useState)(false);
  const [caseSensitive, setCaseSensitiveState] = (0, import_react3.useState)(() => readCaseSensitive());
  const [pending, setPending] = (0, import_react3.useState)(null);
  const [notice, setNotice] = (0, import_react3.useState)(null);
  const targetRef = (0, import_react3.useRef)(null);
  const searchRef = (0, import_react3.useRef)({ pieces: [], spans: [] });
  const rangesRef = (0, import_react3.useRef)([]);
  const findOpenRef = (0, import_react3.useRef)(false);
  const queryRef = (0, import_react3.useRef)("");
  const currentRef = (0, import_react3.useRef)(0);
  const pendingRef = (0, import_react3.useRef)(null);
  const popupRangeRef = (0, import_react3.useRef)(null);
  const inputRef = (0, import_react3.useRef)(null);
  const popupButtonRef = (0, import_react3.useRef)(null);
  const caseSensitiveRef = (0, import_react3.useRef)(caseSensitive);
  const touchedRootRef = (0, import_react3.useRef)(null);
  const noticeTimerRef = (0, import_react3.useRef)(void 0);
  findOpenRef.current = findOpen;
  queryRef.current = query;
  currentRef.current = current;
  pendingRef.current = pending;
  caseSensitiveRef.current = caseSensitive;
  const setCaseSensitive = (0, import_react3.useCallback)((next) => {
    writeCaseSensitive(next);
    caseSensitiveRef.current = next;
    setCaseSensitiveState(next);
  }, []);
  const [selectionFormat, setSelectionFormat] = (0, import_react3.useState)(() => readSelectionFormat());
  (0, import_react3.useEffect)(() => {
    const onStorage = (event) => {
      if (event.key === SELECTION_FORMAT_KEY) setSelectionFormat(readSelectionFormat());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const formatRef = (0, import_react3.useRef)(selectionFormat);
  formatRef.current = selectionFormat;
  const hidePopup = (0, import_react3.useCallback)(() => {
    popupRangeRef.current = null;
    if (pendingRef.current === null) return;
    pendingRef.current = null;
    setPending(null);
  }, []);
  const closeFind = (0, import_react3.useCallback)(() => {
    targetRef.current = null;
    searchRef.current = { pieces: [], spans: [] };
    rangesRef.current = [];
    clearMatches();
    findOpenRef.current = false;
    setFindOpen(false);
    setMatchTotal(0);
    setCurrent(0);
    currentRef.current = 0;
    setBarPos(null);
    setPartial(false);
  }, []);
  const runSearch = (0, import_react3.useCallback)(() => {
    const target = targetRef.current;
    if (target === null || !document.contains(target.root)) return;
    const pieces = collectTextPieces(target.root);
    const spans = matchSpans(pieces, queryRef.current, caseSensitiveRef.current);
    searchRef.current = { pieces, spans };
    const clamped = spans.length === 0 ? 0 : Math.min(currentRef.current, spans.length - 1);
    currentRef.current = clamped;
    setCurrent(clamped);
    setMatchTotal(spans.length);
    setPartial(target.root.querySelector("[data-textpreview-more]") !== null);
    rangesRef.current = paintMatches(pieces, spans, clamped);
  }, []);
  const stepMatch = (0, import_react3.useCallback)((delta) => {
    const { pieces, spans } = searchRef.current;
    if (spans.length === 0) return;
    const next = (currentRef.current + delta + spans.length) % spans.length;
    currentRef.current = next;
    setCurrent(next);
    rangesRef.current = paintMatches(pieces, spans, next);
    const range = rangesRef.current[next];
    if (range !== void 0) revealMatch(range);
  }, []);
  const pickTarget = (0, import_react3.useCallback)(() => {
    const visible = visiblePreviews();
    if (visible.length === 0) return null;
    const focused = visible.find((target) => target.root.contains(document.activeElement));
    if (focused !== void 0) return focused;
    const touched = touchedRootRef.current;
    if (touched !== null) {
      const hit = visible.find((target) => target.root === touched);
      if (hit !== void 0) return hit;
    }
    return visible[0] ?? null;
  }, []);
  (0, import_react3.useEffect)(() => {
    const onKey = (event) => {
      if (event.key === "Escape") {
        if (!findOpenRef.current) return;
        if (isImeComposition(event)) return;
        if (isQuickOpenOpen?.() === true) return;
        const target2 = targetRef.current;
        const inBar = isInFindBar(document.activeElement);
        const engaged = touchedRootRef.current !== null && target2 !== null && touchedRootRef.current === target2.root;
        if (!inBar && !engaged) return;
        event.preventDefault();
        event.stopPropagation();
        closeFind();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key !== "f" && event.key !== "F") return;
      const target = findOpenRef.current ? targetRef.current : pickTarget();
      if (target === null || !isVisible(target.root)) return;
      event.preventDefault();
      event.stopPropagation();
      if (findOpenRef.current) {
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      targetRef.current = target;
      findOpenRef.current = true;
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed && selection.anchorNode !== null && previewRootOf(selection.anchorNode) === target.root) {
        const selected = selection.toString();
        if (selected.trim() !== "" && !selected.includes("\n") && selected.length <= 200) {
          queryRef.current = selected;
          setQuery(selected);
        }
      }
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pickTarget, closeFind, isQuickOpenOpen]);
  const bindInput = (0, import_react3.useCallback)((element) => {
    inputRef.current = element;
    if (element !== null) {
      element.focus();
      element.select();
    }
  }, []);
  (0, import_react3.useEffect)(() => {
    if (!findOpen) return;
    runSearch();
  }, [findOpen, query, caseSensitive, runSearch]);
  (0, import_react3.useEffect)(() => {
    if (!findOpen) return void 0;
    const target = targetRef.current;
    if (target === null) return void 0;
    let timer;
    const observer = new MutationObserver(() => {
      if (timer !== void 0) window.clearTimeout(timer);
      timer = window.setTimeout(runSearch, 200);
    });
    observer.observe(target.root, { childList: true, subtree: true, characterData: true });
    return () => {
      if (timer !== void 0) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [findOpen, runSearch]);
  (0, import_react3.useEffect)(() => {
    if (!findOpen) return void 0;
    let frame = 0;
    let last = "";
    const track = () => {
      frame = window.requestAnimationFrame(track);
      const target = targetRef.current;
      if (target === null || !document.contains(target.root) || !isVisible(target.root)) {
        closeFind();
        return;
      }
      const rect = target.root.getBoundingClientRect();
      const next = `${Math.round(rect.right)}:${Math.round(rect.top)}`;
      if (next !== last) {
        last = next;
        setBarPos({ left: Math.max(rect.right - 320, EDGE_MARGIN), top: rect.top + 8 });
      }
    };
    frame = window.requestAnimationFrame(track);
    return () => window.cancelAnimationFrame(frame);
  }, [findOpen, closeFind]);
  (0, import_react3.useEffect)(() => {
    let frame = 0;
    const sync = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const selection = document.getSelection();
        if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
          hidePopup();
          return;
        }
        const selected = selection.toString();
        if (selected.trim() === "") {
          hidePopup();
          return;
        }
        const root = previewRootOf(selection.anchorNode);
        if (root === null || !root.contains(selection.focusNode) || !isVisible(root)) {
          hidePopup();
          return;
        }
        const address = addressOfRoot(root);
        if (address === void 0) {
          hidePopup();
          return;
        }
        const anchorLine = selection.anchorNode === null ? void 0 : lineOfNode(root, selection.anchorNode);
        const focusLine = selection.focusNode === null ? void 0 : lineOfNode(root, selection.focusNode);
        const lines = anchorLine !== void 0 && focusLine !== void 0 ? { start: Math.min(anchorLine, focusLine), end: Math.max(anchorLine, focusLine) } : void 0;
        const text = buildSelectionText({
          relativePath: relativeTo(readCwd(ctx, address.sessionId), address.path),
          lines,
          selected,
          format: formatRef.current
        });
        if (text === void 0) {
          hidePopup();
          return;
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          hidePopup();
          return;
        }
        popupRangeRef.current = selection.getRangeAt(0).cloneRange();
        const above = rect.top - BUTTON_RISE >= 0;
        const next = {
          text,
          left: Math.min(Math.max(rect.left, EDGE_MARGIN), window.innerWidth - EDGE_MARGIN),
          top: above ? rect.top - BUTTON_RISE : rect.bottom + 6
        };
        pendingRef.current = next;
        setPending(next);
      });
    };
    document.addEventListener("selectionchange", sync);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", sync);
    };
  }, [ctx, hidePopup]);
  (0, import_react3.useEffect)(() => {
    const onPointerDown = (event) => {
      touchedRootRef.current = previewRootOf(event.target);
      const button = popupButtonRef.current;
      if (pendingRef.current === null) return;
      if (button !== null && (button === event.target || button.contains(event.target))) return;
      hidePopup();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [hidePopup]);
  (0, import_react3.useEffect)(() => {
    if (pending === null) return void 0;
    let frame = 0;
    const remeasure = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const range = popupRangeRef.current;
        const current2 = pendingRef.current;
        if (range === null || current2 === null) return;
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          hidePopup();
          return;
        }
        const above = rect.top - BUTTON_RISE >= 0;
        const next = {
          text: current2.text,
          left: Math.min(Math.max(rect.left, EDGE_MARGIN), window.innerWidth - EDGE_MARGIN),
          top: above ? rect.top - BUTTON_RISE : rect.bottom + 6
        };
        pendingRef.current = next;
        setPending(next);
      });
    };
    document.addEventListener("scroll", remeasure, true);
    window.addEventListener("resize", remeasure);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", remeasure, true);
      window.removeEventListener("resize", remeasure);
    };
  }, [pending, hidePopup]);
  (0, import_react3.useEffect)(() => () => clearMatches(), []);
  const commitSelection = (0, import_react3.useCallback)(() => {
    const currentPending = pendingRef.current;
    if (currentPending === null) return;
    const root = popupRangeRef.current === null ? null : previewRootOf(popupRangeRef.current.startContainer);
    hidePopup();
    const address = root === null ? void 0 : addressOfRoot(root);
    if (address === void 0) {
      flash(t("noConversation"));
      return;
    }
    flash(appendToDraft(ctx, address.sessionId, currentPending.text) ? t("added") : t("noConversation"));
  }, [ctx, hidePopup]);
  const flash = (message) => {
    if (noticeTimerRef.current !== void 0) window.clearTimeout(noticeTimerRef.current);
    setNotice({ text: message, left: window.innerWidth / 2, top: window.innerHeight - 96 });
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 1600);
  };
  const onInputKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      stepMatch(event.shiftKey ? -1 : 1);
    }
  };
  const countLabel = query === "" ? "" : matchTotal === 0 ? t("noResults") : `${current + 1}/${matchTotal}${matchTotal >= MATCH_LIMIT ? "+" : ""}`;
  return (0, import_react4.createElement)(
    import_react4.Fragment,
    null,
    findOpen && barPos !== null && (0, import_react_dom2.createPortal)(
      (0, import_react4.createElement)(
        "div",
        {
          className: previewCss.find,
          "data-preview-find": "true",
          style: { left: barPos.left, top: barPos.top }
        },
        (0, import_react4.createElement)("input", {
          ref: bindInput,
          value: query,
          placeholder: t("findPlaceholder"),
          "data-preview-find-input": "true",
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: onInputKeyDown
        }),
        (0, import_react4.createElement)("span", {
          className: previewCss.findCount,
          "data-empty": matchTotal === 0 ? "true" : "false"
        }, countLabel),
        partial && query !== "" && (0, import_react4.createElement)("span", {
          className: previewCss.findPartial,
          title: t("partialCoverageHint"),
          "data-preview-find-partial": "true"
        }, t("partialCoverage")),
        (0, import_react4.createElement)("button", {
          type: "button",
          className: previewCss.findButton,
          "data-preview-find-case": "true",
          "aria-pressed": caseSensitive,
          title: t("findCaseSensitive"),
          onClick: () => setCaseSensitive(!caseSensitiveRef.current)
        }, "Aa"),
        (0, import_react4.createElement)("button", {
          type: "button",
          className: previewCss.findButton,
          title: t("findPrevious"),
          disabled: matchTotal === 0,
          onClick: () => stepMatch(-1)
        }, "\u2191"),
        (0, import_react4.createElement)("button", {
          type: "button",
          className: previewCss.findButton,
          title: t("findNext"),
          disabled: matchTotal === 0,
          onClick: () => stepMatch(1)
        }, "\u2193"),
        (0, import_react4.createElement)("button", {
          type: "button",
          className: previewCss.findButton,
          title: t("findClose"),
          onClick: closeFind
        }, "\xD7")
      ),
      document.body
    ),
    pending !== null && (0, import_react_dom2.createPortal)(
      (0, import_react4.createElement)("button", {
        ref: popupButtonRef,
        type: "button",
        className: previewCss.selection,
        "data-preview-selection-popup": "true",
        style: { left: pending.left, top: pending.top },
        // Keep the selection alive until the click lands — this press would
        // otherwise clear the selection and the button would unmount before
        // the click arrives.
        onMouseDown: (event) => event.preventDefault(),
        onClick: commitSelection
      }, t("addSelection")),
      document.body
    ),
    notice !== null && (0, import_react_dom2.createPortal)(
      (0, import_react4.createElement)("span", {
        className: previewCss.notice,
        "data-preview-notice": "true",
        style: { left: notice.left, top: notice.top, transform: "translateX(-50%)" }
      }, notice.text),
      document.body
    )
  );
}

// src/client/preview/index.ts
function registerPreviewAugmentations(ctx, isQuickOpenOpen) {
  ensurePreviewStyles();
  ctx.effect(() => {
    if (typeof document === "undefined") return void 0;
    const host = document.createElement("div");
    host.dataset.quickOpenPreview = "true";
    document.body.appendChild(host);
    let root = null;
    try {
      root = (0, import_client.createRoot)(host);
      root.render((0, import_react5.createElement)(PreviewAugmentations, { ctx, isQuickOpenOpen }));
    } catch (error) {
      console.warn("[dsh-quick-open] preview augmentations failed to mount:", error);
      host.remove();
      return void 0;
    }
    return () => {
      root?.unmount();
      host.remove();
    };
  }, "dsh-quick-open: preview augmentations");
}

// src/client/index.tsx
var inject = ["slots", "sessions"];
function apply(ctx) {
  const store = createQuickOpenStore();
  const controller = createQuickOpenController(ctx, store);
  registerPreviewAugmentations(ctx, () => controller.store.getSnapshot().open);
  ctx.effect(() => {
    const onKey = (event) => {
      if (isImeComposition(event)) return;
      if (!matchesShortcut(readShortcut(), event)) return;
      if (!controller.canServe()) return;
      event.preventDefault();
      event.stopPropagation();
      controller.toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, "dsh-quick-open: global quick-open listener");
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
      () => (0, import_react6.createElement)(QuickOpenLayer, { controller })
    )
  );
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      quickOpenSettingsSection,
      () => (0, import_react6.createElement)(QuickOpenSettings, { ctx })
    )
  );
}
		return module.exports;
	}
});

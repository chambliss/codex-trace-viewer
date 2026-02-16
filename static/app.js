const CATEGORY_ORDER = [
  "message",
  "tool_call",
  "tool_result",
  "reasoning",
  "token",
  "context",
  "compaction",
  "system",
];

const CATEGORY_LABEL = {
  message: "Message",
  tool_call: "Tool Call",
  tool_result: "Tool Result",
  reasoning: "Reasoning",
  token: "Token",
  context: "Context",
  compaction: "Compaction",
  system: "System",
};

const COLLAPSED_GROUPS_STORAGE_KEY = "trace_viewer_collapsed_projects_v1";
const TIMELINE_MODE_STORAGE_KEY = "trace_viewer_timeline_mode_v1";
const TIMELINE_MODES = ["semantic", "raw"];
const ANALYTICS_SCOPE_STORAGE_KEY = "trace_viewer_tool_analytics_scope_v1";
const ANALYTICS_SCOPES = ["global", "thread"];
const BASELINE_YEAR_NO_SUFFIX = 2026;

const state = {
  conversations: [],
  activeConversationId: null,
  activeConversationData: null,
  selectedEventIndex: null,
  selectedTimelineEntryId: null,
  timelineEntries: [],
  timelineMode: loadTimelineMode(),
  analyticsScope: loadAnalyticsScope(),
  globalToolAnalytics: null,
  rawJsonExpanded: false,
  activeFilters: new Set(CATEGORY_ORDER),
  collapsedConversationGroups: loadCollapsedConversationGroups(),
  detailCache: new Map(),
};

const refs = {
  conversationSearch: document.getElementById("conversation-search"),
  showArchived: document.getElementById("show-archived"),
  refreshButton: document.getElementById("refresh-button"),
  conversationCount: document.getElementById("conversation-count"),
  conversationList: document.getElementById("conversation-list"),
  conversationTitle: document.getElementById("conversation-title"),
  conversationMeta: document.getElementById("conversation-meta"),
  conversationStatsInline: document.getElementById("conversation-stats-inline"),
  conversationChips: document.getElementById("conversation-chips"),
  tokenChart: document.getElementById("token-chart"),
  tokenInsights: document.getElementById("token-insights"),
  analyticsScopeToggle: document.getElementById("analytics-scope-toggle"),
  analyticsSummary: document.getElementById("analytics-summary"),
  analyticsGrid: document.getElementById("analytics-grid"),
  timelineModeToggle: document.getElementById("timeline-mode-toggle"),
  eventFilterRow: document.getElementById("event-filter-row"),
  eventList: document.getElementById("event-list"),
  detailMeta: document.getElementById("detail-meta"),
  detailRendered: document.getElementById("detail-rendered"),
  detailRaw: document.getElementById("detail-raw"),
  toggleRawJson: document.getElementById("toggle-raw-json"),
  loadFullJson: document.getElementById("load-full-json"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function syntaxHighlightJsonText(text) {
  const tokenRegex =
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g;

  let cursor = 0;
  let html = "";
  for (const match of text.matchAll(tokenRegex)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      html += escapeHtml(text.slice(cursor, start));
    }

    let cls = "json-number";
    if (/^"/.test(token)) {
      cls = /:$/.test(token) ? "json-key" : "json-string";
    } else if (/^(true|false)$/i.test(token)) {
      cls = "json-boolean";
    } else if (/^null$/i.test(token)) {
      cls = "json-null";
    }

    html += `<span class="${cls}">${escapeHtml(token)}</span>`;
    cursor = start + token.length;
  }

  if (cursor < text.length) {
    html += escapeHtml(text.slice(cursor));
  }
  return html;
}

function toJsonText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderJsonCode(value) {
  return `<code class="json-code">${syntaxHighlightJsonText(toJsonText(value))}</code>`;
}

function setRawJsonPayload(value) {
  if (value === undefined || value === null || value === "") {
    refs.detailRaw.innerHTML = "";
    refs.toggleRawJson.hidden = true;
    refs.detailRaw.classList.add("collapsed");
    return;
  }
  refs.detailRaw.innerHTML = renderJsonCode(value);
  refs.toggleRawJson.hidden = false;
}

function syncRawPaneVisibility() {
  const hasContent = Boolean(refs.detailRaw.innerHTML.trim());
  refs.toggleRawJson.hidden = !hasContent;
  refs.detailRaw.classList.toggle("collapsed", !hasContent || !state.rawJsonExpanded);
  if (hasContent) {
    refs.toggleRawJson.textContent = state.rawJsonExpanded ? "Hide Raw JSON" : "Show Raw JSON";
  }
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return Number(value).toLocaleString();
}

function formatDateTime(value) {
  if (!value) return "-";
  if (typeof Temporal !== "undefined" && Temporal.Instant) {
    try {
      const instant = Temporal.Instant.from(value);
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const zdt = instant.toZonedDateTimeISO(zone);
      const options = {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      };
      if (zdt.year < BASELINE_YEAR_NO_SUFFIX) {
        options.year = "numeric";
      }
      return zdt.toLocaleString("en-US", options);
    } catch {
      // Fallback to Date parsing below.
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  if (date.getFullYear() < BASELINE_YEAR_NO_SUFFIX) {
    options.year = "numeric";
  }
  return new Intl.DateTimeFormat("en-US", options).format(date);
}

function formatTimeOnly(value) {
  if (!value) return "-";
  if (typeof Temporal !== "undefined" && Temporal.Instant) {
    try {
      const instant = Temporal.Instant.from(value);
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const zdt = instant.toZonedDateTimeISO(zone);
      return zdt.toLocaleString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      // Fallback to Date parsing below.
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return `${Number(value).toFixed(1)}%`;
}

function shortText(value, limit = 120) {
  if (!value) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function normalizeCompareText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRedundantPreview(title, preview) {
  const a = normalizeCompareText(title);
  const b = normalizeCompareText(preview);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function projectGroupLabel(cwd) {
  if (!cwd) return "unknown";
  const normalized = String(cwd).replaceAll("\\", "/");

  const worktreeMatch = normalized.match(/\/\.codex\/worktrees\/[^/]+\/([^/]+)/);
  if (worktreeMatch?.[1]) {
    return worktreeMatch[1];
  }

  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length) return normalized;

  const projectsIndex = segments.findIndex((segment) => segment.toLowerCase() === "projects");
  if (projectsIndex >= 0 && segments[projectsIndex + 1]) {
    return segments[projectsIndex + 1];
  }

  return segments[segments.length - 1];
}

function loadCollapsedConversationGroups() {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item) => typeof item === "string" && item));
  } catch {
    return new Set();
  }
}

function persistCollapsedConversationGroups() {
  try {
    localStorage.setItem(
      COLLAPSED_GROUPS_STORAGE_KEY,
      JSON.stringify(Array.from(state.collapsedConversationGroups.values()))
    );
  } catch {
    // ignore persistence failures
  }
}

function loadTimelineMode() {
  try {
    const raw = localStorage.getItem(TIMELINE_MODE_STORAGE_KEY);
    if (!raw) return "semantic";
    return TIMELINE_MODES.includes(raw) ? raw : "semantic";
  } catch {
    return "semantic";
  }
}

function persistTimelineMode() {
  try {
    localStorage.setItem(TIMELINE_MODE_STORAGE_KEY, state.timelineMode);
  } catch {
    // ignore persistence failures
  }
}

function renderTimelineModeToggle() {
  refs.timelineModeToggle.innerHTML = TIMELINE_MODES.map(
    (mode) => `
      <button
        type="button"
        class="timeline-mode-button${state.timelineMode === mode ? " active" : ""}"
        data-timeline-mode="${mode}"
        aria-pressed="${state.timelineMode === mode ? "true" : "false"}"
      >
        ${escapeHtml(mode)}
      </button>
    `
  ).join("");
}

function loadAnalyticsScope() {
  try {
    const raw = localStorage.getItem(ANALYTICS_SCOPE_STORAGE_KEY);
    if (!raw) return "global";
    return ANALYTICS_SCOPES.includes(raw) ? raw : "global";
  } catch {
    return "global";
  }
}

function persistAnalyticsScope() {
  try {
    localStorage.setItem(ANALYTICS_SCOPE_STORAGE_KEY, state.analyticsScope);
  } catch {
    // ignore persistence failures
  }
}

function renderAnalyticsScopeToggle() {
  refs.analyticsScopeToggle.innerHTML = ANALYTICS_SCOPES.map((scope) => {
    const label = scope === "thread" ? "This conversation" : "All conversations";
    return `
      <button
        type="button"
        class="timeline-mode-button${state.analyticsScope === scope ? " active" : ""}"
        data-analytics-scope="${scope}"
        aria-pressed="${state.analyticsScope === scope ? "true" : "false"}"
      >
        ${escapeHtml(label)}
      </button>
    `;
  }).join("");
}

function humanizeConversationOrigin(conversation) {
  const source = conversation?.source;
  const sourceText = typeof source === "string" ? source.trim() : "";
  const sourceLower = sourceText.toLowerCase();

  const originatorText = typeof conversation?.originator === "string" ? conversation.originator.trim() : "";
  const originatorLower = originatorText.toLowerCase();

  if (originatorLower.includes("codex desktop")) return "codex app";
  if (originatorLower === "codex_cli_rs" || originatorLower.includes("codex cli")) return "codex cli";
  if (originatorLower === "codex_vscode") return "vscode extension";
  if (originatorLower === "codex_exec") return "exec automation";

  if (sourceLower === "cli") return "codex cli";
  if (sourceLower === "exec") return "exec automation";
  if (sourceLower === "vscode") return "vscode";

  if (originatorText) return originatorText;
  if (sourceText) return sourceText;
  return null;
}

function classifyConversationOrigin(conversation) {
  const source = conversation?.source;
  if (
    source &&
    typeof source === "object" &&
    source.subagent &&
    source.subagent.thread_spawn &&
    typeof source.subagent.thread_spawn === "object"
  ) {
    const spawn = source.subagent.thread_spawn;
    const depth = Number(spawn.depth || 0);
    const parentId = typeof spawn.parent_thread_id === "string" ? shortText(spawn.parent_thread_id, 10) : null;
    const details = [
      depth > 0 ? `depth ${depth}` : null,
      parentId ? `parent ${parentId}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    return { kind: "subagent", label: "subagent", detail: details };
  }

  const combined = `${conversation?.title || ""} ${conversation?.preview || ""}`.toLowerCase();
  if (
    combined.startsWith("automation:") ||
    combined.includes("automation id:") ||
    (typeof source === "string" && source.toLowerCase().includes("automation"))
  ) {
    return { kind: "automation", label: "automation", detail: typeof source === "string" ? source : null };
  }

  return { kind: "user", label: "user", detail: humanizeConversationOrigin(conversation) };
}

function getConversationFromQuery() {
  const search = new URLSearchParams(window.location.search);
  const value = search.get("conversation");
  return value || null;
}

function setConversationQuery(conversationId) {
  const url = new URL(window.location.href);
  url.searchParams.set("conversation", conversationId);
  window.history.replaceState({}, "", url);
}

function buildFilterPills() {
  refs.eventFilterRow.innerHTML = "";

  const actions = document.createElement("div");
  actions.className = "filter-actions";
  actions.innerHTML = `
    <button type="button" class="filter-action" data-filter-action="all">all</button>
    <button type="button" class="filter-action" data-filter-action="none">none</button>
  `;
  refs.eventFilterRow.appendChild(actions);

  CATEGORY_ORDER.forEach((category) => {
    const label = document.createElement("label");
    label.className = "filter-pill";
    label.innerHTML = `
      <input type="checkbox" data-category="${category}" checked />
      <span class="filter-pill-label">${escapeHtml(CATEGORY_LABEL[category])}</span>
      <button type="button" class="filter-only" data-only-category="${category}" title="Only ${escapeHtml(
      CATEGORY_LABEL[category]
    )}">only</button>
    `;
    refs.eventFilterRow.appendChild(label);
  });

  syncFilterInputsFromState();
}

function syncFilterInputsFromState() {
  refs.eventFilterRow.querySelectorAll("input[data-category]").forEach((input) => {
    const category = input.getAttribute("data-category");
    input.checked = Boolean(category && state.activeFilters.has(category));
  });
}

function bindEventHandlers() {
  buildFilterPills();
  renderTimelineModeToggle();
  renderAnalyticsScopeToggle();

  refs.refreshButton.addEventListener("click", async () => {
    await bootstrap(true);
  });

  refs.conversationSearch.addEventListener("input", () => {
    renderConversationList();
  });

  refs.showArchived.addEventListener("change", async () => {
    await bootstrap(true);
  });

  refs.eventFilterRow.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-category]");
    if (!input) return;
    const category = input.getAttribute("data-category");
    if (!category) return;

    if (input.checked) {
      state.activeFilters.add(category);
    } else {
      state.activeFilters.delete(category);
    }

    renderEventList();
  });

  refs.eventFilterRow.addEventListener("click", (event) => {
    const onlyButton = event.target.closest("button[data-only-category]");
    if (onlyButton) {
      event.preventDefault();
      event.stopPropagation();
      const category = onlyButton.getAttribute("data-only-category");
      if (!category) return;
      state.activeFilters.clear();
      state.activeFilters.add(category);
      syncFilterInputsFromState();
      renderEventList();
      return;
    }

    const actionButton = event.target.closest("button[data-filter-action]");
    if (actionButton) {
      event.preventDefault();
      const action = actionButton.getAttribute("data-filter-action");
      if (action === "none") {
        state.activeFilters.clear();
      } else if (action === "all") {
        CATEGORY_ORDER.forEach((category) => state.activeFilters.add(category));
      }
      syncFilterInputsFromState();
      renderEventList();
    }
  });

  refs.timelineModeToggle.addEventListener("click", (event) => {
    const modeButton = event.target.closest("button[data-timeline-mode]");
    if (!modeButton) return;
    const mode = modeButton.getAttribute("data-timeline-mode");
    if (!mode || !TIMELINE_MODES.includes(mode) || mode === state.timelineMode) return;
    state.timelineMode = mode;
    persistTimelineMode();
    renderTimelineModeToggle();
    renderEventList();
  });

  refs.analyticsScopeToggle.addEventListener("click", (event) => {
    const scopeButton = event.target.closest("button[data-analytics-scope]");
    if (!scopeButton) return;
    const scope = scopeButton.getAttribute("data-analytics-scope");
    if (!scope || !ANALYTICS_SCOPES.includes(scope) || scope === state.analyticsScope) return;
    state.analyticsScope = scope;
    persistAnalyticsScope();
    renderAnalyticsScopeToggle();
    renderToolAnalyticsPanel();
  });

  refs.eventList.addEventListener("click", async (event) => {
    const row = event.target.closest(".event-row");
    if (!row) return;
    const entryId = row.dataset.entryId;
    if (!entryId) return;
    const entry = state.timelineEntries.find((item) => item.id === entryId);
    if (!entry) return;
    await selectTimelineEntry(entry, false);
  });

  refs.loadFullJson.addEventListener("click", async () => {
    const selectedEntry = state.timelineEntries.find((item) => item.id === state.selectedTimelineEntryId);
    if (!selectedEntry) return;
    await selectTimelineEntry(selectedEntry, true);
  });

  refs.toggleRawJson.addEventListener("click", () => {
    state.rawJsonExpanded = !state.rawJsonExpanded;
    syncRawPaneVisibility();
  });

  window.addEventListener("resize", () => {
    if (state.activeConversationData) {
      renderTokenPanel();
    }
  });
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed ${response.status}: ${text}`);
  }
  return response.json();
}

async function bootstrap(forceReload = false) {
  try {
    const includeArchived = refs.showArchived.checked ? "1" : "0";
    const data = await fetchJson(`/api/bootstrap?include_archived=${includeArchived}`);
    if (forceReload || !state.globalToolAnalytics) {
      try {
        state.globalToolAnalytics = await fetchJson(`/api/tool-analytics?include_archived=${includeArchived}`);
      } catch {
        state.globalToolAnalytics = null;
      }
    }

    state.conversations = data.conversations || [];
    renderConversationList();

    if (!state.conversations.length) {
      state.activeConversationId = null;
      state.activeConversationData = null;
      state.selectedEventIndex = null;
      renderEmptyMain();
      return;
    }

    const requestedConversation = getConversationFromQuery();
    let targetConversationId = requestedConversation;

    if (!targetConversationId || !state.conversations.some((item) => item.id === targetConversationId)) {
      if (
        !forceReload &&
        state.activeConversationId &&
        state.conversations.some((item) => item.id === state.activeConversationId)
      ) {
        targetConversationId = state.activeConversationId;
      } else {
        targetConversationId = data.default_conversation_id || state.conversations[0].id;
      }
    }

    await loadConversation(targetConversationId);
  } catch (error) {
    renderFatalError(error);
  }
}

function renderConversationList() {
  const search = refs.conversationSearch.value.trim().toLowerCase();

  let conversations = [...state.conversations];
  if (search) {
    conversations = conversations.filter((item) => {
      return (
        item.title.toLowerCase().includes(search) ||
        item.preview.toLowerCase().includes(search) ||
        (item.thread_id || "").toLowerCase().includes(search) ||
        (item.cwd || "").toLowerCase().includes(search) ||
        item.path.toLowerCase().includes(search)
      );
    });
  }

  refs.conversationCount.textContent = String(conversations.length);
  refs.conversationList.innerHTML = "";

  if (!conversations.length) {
    refs.conversationList.innerHTML = `<p class="text-muted">No conversations match your filters.</p>`;
    return;
  }

  const groups = new Map();
  conversations.forEach((conversation) => {
    const label = projectGroupLabel(conversation.cwd);
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(conversation);
  });

  const rootFragment = document.createDocumentFragment();
  const forceExpanded = search.length > 0;

  for (const [groupLabel, items] of groups.entries()) {
    const groupNode = document.createElement("section");
    groupNode.className = "conversation-group fade-in";

    const groupCollapsed = !forceExpanded && state.collapsedConversationGroups.has(groupLabel);

    const groupHeader = document.createElement("button");
    groupHeader.type = "button";
    groupHeader.className = "conversation-group-header conversation-group-toggle";
    groupHeader.setAttribute("aria-expanded", groupCollapsed ? "false" : "true");
    groupHeader.innerHTML = `
      <span class="conversation-group-leading">
        <span class="conversation-group-arrow">${groupCollapsed ? "▸" : "▾"}</span>
        <span class="conversation-group-title">${escapeHtml(groupLabel)}</span>
      </span>
      <span class="conversation-group-count">${formatNumber(items.length)}</span>
    `;
    groupHeader.addEventListener("click", () => {
      if (state.collapsedConversationGroups.has(groupLabel)) {
        state.collapsedConversationGroups.delete(groupLabel);
      } else {
        state.collapsedConversationGroups.add(groupLabel);
      }
      persistCollapsedConversationGroups();
      renderConversationList();
    });
    groupNode.appendChild(groupHeader);

    const listNode = document.createElement("div");
    listNode.className = "conversation-group-list";
    if (groupCollapsed) {
      listNode.hidden = true;
    }

    items.forEach((conversation) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `conversation-card${conversation.id === state.activeConversationId ? " active" : ""}`;
      card.dataset.id = conversation.id;

      const previewText = shortText(conversation.preview, 150);
      const shouldShowPreview = previewText && !isRedundantPreview(conversation.title, previewText);

      const metaParts = [
        shortText(conversation.model || "model?", 26),
        formatDateTime(conversation.updated_at || conversation.started_at || ""),
        `${formatNumber(conversation.total_events)} events`,
      ];
      if (conversation.archived) {
        metaParts.push("archived");
      }

      const turns = Number(conversation.turn_count || 0);
      const messages = Number(conversation.message_count || 0);
      const toolCalls = Number(conversation.tool_call_count || 0);
      const toolResults = Number(conversation.tool_result_count || 0);
      const origin = classifyConversationOrigin(conversation);

      card.innerHTML = `
        <p class="conversation-title">${escapeHtml(conversation.title || "Untitled")}</p>
        <p class="conversation-origin">
          <span class="origin-badge origin-${escapeHtml(origin.kind)}">${escapeHtml(origin.label)}</span>
          ${
            origin.detail
              ? `<span class="conversation-origin-detail">${escapeHtml(shortText(origin.detail, 42))}</span>`
              : ""
          }
        </p>
        ${shouldShowPreview ? `<p class="conversation-preview">${escapeHtml(previewText)}</p>` : ""}
        <p class="conversation-metrics">
          <span><strong>turns</strong> ${formatNumber(turns)}</span>
          <span><strong>messages</strong> ${formatNumber(messages)}</span>
          <span><strong>tools</strong> ${formatNumber(toolCalls)} / ${formatNumber(toolResults)}</span>
        </p>
        <p class="conversation-meta">
          ${metaParts
            .map((part) =>
              part === "archived"
                ? `<span class="conversation-archived">archived</span>`
                : `<span>${escapeHtml(part)}</span>`
            )
            .join("")}
        </p>
      `;

      card.addEventListener("click", async () => {
        await loadConversation(conversation.id);
      });

      listNode.appendChild(card);
    });

    groupNode.appendChild(listNode);
    rootFragment.appendChild(groupNode);
  }

  refs.conversationList.appendChild(rootFragment);
}

function renderEmptyMain() {
  state.timelineEntries = [];
  state.selectedTimelineEntryId = null;
  state.selectedEventIndex = null;
  state.rawJsonExpanded = false;
  refs.conversationTitle.textContent = "No conversations found";
  refs.conversationMeta.textContent = "Could not find rollout files in your CODEX_HOME.";
  refs.conversationStatsInline.innerHTML = "";
  refs.conversationChips.innerHTML = "";
  refs.tokenChart.innerHTML = `<p class="chart-empty">No token data available.</p>`;
  refs.tokenInsights.innerHTML = "";
  refs.analyticsSummary.textContent = "No tool analytics available.";
  refs.analyticsGrid.innerHTML = "";
  refs.eventList.innerHTML = `<p class="text-muted">No events to display.</p>`;
  refs.detailMeta.textContent = "";
  refs.detailRendered.innerHTML = `<p class="text-muted">Select an event to inspect details.</p>`;
  refs.detailRaw.innerHTML = "";
  refs.detailRaw.classList.add("collapsed");
  refs.toggleRawJson.hidden = true;
  refs.loadFullJson.hidden = true;
}

async function loadConversation(conversationId) {
  if (!conversationId) return;

  const data = await fetchJson(`/api/conversations/${conversationId}/events`);
  state.activeConversationId = conversationId;
  state.activeConversationData = data;
  state.selectedEventIndex = pickInitialEventIndex();
  state.selectedTimelineEntryId = null;
  state.timelineEntries = [];
  state.detailCache.clear();

  setConversationQuery(conversationId);

  renderConversationList();
  renderConversationHeader();
  renderTokenPanel();
  renderToolAnalyticsPanel();
  renderEventList();

  const initialEvent = state.selectedEventIndex;
  const initialEntry =
    initialEvent !== null
      ? state.timelineEntries.find((entry) => entry.rawIndices.includes(initialEvent))
      : state.timelineEntries[0];

  if (initialEntry) {
    await selectTimelineEntry(initialEntry, false);
  } else {
    refs.detailRendered.innerHTML = `<p class="text-muted">No event detail available.</p>`;
    state.rawJsonExpanded = false;
    refs.detailRaw.innerHTML = "";
    refs.detailRaw.classList.add("collapsed");
    refs.toggleRawJson.hidden = true;
    refs.detailMeta.textContent = "";
    refs.loadFullJson.hidden = true;
  }
}

function pickInitialEventIndex() {
  const events = state.activeConversationData?.events || [];
  if (!events.length) return null;

  const preferred = events.find((item) => item.category === "message" && item.role === "user");
  if (preferred) return preferred.index;

  return events[0].index;
}

function renderConversationHeader() {
  const conversation = state.activeConversationData?.conversation;
  if (!conversation) {
    renderEmptyMain();
    return;
  }

  refs.conversationTitle.textContent = conversation.title || "Untitled conversation";
  refs.conversationMeta.textContent = [
    `Started ${formatDateTime(conversation.started_at)}`,
    `Updated ${formatDateTime(conversation.updated_at)}`,
    shortText(conversation.path, 62),
  ].join(" | ");

  refs.conversationStatsInline.innerHTML = renderConversationStatsInline(
    state.activeConversationData?.stats,
    conversation
  );

  const chips = [
    conversation.thread_id ? `thread ${conversation.thread_id}` : null,
    conversation.model ? `model ${conversation.model}` : null,
    conversation.model_provider ? `provider ${conversation.model_provider}` : null,
    conversation.cwd ? `cwd ${conversation.cwd}` : null,
    conversation.archived ? "archived" : "active",
  ].filter(Boolean);

  refs.conversationChips.innerHTML = chips
    .map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`)
    .join("");
}

function renderConversationStatsInline(stats, conversation) {
  if (!stats || !conversation) {
    return "";
  }

  const turns = Number(stats.turn_count || conversation.turn_count || 0);
  const compactions = Number(stats.compaction_event_count || 0);
  const peakFill = stats.peak_fill_percent !== null ? `${stats.peak_fill_percent.toFixed(1)}%` : "-";

  const entries = [
    ["events", formatNumber(stats.event_count)],
    ["turns", formatNumber(turns)],
    ["messages", formatNumber(stats.message_count)],
    [
      "tools",
      `${formatNumber(stats.tool_call_count)} calls / ${formatNumber(stats.tool_result_count)} results`,
    ],
    ["compactions", formatNumber(compactions)],
    ["peak context", `${peakFill} (${formatNumber(stats.max_total_tokens)} tokens)`],
  ];

  return entries
    .map(([label, value]) => {
      return `<span class="inline-stat"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`;
    })
    .join("");
}

function renderTokenPanel() {
  const data = state.activeConversationData;
  if (!data) return;

  const tokenSeries = data.token_series || [];
  refs.tokenChart.innerHTML = "";

  if (!tokenSeries.length) {
    refs.tokenChart.innerHTML = `<p class="chart-empty">No token_count events in this conversation.</p>`;
    refs.tokenInsights.innerHTML = "";
    return;
  }

  renderTokenChartSvg(tokenSeries, data.compaction_impacts || []);
  renderTokenInsights(tokenSeries, data.compaction_impacts || []);
}

function renderTokenChartSvg(tokenSeries, compactionImpacts) {
  const width = Math.max(refs.tokenChart.clientWidth - 8, 360);
  const height = 176;
  const pad = { left: 52, right: 16, top: 18, bottom: 34 };

  const maxTotal = Math.max(...tokenSeries.map((item) => Number(item.total_tokens || 0)), 1);
  const maxWindow = Math.max(...tokenSeries.map((item) => Number(item.model_context_window || 0)), 0);
  const yMax = Math.max(maxTotal, maxWindow, 1);

  const x = (idx) => {
    const usable = width - pad.left - pad.right;
    if (tokenSeries.length === 1) return pad.left + usable / 2;
    return pad.left + (idx / (tokenSeries.length - 1)) * usable;
  };

  const y = (value) => {
    const usable = height - pad.top - pad.bottom;
    return pad.top + usable - (Math.max(0, value) / yMax) * usable;
  };

  const totalPath = tokenSeries
    .map((item, idx) => `${idx === 0 ? "M" : "L"}${x(idx)},${y(Number(item.total_tokens || 0))}`)
    .join(" ");

  const windowPath = tokenSeries
    .map((item, idx) => {
      const windowValue = Number(item.model_context_window || 0);
      return `${idx === 0 ? "M" : "L"}${x(idx)},${y(windowValue > 0 ? windowValue : yMax)}`;
    })
    .join(" ");

  const horizontalGrid = [];
  for (let i = 0; i <= 4; i += 1) {
    const fraction = i / 4;
    const gridY = pad.top + (height - pad.top - pad.bottom) * fraction;
    const value = Math.round(yMax * (1 - fraction));
    horizontalGrid.push({ y: gridY, value });
  }

  const compactionLines = compactionImpacts
    .map((impact) => {
      const eventIndex = Number(impact.compaction_event_index);
      let nearest = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      tokenSeries.forEach((point, idx) => {
        const distance = Math.abs(Number(point.event_index || 0) - eventIndex);
        if (distance < nearestDistance) {
          nearest = idx;
          nearestDistance = distance;
        }
      });
      return x(nearest);
    })
    .filter((value, idx, array) => Number.isFinite(value) && array.indexOf(value) === idx);

  const markerStep = Math.max(1, Math.ceil(tokenSeries.length / 18));
  const circles = tokenSeries
    .map((point, idx) => {
      const keep = idx === 0 || idx === tokenSeries.length - 1 || idx % markerStep === 0;
      if (!keep) return "";
      return `<circle cx="${x(idx)}" cy="${y(Number(point.total_tokens || 0))}" r="2.6" fill="var(--token)" />`;
    })
    .join("");

  const firstLabel = formatTimeOnly(tokenSeries[0].timestamp);
  const lastLabel = formatTimeOnly(tokenSeries[tokenSeries.length - 1].timestamp);

  refs.tokenChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Token usage chart">
      <rect x="${pad.left}" y="${pad.top}" width="${width - pad.left - pad.right}" height="${
    height - pad.top - pad.bottom
  }" fill="rgba(11,24,45,0.72)" stroke="rgba(122,163,238,0.26)" rx="10" />

      ${horizontalGrid
        .map(
          (line) => `
            <line x1="${pad.left}" y1="${line.y}" x2="${width - pad.right}" y2="${line.y}" stroke="rgba(120,154,211,0.16)" stroke-width="1" />
            <text x="${pad.left - 8}" y="${line.y + 4}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="rgba(172,198,243,0.86)">${formatNumber(
            line.value
          )}</text>
          `
        )
        .join("")}

      ${compactionLines
        .map(
          (xPos) =>
            `<line x1="${xPos}" y1="${pad.top}" x2="${xPos}" y2="${
              height - pad.bottom
            }" stroke="rgba(245,158,11,0.52)" stroke-dasharray="4 3" />`
        )
        .join("")}

      <path d="${windowPath}" fill="none" stroke="rgba(24,53,83,0.36)" stroke-width="1.6" stroke-dasharray="6 4" />
      <path d="${totalPath}" fill="none" stroke="var(--token)" stroke-width="2.4" />
      ${circles}

      <text x="${pad.left}" y="${height - 8}" font-family="var(--mono)" font-size="9.5" fill="rgba(172,198,243,0.86)">${escapeHtml(
    firstLabel
  )}</text>
      <text x="${width - pad.right}" y="${height - 8}" text-anchor="end" font-family="var(--mono)" font-size="9.5" fill="rgba(172,198,243,0.86)">${escapeHtml(
    lastLabel
  )}</text>

      <text x="${pad.left}" y="${pad.top - 4}" font-family="var(--mono)" font-size="9.5" fill="rgba(199,217,248,0.88)">Total tokens in context</text>
    </svg>
  `;
}

function renderTokenInsights(tokenSeries, compactionImpacts) {
  const latest = tokenSeries[tokenSeries.length - 1];
  const latestTotal = Number(latest.total_tokens || 0);
  const latestWindow = Number(latest.model_context_window || 0);
  const latestFill = latestWindow > 0 ? (latestTotal / latestWindow) * 100 : null;

  const cached = Number(latest.cached_input_tokens || 0);
  const input = Number(latest.input_tokens || 0);
  const cachedRatio = input > 0 ? (cached / input) * 100 : null;

  const maxTotal = Math.max(...tokenSeries.map((point) => Number(point.total_tokens || 0)), 0);
  const maxWindow = Math.max(...tokenSeries.map((point) => Number(point.model_context_window || 0)), 0);
  const peakFill = maxWindow > 0 ? (maxTotal / maxWindow) * 100 : null;

  const drops = compactionImpacts
    .map((impact) => Number(impact.delta_tokens))
    .filter((delta) => Number.isFinite(delta))
    .filter((delta) => delta < 0);
  const largestDrop = drops.length ? Math.min(...drops) : null;

  const snippets = [
    ["Latest context", `${formatNumber(latestTotal)} (${formatPercent(latestFill)})`],
    ["Peak context", `${formatNumber(maxTotal)} (${formatPercent(peakFill)})`],
    ["Cached input", formatPercent(cachedRatio)],
    [
      "Compactions",
      `${formatNumber(compactionImpacts.length)}${
        largestDrop !== null ? `, largest drop ${formatNumber(largestDrop)}` : ""
      }`,
    ],
  ];

  refs.tokenInsights.innerHTML = snippets
    .map(
      ([label, value]) => `
        <article class="insight-item">
          <span class="insight-label">${escapeHtml(label)}</span>
          <strong class="insight-value">${escapeHtml(value)}</strong>
        </article>
      `
    )
    .join("");
}

function renderAnalyticsTable(title, rows, valueLabel = "count") {
  const safeRows = Array.isArray(rows) ? rows.slice(0, 4) : [];
  const body = safeRows.length
    ? safeRows
        .map(
          (item, idx) => `
            <tr>
              <td class="analytics-rank">${idx + 1}</td>
              <td class="analytics-name" title="${escapeHtml(item.name || "")}">${escapeHtml(shortText(item.name || "-", 44))}</td>
              <td class="analytics-count">${escapeHtml(formatNumber(item.count))}</td>
            </tr>
          `
        )
        .join("")
    : `<tr><td colspan="3" class="analytics-empty">No data</td></tr>`;

  return `
    <article class="analytics-card">
      <h4>${escapeHtml(title)}</h4>
      <table class="analytics-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>${escapeHtml(valueLabel)}</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </article>
  `;
}

function resolveCurrentAnalytics() {
  const threadAnalytics = state.activeConversationData?.tool_analytics || null;
  if (state.analyticsScope === "thread") {
    return threadAnalytics;
  }
  return state.globalToolAnalytics || threadAnalytics;
}

function renderToolAnalyticsPanel() {
  const analytics = resolveCurrentAnalytics();
  if (!analytics) {
    refs.analyticsSummary.textContent = "No tool analytics available yet.";
    refs.analyticsGrid.innerHTML = "";
    return;
  }

  const scopeLabel = state.analyticsScope === "thread" ? "This conversation" : "All conversations";
  const threads = Number(analytics.threads_analyzed || (state.analyticsScope === "thread" ? 1 : 0));
  const toolCalls = Number(analytics.tool_calls_total || 0);
  refs.analyticsSummary.textContent = `${scopeLabel}: ${formatNumber(toolCalls)} tool calls across ${formatNumber(
    threads
  )} ${threads === 1 ? "thread" : "threads"}.`;

  refs.analyticsGrid.innerHTML = [
    renderAnalyticsTable("Top Tools", analytics.top_tools || [], "calls"),
    renderAnalyticsTable("Top Commands", analytics.top_command_roots || [], "runs"),
    renderAnalyticsTable("Top Skills", analytics.top_skills || [], "mentions"),
    renderAnalyticsTable("Top MCP Tools", analytics.top_mcp_tools || [], "calls"),
  ].join("");
}

function getFilteredEvents() {
  const allEvents = state.activeConversationData?.events || [];
  return allEvents.filter((event) => state.activeFilters.has(event.category));
}

function normalizeSemanticText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^user message:\s*/i, "")
    .replace(/^assistant message:\s*/i, "")
    .replace(/^agent message:\s*/i, "")
    .replace(/^agent reasoning:\s*/i, "")
    .replace(/^reasoning:\s*/i, "")
    .replace(/^developer message:\s*/i, "")
    .replace(/^tool result from .*?\(call [^)]+\)\s*/i, "")
    .trim();
}

function pickRicherEvent(events) {
  if (!events.length) return null;
  return [...events].sort((a, b) => {
    const scoreA = String(a.preview || "").length + String(a.summary || "").length;
    const scoreB = String(b.preview || "").length + String(b.summary || "").length;
    return scoreB - scoreA;
  })[0];
}

function formatEventRange(startIndex, endIndex) {
  if (startIndex === endIndex) return `#${startIndex}`;
  return `#${startIndex} - #${endIndex}`;
}

function extractToolNameFromEvent(event) {
  if (!event) return null;
  if (event.tool_name) return event.tool_name;
  const summary = String(event.summary || "");
  const callMatch = summary.match(/Tool call:\s*([^\n]+)$/i);
  if (callMatch?.[1]) return callMatch[1].trim();
  const resultMatch = summary.match(/Tool result from\s+(.+?)\s+\(call/i);
  if (resultMatch?.[1]) return resultMatch[1].trim();
  return null;
}

function areNearDuplicateEvents(a, b) {
  if (!a || !b) return false;
  if (a.category !== b.category) return false;
  if (!["message", "reasoning"].includes(a.category)) return false;
  if (a.turn_id && b.turn_id && a.turn_id !== b.turn_id) return false;

  const textA = normalizeSemanticText(a.preview || a.summary || "");
  const textB = normalizeSemanticText(b.preview || b.summary || "");
  if (!textA || !textB) return false;

  if (textA === textB) return true;
  const shorter = textA.length < textB.length ? textA : textB;
  const longer = textA.length < textB.length ? textB : textA;
  if (shorter.length >= 24 && longer.includes(shorter)) return true;

  return false;
}

function buildRawTimelineEntry(event) {
  return {
    id: `raw:${event.index}`,
    kind: "single",
    category: event.category,
    badgeLabel: CATEGORY_LABEL[event.category] || event.category,
    subtypeLabel: event.subtype || event.top_type || "event",
    summary: event.summary || "",
    preview: event.preview || "",
    timestamp: event.timestamp,
    turn_id: event.turn_id,
    primaryIndex: event.index,
    startIndex: event.index,
    endIndex: event.index,
    rawIndices: [event.index],
    eventCount: 1,
    call_id: event.call_id || null,
    tool_name: extractToolNameFromEvent(event),
  };
}

function buildDuplicateTimelineEntry(events) {
  const representative = pickRicherEvent(events) || events[0];
  const start = events[0].index;
  const end = events[events.length - 1].index;
  const subtypeSet = Array.from(
    new Set(events.map((event) => event.subtype || event.top_type || "event").filter(Boolean))
  );
  return {
    id: `dup:${start}-${end}`,
    kind: "duplicate_group",
    category: representative.category,
    badgeLabel: CATEGORY_LABEL[representative.category] || representative.category,
    subtypeLabel: subtypeSet.join(" + "),
    summary: representative.summary || "",
    preview: representative.preview || "",
    timestamp: representative.timestamp,
    turn_id: representative.turn_id,
    primaryIndex: representative.index,
    startIndex: start,
    endIndex: end,
    rawIndices: events.map((event) => event.index),
    eventCount: events.length,
    mergedLabel: `${events.length} similar events`,
    call_id: representative.call_id || null,
    tool_name: extractToolNameFromEvent(representative),
  };
}

function findMatchingToolResultPosition(events, callPos, consumedPositions) {
  const callEvent = events[callPos];
  const callId = callEvent?.call_id;
  if (!callId) return -1;

  const maxLookahead = 80;
  const upper = Math.min(events.length, callPos + maxLookahead + 1);
  for (let pos = callPos + 1; pos < upper; pos += 1) {
    if (consumedPositions.has(pos)) continue;
    const candidate = events[pos];
    if (candidate.call_id !== callId) continue;
    if (candidate.category === "tool_result") {
      return pos;
    }
  }
  return -1;
}

function buildToolPairTimelineEntry(callEvent, resultEvent) {
  const toolName = extractToolNameFromEvent(callEvent) || extractToolNameFromEvent(resultEvent);
  return {
    id: `pair:${callEvent.index}-${resultEvent.index}`,
    kind: "tool_pair",
    category: "tool_call",
    badgeLabel: "Tool Pair",
    subtypeLabel: `${callEvent.subtype || callEvent.top_type || "tool_call"} + ${
      resultEvent.subtype || resultEvent.top_type || "tool_result"
    }`,
    summary: toolName ? `${toolName}: call + result` : "Tool call + tool result",
    preview: resultEvent.preview || callEvent.preview || "",
    timestamp: callEvent.timestamp || resultEvent.timestamp,
    turn_id: callEvent.turn_id || resultEvent.turn_id,
    primaryIndex: callEvent.index,
    startIndex: callEvent.index,
    endIndex: resultEvent.index,
    rawIndices: [callEvent.index, resultEvent.index],
    eventCount: 2,
    call_id: callEvent.call_id || resultEvent.call_id || null,
    tool_name: toolName,
    pairMeta: {
      callIndex: callEvent.index,
      resultIndex: resultEvent.index,
      callSubtype: callEvent.subtype || callEvent.top_type,
      resultSubtype: resultEvent.subtype || resultEvent.top_type,
    },
  };
}

function buildSemanticTimelineEntries(events) {
  const entries = [];
  const consumedPositions = new Set();

  for (let pos = 0; pos < events.length; pos += 1) {
    if (consumedPositions.has(pos)) continue;
    const event = events[pos];

    if (event.category === "tool_call" && event.call_id) {
      const matchPos = findMatchingToolResultPosition(events, pos, consumedPositions);
      if (matchPos >= 0) {
        consumedPositions.add(matchPos);
        entries.push(buildToolPairTimelineEntry(event, events[matchPos]));
        continue;
      }
    }

    const duplicateRun = [event];
    for (let nextPos = pos + 1; nextPos < events.length; nextPos += 1) {
      if (consumedPositions.has(nextPos)) continue;
      const candidate = events[nextPos];
      if (!areNearDuplicateEvents(duplicateRun[duplicateRun.length - 1], candidate)) {
        break;
      }
      duplicateRun.push(candidate);
      consumedPositions.add(nextPos);
    }

    if (duplicateRun.length > 1) {
      entries.push(buildDuplicateTimelineEntry(duplicateRun));
      continue;
    }

    entries.push(buildRawTimelineEntry(event));
  }

  return entries;
}

function buildTimelineEntries(events) {
  if (state.timelineMode === "raw") {
    return events.map((event) => buildRawTimelineEntry(event));
  }
  return buildSemanticTimelineEntries(events);
}

function resolveSelectedTimelineEntry(entries) {
  if (!entries.length) return null;

  const byId = entries.find((entry) => entry.id === state.selectedTimelineEntryId);
  if (byId) return byId;

  if (state.selectedEventIndex !== null) {
    const byEvent = entries.find((entry) => entry.rawIndices.includes(state.selectedEventIndex));
    if (byEvent) return byEvent;
  }

  return entries[0];
}

function renderEventList() {
  const events = getFilteredEvents();
  const entries = buildTimelineEntries(events);
  state.timelineEntries = entries;
  refs.eventList.innerHTML = "";

  if (!entries.length) {
    refs.eventList.innerHTML = `<p class="text-muted">No events match the active timeline filters.</p>`;
    return;
  }

  const selectedEntry = resolveSelectedTimelineEntry(entries);
  if (!selectedEntry) {
    refs.eventList.innerHTML = `<p class="text-muted">No event timeline entries available.</p>`;
    return;
  }

  const previousSelectedEntryId = state.selectedTimelineEntryId;
  state.selectedTimelineEntryId = selectedEntry.id;
  state.selectedEventIndex = selectedEntry.primaryIndex;

  const fragment = document.createDocumentFragment();

  entries.forEach((entry) => {
    const row = document.createElement("article");
    row.className = `event-row category-${entry.category}${
      entry.id === state.selectedTimelineEntryId ? " selected" : ""
    }`;
    row.dataset.entryId = entry.id;

    const metaBits = [
      `<span class="badge ${entry.category}">${escapeHtml(entry.badgeLabel || entry.category)}</span>`,
      `<span>${escapeHtml(entry.subtypeLabel || "event")}</span>`,
      `<span>${escapeHtml(formatTimeOnly(entry.timestamp))}</span>`,
      entry.turn_id ? `<span>turn ${escapeHtml(shortText(entry.turn_id, 12))}</span>` : "",
      entry.kind === "duplicate_group" ? `<span>${escapeHtml(entry.mergedLabel || "")}</span>` : "",
      entry.kind === "tool_pair" && entry.call_id ? `<span>call ${escapeHtml(shortText(entry.call_id, 12))}</span>` : "",
    ]
      .filter(Boolean)
      .join("");

    row.innerHTML = `
      <p class="event-idx">${escapeHtml(formatEventRange(entry.startIndex, entry.endIndex))}</p>
      <div>
        <p class="event-meta">${metaBits}</p>
        <p class="event-summary">${escapeHtml(entry.summary || "")}</p>
        ${entry.preview ? `<p class="event-preview">${escapeHtml(entry.preview)}</p>` : ""}
      </div>
    `;

    fragment.appendChild(row);
  });

  refs.eventList.appendChild(fragment);

  const selectedStillVisible = entries.some((entry) => entry.id === state.selectedTimelineEntryId);
  if (!selectedStillVisible) {
    state.selectedTimelineEntryId = entries[0].id;
    state.selectedEventIndex = entries[0].primaryIndex;
    selectTimelineEntry(entries[0], false).catch((error) => {
      refs.detailRendered.innerHTML = `<p class="text-muted">${escapeHtml(error.message)}</p>`;
    });
    return;
  }

  if (previousSelectedEntryId !== null && previousSelectedEntryId !== state.selectedTimelineEntryId) {
    const activeEntry = entries.find((entry) => entry.id === state.selectedTimelineEntryId);
    if (activeEntry) {
      selectTimelineEntry(activeEntry, false).catch((error) => {
        refs.detailRendered.innerHTML = `<p class="text-muted">${escapeHtml(error.message)}</p>`;
      });
    }
  }
}

function getDetailCacheBucket(index) {
  if (!state.detailCache.has(index)) {
    state.detailCache.set(index, { base: null, full: null });
  }
  return state.detailCache.get(index);
}

async function loadEventDetail(index, fullMode) {
  const cacheBucket = getDetailCacheBucket(index);
  if (fullMode && cacheBucket.full) {
    return cacheBucket.full;
  }
  if (!fullMode && cacheBucket.base) {
    return cacheBucket.base;
  }

  const suffix = fullMode ? "?full=1" : "";
  const data = await fetchJson(`/api/conversations/${state.activeConversationId}/events/${index}${suffix}`);

  if (fullMode) {
    cacheBucket.full = data;
  } else {
    cacheBucket.base = data;
  }

  return data;
}

async function loadTimelineEntryDetail(entry, fullMode) {
  if (entry.kind === "tool_pair" && entry.pairMeta) {
    const callIndex = Number(entry.pairMeta.callIndex ?? entry.startIndex);
    const resultIndex = Number(entry.pairMeta.resultIndex ?? entry.endIndex);
    const [callDetail, resultDetail] = await Promise.all([
      loadEventDetail(callIndex, fullMode),
      loadEventDetail(resultIndex, fullMode),
    ]);

    return {
      kind: "tool_pair_detail",
      entry,
      callDetail,
      resultDetail,
    };
  }

  return {
    kind: "single_detail",
    entry,
    detailData: await loadEventDetail(entry.primaryIndex, fullMode),
  };
}

async function selectTimelineEntry(entry, fullMode) {
  state.selectedTimelineEntryId = entry.id;
  state.selectedEventIndex = entry.primaryIndex;
  if (!fullMode) {
    state.rawJsonExpanded = false;
  }
  renderEventList();

  const bundle = await loadTimelineEntryDetail(entry, fullMode);
  renderTimelineEntryDetail(bundle);
}

function renderSemanticDetailNote(entry) {
  if (!entry || state.timelineMode !== "semantic") return "";
  if (entry.kind === "duplicate_group") {
    return `
      <section class="semantic-note">
        <h4>Grouped Events</h4>
        <p>This row combines <strong>${escapeHtml(String(entry.eventCount))}</strong> similar events in raw range <code>${escapeHtml(
          formatEventRange(entry.startIndex, entry.endIndex)
        )}</code>.</p>
      </section>
    `;
  }

  if (entry.kind === "tool_pair") {
    return `
      <section class="semantic-note">
        <h4>Grouped Tool Events</h4>
        <p>Call and result are shown together for readability.</p>
        <p>Raw events: <code>#${escapeHtml(String(entry.pairMeta?.callIndex ?? entry.startIndex))}</code> -> <code>#${escapeHtml(
          String(entry.pairMeta?.resultIndex ?? entry.endIndex)
        )}</code>${entry.call_id ? ` (call_id <code>${escapeHtml(entry.call_id)}</code>)` : ""}.</p>
      </section>
    `;
  }

  return "";
}

function renderSingleEventDetail(detailData, timelineEntry = null) {
  const meta = detailData.event_meta || {};
  const entry = timelineEntry || state.timelineEntries.find((item) => item.id === state.selectedTimelineEntryId);
  const rangeLabel = entry ? formatEventRange(entry.startIndex, entry.endIndex) : `#${detailData.event_index}`;
  refs.detailMeta.textContent = `${rangeLabel} | ${meta.category || "event"} | ${
    meta.timestamp ? formatDateTime(meta.timestamp) : "time?"
  }`;

  refs.detailRendered.innerHTML = `${renderSemanticDetailNote(entry)}${renderStructuredDetail(detailData.detail || {})}`;
  setRawJsonPayload(detailData.raw);
  refs.loadFullJson.hidden = !(detailData.raw_truncated && !detailData.full);
  syncRawPaneVisibility();
}

function renderToolPairDetail(bundle) {
  const { entry, callDetail, resultDetail } = bundle;
  const callMeta = callDetail?.event_meta || {};
  const resultMeta = resultDetail?.event_meta || {};
  const pairTime = callMeta.timestamp || resultMeta.timestamp;
  const callIndex = callDetail?.event_index;
  const resultIndex = resultDetail?.event_index;

  refs.detailMeta.textContent = `${formatEventRange(entry.startIndex, entry.endIndex)} | tool_pair | ${
    pairTime ? formatDateTime(pairTime) : "time?"
  }`;

  refs.detailRendered.innerHTML = `
    <section class="detail-section">
      <h4>Call Event #${escapeHtml(String(callIndex))}</h4>
      ${renderStructuredDetail(callDetail?.detail || {})}
    </section>
    <section class="detail-section">
      <h4>Result Event #${escapeHtml(String(resultIndex))}</h4>
      ${renderStructuredDetail(resultDetail?.detail || {})}
    </section>
  `;

  setRawJsonPayload({
    pair: {
      call_event_index: callIndex,
      result_event_index: resultIndex,
      call_id: entry.call_id || null,
    },
    call_raw: callDetail?.raw,
    result_raw: resultDetail?.raw,
  });

  const callTruncated = Boolean(callDetail?.raw_truncated && !callDetail?.full);
  const resultTruncated = Boolean(resultDetail?.raw_truncated && !resultDetail?.full);
  refs.loadFullJson.hidden = !(callTruncated || resultTruncated);
  syncRawPaneVisibility();
}

function renderTimelineEntryDetail(bundle) {
  if (!bundle) return;
  if (bundle.kind === "tool_pair_detail") {
    renderToolPairDetail(bundle);
    return;
  }
  renderSingleEventDetail(bundle.detailData, bundle.entry);
}

function renderStructuredDetail(detail) {
  if (!detail || !detail.kind) {
    return `<p class="text-muted">No structured renderer for this event.</p>`;
  }

  if (detail.kind === "session_meta") {
    return `
      <section class="detail-section">
        <h4>Session Metadata</h4>
        ${renderKvGrid({
          thread_id: detail.thread_id,
          timestamp: detail.timestamp,
          cwd: detail.cwd,
          originator: detail.originator,
          source: detail.source,
          cli_version: detail.cli_version,
          model_provider: detail.model_provider,
        })}
      </section>
      ${detail.base_instructions ? renderTextBlobSection("Base Instructions", detail.base_instructions) : ""}
    `;
  }

  if (detail.kind === "turn_context") {
    return `
      <section class="detail-section">
        <h4>Turn Context</h4>
        ${renderKvGrid({
          turn_id: detail.turn_id,
          model: detail.model,
          cwd: detail.cwd,
          approval_policy: detail.approval_policy,
          effort: detail.effort,
          summary: detail.summary,
          personality: detail.personality,
          truncation_policy: JSON.stringify(detail.truncation_policy || null),
        })}
      </section>
      ${renderJsonSection("Sandbox Policy", detail.sandbox_policy)}
      ${detail.user_instructions ? renderTextBlobSection("User Instructions", detail.user_instructions) : ""}
      ${detail.developer_instructions ? renderTextBlobSection("Developer Instructions", detail.developer_instructions) : ""}
    `;
  }

  if (detail.kind === "message") {
    const segments = (detail.segments || [])
      .map((segment) => {
        if (segment.kind === "text") {
          return `<div class="detail-blob">${escapeHtml(segment.text || "")}</div>`;
        }
        if (segment.kind === "image") {
          return `<p class="detail-line">Image URL: <code>${escapeHtml(segment.image_url || "")}</code></p>`;
        }
        return `<p class="detail-line">${escapeHtml(JSON.stringify(segment))}</p>`;
      })
      .join("");

    return `
      <section class="detail-section">
        <h4>Message</h4>
        ${renderKvGrid({ role: detail.role, phase: detail.phase || "-" })}
        ${segments || `<p class="text-muted">No renderable message segments.</p>`}
      </section>
    `;
  }

  if (detail.kind === "event_message") {
    return `
      <section class="detail-section">
        <h4>${escapeHtml(detail.subtype || "event message")}</h4>
        ${detail.text ? `<div class="detail-blob">${escapeHtml(detail.text)}</div>` : ""}
        ${renderJsonSection("Images", detail.images)}
        ${renderJsonSection("Local Images", detail.local_images)}
        ${renderJsonSection("Text Elements", detail.text_elements)}
      </section>
    `;
  }

  if (detail.kind === "reasoning") {
    const summary = (detail.summary || [])
      .map((entry) => `<div class="detail-blob">${escapeHtml(String(entry))}</div>`)
      .join("");
    return `
      <section class="detail-section">
        <h4>Reasoning Summary</h4>
        ${summary || `<p class="text-muted">No summary blocks available.</p>`}
        <p class="detail-line">Encrypted content present: ${detail.has_encrypted_content ? "yes" : "no"}</p>
      </section>
    `;
  }

  if (detail.kind === "tool_call") {
    return `
      <section class="detail-section">
        <h4>Tool Call</h4>
        ${renderKvGrid({
          subtype: detail.subtype,
          name: detail.name,
          call_id: detail.call_id,
          status: detail.status || "-",
        })}
      </section>
      ${
        detail.input_parsed
          ? renderJsonSection("Parsed Input", detail.input_parsed)
          : renderTextBlobSection("Raw Input", detail.input_raw || "")
      }
    `;
  }

  if (detail.kind === "tool_result") {
    let outputSection = "";
    if (detail.output_text) {
      outputSection = renderTextBlobSection("Output", detail.output_text);
    } else if (detail.output_parsed) {
      outputSection = renderJsonSection("Parsed Output", detail.output_parsed);
    } else {
      outputSection = renderJsonSection("Raw Output", detail.output);
    }

    return `
      <section class="detail-section">
        <h4>Tool Result</h4>
        ${renderKvGrid({
          subtype: detail.subtype,
          call_id: detail.call_id,
        })}
      </section>
      ${outputSection}
    `;
  }

  if (detail.kind === "tool_event") {
    const textFields = detail.text_fields || {};
    const textSections = Object.entries(textFields)
      .map(([key, value]) => renderTextBlobSection(key.replaceAll("_", " "), String(value)))
      .join("");

    return `
      <section class="detail-section">
        <h4>Tool Event</h4>
        ${renderKvGrid({
          subtype: detail.subtype,
          phase: detail.phase || "-",
          name: detail.name || "-",
          call_id: detail.call_id || "-",
          status: detail.status || "-",
          exit_code: detail.exit_code ?? "-",
          duration_ms: detail.duration_ms ?? "-",
        })}
      </section>
      ${textSections || renderJsonSection("Payload", detail.payload)}
    `;
  }

  if (detail.kind === "token_count") {
    const total = detail.total_usage || {};
    const last = detail.last_usage || {};
    return `
      <section class="detail-section">
        <h4>Token Count Snapshot</h4>
        ${renderKvGrid({
          model_context_window: formatNumber(detail.model_context_window),
          context_fill_percent: formatPercent(detail.context_fill_percent),
          total_tokens: formatNumber(total.total_tokens),
          input_tokens: formatNumber(total.input_tokens),
          cached_input_tokens: formatNumber(total.cached_input_tokens),
          output_tokens: formatNumber(total.output_tokens),
          reasoning_output_tokens: formatNumber(total.reasoning_output_tokens),
          last_total_tokens: formatNumber(last.total_tokens),
          last_input_tokens: formatNumber(last.input_tokens),
          last_cached_input_tokens: formatNumber(last.cached_input_tokens),
          last_output_tokens: formatNumber(last.output_tokens),
          last_reasoning_output_tokens: formatNumber(last.reasoning_output_tokens),
        })}
      </section>
      ${renderJsonSection("Rate Limits", detail.rate_limits)}
    `;
  }

  if (detail.kind === "compacted") {
    return `
      <section class="detail-section">
        <h4>Compaction Record</h4>
        ${renderKvGrid({
          replacement_history_count: formatNumber(detail.replacement_history_count),
        })}
      </section>
      ${detail.message ? renderTextBlobSection("Compaction Message", detail.message) : ""}
    `;
  }

  if (detail.kind === "web_search_call") {
    return `
      <section class="detail-section">
        <h4>Web Search Call</h4>
        ${renderKvGrid({ status: detail.status || "-" })}
      </section>
      ${renderJsonSection("Action", detail.action)}
    `;
  }

  return `
    <section class="detail-section">
      <h4>Event Payload</h4>
      ${renderJsonSection("Detail", detail)}
    </section>
  `;
}

function renderKvGrid(map) {
  const rows = Object.entries(map)
    .map(([key, value]) => {
      return `
        <div class="kv-key">${escapeHtml(key)}</div>
        <div class="kv-value">${escapeHtml(value === undefined || value === null ? "-" : String(value))}</div>
      `;
    })
    .join("");
  return `<div class="kv-grid">${rows}</div>`;
}

function renderJsonSection(title, value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return `
    <section class="detail-section">
      <h4>${escapeHtml(title)}</h4>
      <pre class="detail-blob json-highlight">${renderJsonCode(value)}</pre>
    </section>
  `;
}

function renderTextBlobSection(title, text) {
  if (!text) return "";
  return `
    <section class="detail-section">
      <h4>${escapeHtml(title)}</h4>
      <pre class="detail-blob">${escapeHtml(String(text))}</pre>
    </section>
  `;
}

function renderFatalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  state.timelineEntries = [];
  state.selectedTimelineEntryId = null;
  state.rawJsonExpanded = false;
  refs.conversationTitle.textContent = "Failed to load trace data";
  refs.conversationMeta.textContent = message;
  refs.conversationStatsInline.innerHTML = "";
  refs.conversationList.innerHTML = `<p class="text-muted">${escapeHtml(message)}</p>`;
  refs.tokenChart.innerHTML = `<p class="chart-empty">Error loading token chart.</p>`;
  refs.analyticsSummary.textContent = "Error loading analytics.";
  refs.analyticsGrid.innerHTML = "";
  refs.eventList.innerHTML = `<p class="text-muted">Error loading timeline.</p>`;
  refs.detailRendered.innerHTML = `<p class="text-muted">${escapeHtml(message)}</p>`;
  refs.detailRaw.innerHTML = "";
  refs.detailRaw.classList.add("collapsed");
  refs.toggleRawJson.hidden = true;
  refs.loadFullJson.hidden = true;
}

async function init() {
  bindEventHandlers();
  await bootstrap(false);
}

init().catch((error) => {
  renderFatalError(error);
});

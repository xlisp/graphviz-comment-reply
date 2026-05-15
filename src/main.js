// Tauri 2 global API (requires `app.withGlobalTauri: true` in tauri.conf.json).
// If the bridge is missing, every UI button silently fails — fail loudly instead.
if (!window.__TAURI__ || !window.__TAURI__.core || !window.__TAURI__.core.invoke) {
  document.body.innerHTML =
    '<pre style="padding:20px;color:#b32424;background:#fff;font-family:monospace">' +
    'Tauri bridge not available.\n\n' +
    'window.__TAURI__ = ' + JSON.stringify(window.__TAURI__) + '\n\n' +
    'Make sure tauri.conf.json has `"app": { "withGlobalTauri": true }`, then rebuild.' +
    '</pre>';
  throw new Error("Tauri bridge missing");
}
const invoke = window.__TAURI__.core.invoke;

window.addEventListener("error", (e) => console.error("[ui]", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => console.error("[ui] promise", e.reason));

// ============================================================================
// state
// ============================================================================

const state = {
  graphs: [],
  currentGraph: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  searchHits: null,    // null = not searching, [] = no hits, [...] = hits
  searchQuery: "",
};

// ============================================================================
// utilities
// ============================================================================

const $ = (sel) => document.querySelector(sel);

function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch { return s; } }

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Highlight FTS5 search terms inside arbitrary text. Splits on whitespace —
// matches the implicit-AND semantics ("foo bar" = AND of foo and bar).
function highlight(text, query) {
  if (!query || !text) return escapeHtml(text);
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return escapeHtml(text);
  const esc = escapeHtml(text);
  let out = esc;
  for (const t of terms) {
    const re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    out = out.replace(re, '<mark class="hl">$1</mark>');
  }
  return out;
}

// 10-char base62 id. 62^10 ≈ 8e17 — collisions are astronomically unlikely.
function genAppId() {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = "";
  for (let i = 0; i < 10; i++) s += alpha[bytes[i] % alpha.length];
  return s;
}

// Create a node with auto-generated app_id; retry on the (astronomically rare) collision.
async function createNodeAuto(graphId, content, parentNodeId) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const appId = genAppId();
    try {
      return await invoke("create_node", { graphId, appId, content, parentNodeId });
    } catch (e) {
      lastErr = e;
      const msg = String(e || "");
      if (!msg.includes("already exists")) throw e;   // unrelated error → bail
    }
  }
  throw new Error("Failed to allocate unique app_id after 5 attempts: " + lastErr);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ============================================================================
// modal
// ============================================================================

function modal({ title, body, okLabel = "OK", onValidate }) {
  return new Promise((resolve) => {
    const m = $("#modal");
    $("#modal-title").textContent = title;
    const bodyEl = $("#modal-body");
    bodyEl.className = "modal-body";
    bodyEl.innerHTML = "";
    bodyEl.appendChild(body);
    $("#modal-ok").textContent = okLabel;
    m.classList.remove("hidden");

    const firstField = bodyEl.querySelector("textarea, input, button");
    if (firstField && firstField.tagName !== "BUTTON") firstField.focus();

    function cleanup(result) {
      m.classList.add("hidden");
      $("#modal-ok").onclick = null;
      $("#modal-cancel").onclick = null;
      bodyEl.innerHTML = "";
      resolve(result);
    }
    $("#modal-ok").onclick = () => {
      const v = onValidate ? onValidate() : true;
      if (v === false) return;
      cleanup(v);
    };
    $("#modal-cancel").onclick = () => cleanup(null);
  });
}

// Modal that takes only a content textarea. Used for both new comment & reply.
async function contentModal({ title, placeholder = "", initial = "", okLabel = "OK" }) {
  const div = document.createElement("div");
  div.innerHTML = `
    <label>Content
      <textarea id="cm-content" rows="6" placeholder="${escapeHtml(placeholder)}">${escapeHtml(initial)}</textarea>
    </label>
    <small class="muted">app_id is generated automatically.</small>
  `;
  return modal({
    title,
    body: div,
    okLabel,
    onValidate() {
      const v = div.querySelector("#cm-content").value;
      if (!v.trim()) return false;
      return { content: v };
    },
  });
}

// Modal for picking the *target* of a reference edge — a list of existing nodes
// (since users no longer remember app_ids).
async function refTargetModal(fromNode) {
  const candidates = state.nodes.filter((n) => n.id !== fromNode.id);
  if (!candidates.length) { alert("This graph has no other nodes to reference yet."); return null; }
  const div = document.createElement("div");
  div.innerHTML = `
    <p class="muted">Pick the target node — adds a <b>ref</b> edge from <code>${escapeHtml(fromNode.app_id)}</code> to it. This may close a cycle.</p>
    <input id="cm-filter" type="search" placeholder="Filter…" autofocus />
    <ul id="cm-list" class="picker-list"></ul>
    <label>Edge label (optional)
      <input id="cm-label" placeholder="e.g. depends-on, contradicts" />
    </label>
  `;
  let picked = null;
  function render(filter = "") {
    const f = filter.toLowerCase();
    const ul = div.querySelector("#cm-list");
    const items = candidates.filter(
      (n) => n.app_id.toLowerCase().includes(f) || n.content.toLowerCase().includes(f),
    );
    ul.innerHTML = items.map((n) =>
      `<li data-id="${n.id}">
         <span class="app-id">${escapeHtml(n.app_id)}</span>
         <span>${escapeHtml(n.content.length > 120 ? n.content.slice(0, 120) + "…" : n.content)}</span>
       </li>`).join("");
    for (const li of ul.querySelectorAll("li")) {
      li.onclick = () => {
        picked = Number(li.dataset.id);
        ul.querySelectorAll("li").forEach((x) => x.classList.remove("picked"));
        li.classList.add("picked");
      };
    }
  }
  render();
  div.querySelector("#cm-filter").oninput = (e) => render(e.target.value);
  return modal({
    title: "Reference an existing node (⟲)",
    body: div,
    okLabel: "Add reference",
    onValidate() {
      if (!picked) { alert("Select a target node first."); return false; }
      const target = candidates.find((n) => n.id === picked);
      const label = div.querySelector("#cm-label").value || "";
      return { target, label };
    },
  });
}

// ============================================================================
// graphs
// ============================================================================

async function loadGraphs() {
  state.graphs = await invoke("list_graphs");
  renderGraphList();
}

function renderGraphList() {
  const ul = $("#graph-list");
  ul.innerHTML = "";
  for (const g of state.graphs) {
    const li = document.createElement("li");
    if (state.currentGraph?.id === g.id) li.classList.add("active");
    li.innerHTML = `<div class="gname">${escapeHtml(g.name)}</div><div class="gdate">${fmtDate(g.updated_at)}</div>`;
    li.onclick = () => selectGraph(g.id);
    ul.appendChild(li);
  }
}

async function selectGraph(id) {
  state.currentGraph = state.graphs.find((g) => g.id === id) || null;
  state.selectedNodeId = null;
  state.searchHits = null;
  state.searchQuery = "";
  $("#content-search").value = "";
  $("#search-count").textContent = "";
  renderGraphList();
  if (!state.currentGraph) return;
  $("#graph-title").textContent = state.currentGraph.name;
  $("#graph-desc").textContent = state.currentGraph.description || "";
  await reloadNodesAndEdges();
}

async function reloadNodesAndEdges() {
  if (!state.currentGraph) return;
  const [nodes, edges] = await Promise.all([
    invoke("list_nodes", { graphId: state.currentGraph.id }),
    invoke("list_edges", { graphId: state.currentGraph.id }),
  ]);
  state.nodes = nodes;
  state.edges = edges;
  renderTree();
  refreshDotPreview();
}

// ============================================================================
// tree (unified notes + replies with inline actions)
// ============================================================================

function buildTreeIndex() {
  const replyParent = new Map();          // child id -> parent id
  const outgoingByFrom = new Map();        // node id -> [edge]
  for (const e of state.edges) {
    if (e.kind === "reply") replyParent.set(e.to_node_id, e.from_node_id);
    if (!outgoingByFrom.has(e.from_node_id)) outgoingByFrom.set(e.from_node_id, []);
    outgoingByFrom.get(e.from_node_id).push(e);
  }
  const children = new Map();
  for (const n of state.nodes) {
    const p = replyParent.get(n.id);
    if (p) (children.get(p) || children.set(p, []).get(p)).push(n);
  }
  const roots = state.nodes.filter((n) => !replyParent.has(n.id));
  return { roots, children, outgoingByFrom };
}

function renderTree() {
  const ul = $("#nodes-tree");
  ul.innerHTML = "";
  if (state.nodes.length === 0) {
    ul.innerHTML = `<li class="muted" style="padding:10px">No nodes yet. Click <b>+ New comment</b> to start.</li>`;
    return;
  }

  const { roots, children, outgoingByFrom } = buildTreeIndex();
  const matchIds = new Set(state.searchHits ? state.searchHits.map((h) => h.node.id) : []);
  const nodeById = new Map(state.nodes.map((n) => [n.id, n]));

  function nodeLi(n) {
    const li = document.createElement("li");
    const card = document.createElement("div");
    card.className = "node-card";
    if (state.selectedNodeId === n.id) card.classList.add("selected");
    if (matchIds.has(n.id)) card.classList.add("match");

    const contentHtml = state.searchQuery
      ? highlight(n.content, state.searchQuery)
      : escapeHtml(n.content);

    const outgoing = outgoingByFrom.get(n.id) || [];
    const edgesHtml = outgoing.length === 0 ? "" : `
      <div class="outgoing-edges">
        ${outgoing.map((e) => {
          const target = nodeById.get(e.to_node_id);
          const tlabel = target ? target.app_id : "?";
          return `<span class="edge-pill ${e.kind}">
                    ${e.kind === "ref" ? "⟲" : "↳"} ${escapeHtml(tlabel)}${e.label ? " [" + escapeHtml(e.label) + "]" : ""}
                    <button data-edge="${e.id}" title="Delete edge">×</button>
                  </span>`;
        }).join("")}
      </div>`;

    card.innerHTML = `
      <div class="node-row">
        <span class="app-id">${escapeHtml(n.app_id)}</span>
        <div class="content-preview collapsed" data-node="${n.id}">${contentHtml}</div>
        <div class="row-actions">
          <button class="icon-btn act-reply" data-node="${n.id}" title="Reply (↳)">↳</button>
          <button class="icon-btn act-ref"   data-node="${n.id}" title="Reference (⟲) — adds a cycle">⟲</button>
          <button class="icon-btn act-edit"  data-node="${n.id}" title="Edit content">✎</button>
          <button class="icon-btn act-del danger" data-node="${n.id}" title="Delete node">✕</button>
        </div>
      </div>
      ${edgesHtml}
    `;

    // wire actions
    card.querySelector(".act-reply").onclick = (e) => { e.stopPropagation(); doReply(n); };
    card.querySelector(".act-ref").onclick   = (e) => { e.stopPropagation(); doAddRef(n); };
    card.querySelector(".act-edit").onclick  = (e) => { e.stopPropagation(); doEdit(n); };
    card.querySelector(".act-del").onclick   = (e) => { e.stopPropagation(); doDelete(n); };
    for (const btn of card.querySelectorAll("button[data-edge]")) {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        await invoke("delete_edge", { edgeId: Number(btn.dataset.edge) });
        await reloadNodesAndEdges();
      };
    }

    // click on content toggles expand/collapse + selection
    const cp = card.querySelector(".content-preview");
    cp.onclick = () => {
      state.selectedNodeId = n.id;
      cp.classList.toggle("collapsed");
      renderTree();
    };

    li.appendChild(card);
    const kids = children.get(n.id) || [];
    if (kids.length) {
      const sub = document.createElement("ul");
      for (const k of kids) sub.appendChild(nodeLi(k));
      li.appendChild(sub);
    }
    return li;
  }

  for (const r of roots) ul.appendChild(nodeLi(r));
}

function findNodeByAppId(appId) {
  return state.nodes.find((n) => n.app_id === appId) || null;
}

function scrollToNode(nodeId) {
  state.selectedNodeId = nodeId;
  renderTree();
  // expand the selected card's content
  setTimeout(() => {
    const el = document.querySelector(`#nodes-tree .content-preview[data-node="${nodeId}"]`);
    if (el) {
      el.classList.remove("collapsed");
      el.closest(".node-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 0);
}

// ============================================================================
// per-node actions
// ============================================================================

async function doReply(node) {
  const r = await contentModal({
    title: `Reply to ${node.app_id}`,
    placeholder: "Your reply…",
    okLabel: "Reply",
  });
  if (!r) return;
  try {
    const created = await createNodeAuto(state.currentGraph.id, r.content, node.id);
    state.selectedNodeId = created.id;
    await reloadNodesAndEdges();
  } catch (e) { alert(e); }
}

async function doAddRef(node) {
  const r = await refTargetModal(node);
  if (!r) return;
  try {
    await invoke("add_ref_edge", {
      graphId: state.currentGraph.id,
      fromNodeId: node.id,
      toAppId: r.target.app_id,
      label: r.label,
    });
    await reloadNodesAndEdges();
  } catch (e) { alert(e); }
}

async function doEdit(node) {
  const r = await contentModal({
    title: `Edit ${node.app_id}`,
    initial: node.content,
    okLabel: "Save",
  });
  if (!r) return;
  try {
    await invoke("update_node", { nodeId: node.id, content: r.content });
    await reloadNodesAndEdges();
  } catch (e) { alert(e); }
}

async function doDelete(node) {
  if (!confirm(`Delete node "${node.app_id}"? Replies under it will also be deleted.`)) return;
  try {
    await invoke("delete_node", { nodeId: node.id });
    if (state.selectedNodeId === node.id) state.selectedNodeId = null;
    await reloadNodesAndEdges();
  } catch (e) { alert(e); }
}

// ============================================================================
// top-level actions
// ============================================================================

$("#new-graph-btn").onclick = async () => {
  const div = document.createElement("div");
  div.innerHTML = `
    <label>Name <input id="cm-name" placeholder="e.g. Q2 strategy" /></label>
    <label>Description <input id="cm-desc" placeholder="Optional" /></label>
  `;
  const r = await modal({
    title: "New graph",
    body: div,
    okLabel: "Create",
    onValidate() {
      const name = div.querySelector("#cm-name").value.trim();
      if (!name) return false;
      return { name, desc: div.querySelector("#cm-desc").value };
    },
  });
  if (!r) return;
  const g = await invoke("create_graph", { name: r.name, description: r.desc });
  await loadGraphs();
  await selectGraph(g.id);
};

$("#rename-graph").onclick = async () => {
  if (!state.currentGraph) return;
  const div = document.createElement("div");
  div.innerHTML = `
    <label>Name <input id="cm-name" value="${escapeHtml(state.currentGraph.name)}" /></label>
    <label>Description <input id="cm-desc" value="${escapeHtml(state.currentGraph.description)}" /></label>
  `;
  const r = await modal({
    title: "Rename graph",
    body: div,
    okLabel: "Save",
    onValidate() {
      const name = div.querySelector("#cm-name").value.trim();
      if (!name) return false;
      return { name, desc: div.querySelector("#cm-desc").value };
    },
  });
  if (!r) return;
  await invoke("rename_graph", { id: state.currentGraph.id, name: r.name, description: r.desc });
  await loadGraphs();
  await selectGraph(state.currentGraph.id);
};

$("#delete-graph").onclick = async () => {
  if (!state.currentGraph) return;
  if (!confirm(`Delete graph "${state.currentGraph.name}"? This removes all nodes and edges.`)) return;
  await invoke("delete_graph", { id: state.currentGraph.id });
  state.currentGraph = null;
  $("#graph-title").textContent = "Pick or create a graph";
  $("#graph-desc").textContent = "";
  $("#nodes-tree").innerHTML = "";
  $("#dot-preview").textContent = "";
  await loadGraphs();
};

$("#new-root").onclick = async () => {
  if (!state.currentGraph) { alert("Pick or create a graph first."); return; }
  const r = await contentModal({
    title: "New top-level comment",
    placeholder: "Your thought…",
    okLabel: "Create",
  });
  if (!r) return;
  try {
    const created = await createNodeAuto(state.currentGraph.id, r.content, null);
    state.selectedNodeId = created.id;
    await reloadNodesAndEdges();
  } catch (e) { alert(e); }
};

// ============================================================================
// content search (FTS5 with space = AND)
// ============================================================================

const runSearch = debounce(async () => {
  if (!state.currentGraph) return;
  const q = $("#content-search").value.trim();
  state.searchQuery = q;
  if (!q) {
    state.searchHits = null;
    $("#search-count").textContent = "";
    renderTree();
    return;
  }
  try {
    const hits = await invoke("search_nodes", {
      graphId: state.currentGraph.id,
      query: q,
      limit: 100,
    });
    state.searchHits = hits;
    $("#search-count").textContent = `${hits.length} match${hits.length === 1 ? "" : "es"}`;
    renderTree();
    // auto-scroll to first match
    if (hits.length) scrollToNode(hits[0].node.id);
  } catch (e) {
    state.searchHits = [];
    $("#search-count").textContent = `error: ${e}`;
    renderTree();
  }
}, 150);

$("#content-search").oninput = runSearch;

// ============================================================================
// export / render
// ============================================================================

$("#export-gv").onclick = async () => {
  if (!state.currentGraph) return;
  try {
    const path = await invoke("export_gv", { graphId: state.currentGraph.id });
    alert(`Exported:\n${path}`);
  } catch (e) { alert(e); }
};
$("#render-pdf").onclick = async () => {
  if (!state.currentGraph) return;
  try { await invoke("render_and_open", { graphId: state.currentGraph.id, format: "pdf" }); }
  catch (e) { alert(e); }
};
$("#open-graphviz").onclick = async () => {
  if (!state.currentGraph) return;
  try { await invoke("open_in_graphviz_app", { graphId: state.currentGraph.id }); }
  catch (e) { alert(e); }
};
$("#show-dot").onclick = () => refreshDotPreview(true);

async function refreshDotPreview(force = false) {
  if (!state.currentGraph) { $("#dot-preview").textContent = ""; return; }
  try {
    const dot = await invoke("preview_dot", { graphId: state.currentGraph.id });
    $("#dot-preview").textContent = dot;
  } catch (e) {
    if (force) alert(e);
  }
}

// ============================================================================
// path search — accepts keyword OR exact app_id
// ============================================================================

async function resolveToAppId(input) {
  // exact app_id match wins
  const exact = findNodeByAppId(input);
  if (exact) return { node: exact, viaSearch: false };
  // otherwise FTS5 best match
  const hits = await invoke("search_nodes", {
    graphId: state.currentGraph.id,
    query: input,
    limit: 1,
  });
  if (hits.length) return { node: hits[0].node, viaSearch: true };
  return null;
}

$("#search-paths").onclick = async () => {
  if (!state.currentGraph) return;
  const fromIn = $("#from-id").value.trim();
  const toIn = $("#to-id").value.trim();
  if (!fromIn || !toIn) { alert("Enter both From and To"); return; }
  try {
    const [fromR, toR] = await Promise.all([resolveToAppId(fromIn), resolveToAppId(toIn)]);
    if (!fromR) { alert(`No match for From="${fromIn}"`); return; }
    if (!toR)   { alert(`No match for To="${toIn}"`); return; }

    const hits = await invoke("find_paths", {
      graphId: state.currentGraph.id,
      fromAppId: fromR.node.app_id,
      toAppId: toR.node.app_id,
      maxPaths: 10,
    });
    renderPathResults({
      from: fromR, fromInput: fromIn,
      to: toR, toInput: toIn,
      hits,
    });
  } catch (e) { alert(e); }
};

function renderPathResults({ from, fromInput, to, toInput, hits }) {
  const box = $("#path-results");
  const resolvedNote = (from.viaSearch || to.viaSearch)
    ? `<div class="resolved-note">
         Resolved
         ${from.viaSearch ? `<b>${escapeHtml(fromInput)}</b> → <code>${escapeHtml(from.node.app_id)}</code>` : ""}
         ${from.viaSearch && to.viaSearch ? " · " : ""}
         ${to.viaSearch ? `<b>${escapeHtml(toInput)}</b> → <code>${escapeHtml(to.node.app_id)}</code>` : ""}
       </div>`
    : "";

  if (!hits.length) {
    box.innerHTML = resolvedNote + `<p class="muted" style="padding:8px">No path found.</p>`;
    return;
  }
  box.innerHTML = resolvedNote + hits.map((h, i) => {
    const steps = h.nodes.map((n, idx) => {
      const kind = idx > 0 ? h.edge_kinds[idx - 1] : null;
      const arrow = kind ? `<span class="arrow ${kind === "ref" ? "ref" : ""}">${kind === "ref" ? " ⟲ " : " ↳ "}</span>` : "";
      return `${arrow}<span class="step" data-node="${n.id}"><span class="app-id">${escapeHtml(n.app_id)}</span></span>`;
    }).join("");
    return `<div class="path-item"><b>Path ${i + 1}</b> · ${h.nodes.length - 1} step(s)<br/>${steps}</div>`;
  }).join("");

  // clickable steps → jump to that node
  for (const s of box.querySelectorAll(".step[data-node]")) {
    s.style.cursor = "pointer";
    s.onclick = () => scrollToNode(Number(s.dataset.node));
  }
}

// ============================================================================
// boot
// ============================================================================

loadGraphs();

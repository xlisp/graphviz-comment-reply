# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ThoughtGraph — a macOS desktop app (Tauri 2 + Rust + SQLite + vanilla HTML/JS) for capturing chains of thought as directed graphs of comments and replies, exportable to GraphViz. A second binary in the same workspace, `thoughtgraph-mcp`, exposes the same SQLite store as a Model Context Protocol server for Claude Desktop. See `README.md` (in Chinese) for product rationale and end-user flow; see `mcp-server/README.md` for MCP setup.

## Commands

All commands are run from the repository root. This is a **Cargo workspace** (`Cargo.toml` at root) with two members: `src-tauri/` (the desktop app) and `mcp-server/` (the MCP server).

```bash
npm install                                 # one-time: install @tauri-apps/cli
npm run dev                                 # launch dev app (recompiles Tauri on first run, ~3–5 min)
npm run build                               # produce ThoughtGraph.app + .dmg in target/release/bundle/

cargo check                                 # type-check both crates
cargo check -p graphviz-comment-reply       # just the Tauri app
cargo check -p thoughtgraph-mcp             # just the MCP server
cargo build -p thoughtgraph-mcp --release   # builds the MCP server binary

# MCP smoke test (no Claude Desktop needed): pipe JSON-RPC frames in, watch responses.
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
              '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | THOUGHTGRAPH_DB=/tmp/tg-test.sqlite3 target/release/thoughtgraph-mcp
```

No Rust tests exist yet. The frontend has no build step — `src/index.html`, `src/styles.css`, `src/main.js` are loaded directly by Tauri (`frontendDist: "../src"` in `tauri.conf.json`). Workspace target directory is at the root (`./target/`), shared across both crates.

## Architecture

### Two crates, one window

- `src-tauri/` is the Rust crate. `main.rs` is a thin shim that calls `graphviz_comment_reply_lib::run()` from `lib.rs`. The crate is declared as both `cdylib` and `rlib` (required by Tauri 2 mobile-ready scaffolding even though we only target desktop).
- `src/` is the webview-side UI. There is **no bundler**: `main.js` calls `window.__TAURI__.core.invoke(...)` directly. Adding a frontend framework would require introducing a build step and updating `frontendDist` / `beforeBuildCommand` in `tauri.conf.json`.

### Layered Rust modules

`lib.rs` → registers plugins (`tauri-plugin-dialog`, `tauri-plugin-opener`), opens the SQLite connection in `setup()`, stashes it in `DbState { conn: Mutex<Connection> }` via `app.manage`, and lists every Tauri command in `invoke_handler!`.

`commands.rs` → thin wrappers that lock the mutex, delegate to `db.rs` / `graph.rs`, and stringify errors. **Every new feature exposed to JS must be added in two places**: as a `#[tauri::command]` function here, and in the `invoke_handler!` list in `lib.rs`.

`db.rs` → SQLite schema and CRUD. Three tables:
- `graphs(id, name, description, created_at, updated_at)`
- `nodes(id, graph_id, app_id, content, created_at)` with `UNIQUE(graph_id, app_id)`
- `edges(id, graph_id, from_node_id, to_node_id, kind, label)` where `kind ∈ {'reply', 'ref'}`

`graph.rs` → pure-Rust DOT rendering, BFS shortest-path search over the combined edge set, and a `which_dot()` resolver that probes `/usr/local/bin/dot`, `/opt/homebrew/bin/dot`, `/usr/bin/dot`, then falls back to `command -v dot`.

### The two edge kinds matter

This is the core domain concept and not obvious from types alone:
- **`reply`** edges form the comment tree (each node has at most one reply-parent). The frontend tree view in `main.js` (`renderTree`) is built exclusively from these.
- **`ref`** edges are user-authored cross-references by `app_id`. They are the mechanism by which graphs become cyclic — the whole point of the app. They render dashed-red in DOT with `constraint=false` so `dot` does not try to use them for layout ranking.

When adding features, be careful to preserve this distinction: anything that walks "the tree" should filter for `kind='reply'`; anything that walks "the graph" (path search, DOT export) uses both.

### Tauri command parameter naming

Rust uses snake_case (`graph_id`, `parent_node_id`), but Tauri serializes them as camelCase on the JS side (`graphId`, `parentNodeId`). The mapping is automatic — when adding a command, the JS call site must use camelCase or `invoke` will silently pass `undefined`.

### Data and export locations

Resolved at runtime via `app.path().app_data_dir()`:
- DB: `~/Library/Application Support/com.chanshunli.thoughtgraph/thoughtgraph.sqlite3`
- Exports: `…/com.chanshunli.thoughtgraph/exports/<sanitised-name>.{gv,pdf,…}`

The `bundle.identifier` in `tauri.conf.json` (`com.chanshunli.thoughtgraph`) determines this path — changing it strands existing user data.

### Tauri 2 capability gotcha

`src-tauri/capabilities/default.json` is the v2 equivalent of v1's `tauri.allowlist`. Anything the webview tries to invoke that isn't permitted there will fail silently at the IPC bridge. Plugin permissions are namespaced (`opener:default`, `dialog:default`, etc.). Custom `#[tauri::command]` functions registered in `invoke_handler!` work without an explicit entry because `core:default` covers them.

### Icon constraint

Tauri's `generate_context!` macro at compile time requires `icons/32x32.png` to be **8-bit RGBA** (color type 6), not RGB (color type 2). The placeholder icons in this repo were generated by the inline Python in commit history; if regenerating, use `PNG color type 6` or the build will fail with `icon ... is not RGBA`. The `iconutil` step that produces `icon.icns` is downstream of `icon.png` and only runs at build time on macOS.

## MCP server (`mcp-server/`)

A second binary, `thoughtgraph-mcp`, talks **MCP 2024-11-05 over stdio** so Claude Desktop can use the same SQLite store as a long-term memory.

- Depends on the Tauri crate via path (`graphviz-comment-reply = { path = "../src-tauri" }`); the extern-crate name on the Rust side is `graphviz_comment_reply_lib` because `[lib].name` differs from the package name. **This dual naming trips people up.**
- `main.rs` is a hand-written JSON-RPC loop (no SDK dep); `tools.rs` holds the 13 tool definitions, dispatcher, and the helper `resolve_graph_value` that accepts either a graph id (int) or name (string).
- Anything written to **stdout** is protocol traffic — never `println!`/`print!` for diagnostics from the MCP server; use `eprintln!` (stderr) instead.
- DB location: hardcoded macOS path inside `db::default_db_path()`, overridable via `THOUGHTGRAPH_DB` env var. Useful for testing without trampling the user's real graphs.
- FTS5 search is wired via a contentless `nodes_fts` virtual table kept in sync by triggers (`nodes_ai`, `nodes_ad`, `nodes_au`) declared in `db::init`. `backfill_fts` runs on every startup and rebuilds the index if it's behind `nodes` (covers the case where rows existed before FTS was added).
- WAL is enabled in `db::init` to allow the GUI app and MCP server to share the DB safely.

## When modifying

- DB schema changes: edit the `CREATE TABLE`/`CREATE VIRTUAL TABLE`/`CREATE TRIGGER` block in `db::init`. There is no migration framework — for local-dev resets, delete `thoughtgraph.sqlite3` (and any `-wal`/`-shm` sidecars).
- New Tauri command: add to `commands.rs`, then to `invoke_handler!` in `lib.rs`, then call with camelCase params from `main.js`.
- New MCP tool: append to `tools::definitions()`, add a match arm in `tools::call()`, write the `do_*` impl. The JSON schema in `inputSchema` is what Claude sees — be specific in `description` fields.
- DOT styling changes live in `graph::render_dot`; the `ref` edge gets `style=dashed, color="#cc5555", constraint=false` — keep `constraint=false` or cycles will distort the layout.

# thoughtgraph-mcp · 图记忆中心

把 ThoughtGraph 暴露成一个 **MCP server**，让 Claude Desktop 把它当作
**长期外置记忆**：可以跨会话写入、读取、搜索图谱节点，可以让 AI 主动维护
自己的思维结构。

---

## 1. 设计理念：什么是"图记忆中心"

普通对话型 AI 的记忆是**线性、易遗忘**的。本 MCP 把记忆建模为
**有向图 + 全文索引**：

| 维度 | 普通 memory | 图记忆中心 |
| --- | --- | --- |
| 拓扑 | 列表（fact 1, fact 2 …） | 有向图（comment → reply → ref ⟲） |
| 检索 | 关键词 / 嵌入相似度 | FTS5 全文 + BFS 路径检索 |
| 关系 | 隐式 | 显式（每条 reply / ref 边） |
| 回归性 | 无 | 支持环（recursive thinking） |
| 持久化 | 服务端 | 用户本地 SQLite，与 GUI app 共享 |

也就是说：**Claude 不再只是"记得 X"，而是知道 X 在哪张图、属于谁的回复、
是否回指过自己**。

---

## 2. 共享存储

- 文件：`~/Library/Application Support/com.chanshunli.thoughtgraph/thoughtgraph.sqlite3`
- 与 GUI 桌面 app 同一个 DB，两边都能读写。
- 已启用 **WAL 模式**，并发读写安全；
- `nodes_fts` 是 SQLite **FTS5 虚拟表**，由触发器自动同步，无需手动重建索引。
- 想用别的路径？设置 `THOUGHTGRAPH_DB=/path/to/your.sqlite3` 即可（测试或多 profile 场景）。

---

## 3. 工具清单（13 个）

| 工具 | 类别 | 作用 |
| --- | --- | --- |
| `list_graphs` | 读 | 列出全部图，可按名字过滤 |
| `create_graph` | 写 | 新建图 |
| `delete_graph` | 写 | 删除图（连带节点 / 边） |
| `get_graph` | 读 | 返回整张图的 Markdown 渲染 |
| `add_node` | 写 | 添加根评论或回复（带 `parent_app_id`） |
| `update_node` | 写 | 修改节点正文 |
| `delete_node` | 写 | 删除节点（及其子树） |
| `add_reference` | 写 | 添加 ref 边 ⟲，是制造**环**的唯一手段 |
| `search_nodes` | 读 | **FTS5 全文检索**，BM25 排序，返回 snippet |
| `find_paths` | 读 | BFS 找两个 app_id 间的最短路径 |
| `export_dot` | 读 | 导出 GraphViz DOT 源码 |
| `render_graph` | 读 | 调用 `dot` 渲染 PDF/PNG/SVG，返回绝对路径 |
| `stats` | 读 | 总览统计：图数、节点数、ref 边数、TOP 5 图 |

资源（Resources）：
- `thoughtgraph://index` — 全部图的 JSON 列表
- `thoughtgraph://graph/<id-or-name>` — 单张图的 Markdown 视图

---

## 4. Claude Desktop 接入

### 4.1 编译

```bash
cd /Users/xlisp/RustPro/graphviz-comment-reply
cargo build -p thoughtgraph-mcp --release
# 产物：target/release/thoughtgraph-mcp
```

### 4.2 配置

打开（或新建）`~/Library/Application Support/Claude/claude_desktop_config.json`，
加入：

```json
{
  "mcpServers": {
    "thoughtgraph": {
      "command": "/Users/xlisp/RustPro/graphviz-comment-reply/target/release/thoughtgraph-mcp"
    }
  }
}
```

如果想用独立的 DB 给 Claude 用（与 GUI app 隔离），加 env：

```json
{
  "mcpServers": {
    "thoughtgraph": {
      "command": "/Users/xlisp/RustPro/graphviz-comment-reply/target/release/thoughtgraph-mcp",
      "env": {
        "THOUGHTGRAPH_DB": "/Users/xlisp/thoughtgraph-claude.sqlite3"
      }
    }
  }
}
```

退出并重启 Claude Desktop。在新会话里你应看到 **"thoughtgraph"** server 连接成功，
13 个工具全部可用。

### 4.3 验证 / 调试

可以手动用 JSON-RPC 模拟一次握手：

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| ./target/release/thoughtgraph-mcp
```

应返回两条 JSON 响应，列出全部工具。

server 自己的诊断输出写到 **stderr**（stdout 是协议保留通道）。

---

## 5. 与 Claude 的典型对话场景

**捕获想法**
> "把这次复盘记下来，建一张叫 `Q2-Retro` 的图，先放三个根节点：客户流失、产品速度、招聘节奏。"
>
> Claude → `create_graph` → 三次 `add_node`。

**追溯路径**
> "我之前讨论过的'产品速度太慢'最后是怎么连到'招聘节奏'的？"
>
> Claude → `search_nodes(query="产品速度")` → `find_paths(from=…, to=…)`。

**制造环（回归思考）**
> "我注意到决定 X 又把我们带回到最初问题 Q，把它们连成环。"
>
> Claude → `add_reference(from='X', to='Q', label='loops-back')`。

**可视化**
> "把这张图渲染成 PDF。"
>
> Claude → `render_graph(graph='Q2-Retro', format='pdf')` → 返回路径，用户打开。

---

## 6. 协议实现要点（如果你想 hack）

- 协议版本：**MCP 2024-11-05**
- 传输：stdio + 行分隔的 JSON-RPC 2.0
- 单连接、单线程；DB 连接放在 `Mutex<Connection>` 里
- 实现位于 `src/main.rs` (JSON-RPC loop) + `src/tools.rs` (定义 + dispatch)
- 复用了主项目的 `db.rs` / `graph.rs`，新增 `db::search_nodes` 走 FTS5 BM25

# entra-news-mcp

> A searchable knowledge MCP over [Entra.news](https://entra.news) — Merill Fernando's curated weekly digest of Microsoft Entra news, features, and community tools.

[![npm](https://img.shields.io/npm/v/entra-news-mcp)](https://www.npmjs.com/package/entra-news-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is this?

**Entra.news** is a high-signal, curated newsletter covering Microsoft Entra (Azure AD) features, announcements, and community tools — published weekly since mid-2023.

This MCP server exposes the full historical archive as a natural language search interface. Ask questions and get sourced answers directly from past issues — including issue number, date, and canonical URL.

**Zero per-user infrastructure.** Users install an NPX package. That's it.

---

## Quick Start

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "entra-news-mcp": {
      "command": "npx",
      "args": ["entra-news-mcp"]
    }
  }
}
```

Restart Claude Desktop. The database (~15–20 MB) will be downloaded on first launch and cached in `~/.entra-news-mcp/`.

### Cursor / Copilot Studio / Any MCP Host

```json
{
  "mcpServers": {
    "entra-news-mcp": {
      "command": "npx",
      "args": ["-y", "entra-news-mcp"]
    }
  }
}
```

### Semantic Search (Optional)

By default the server uses keyword search (BM25 via FTS5). For significantly better result quality, set your OpenAI API key:

```json
{
  "mcpServers": {
    "entra-news-mcp": {
      "command": "npx",
      "args": ["entra-news-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

---

## Local Database Cache

On first launch the server downloads the database (~15–20 MB) from GitHub Releases and caches it locally:

| Platform | Cache location |
|----------|---------------|
| Windows  | `%USERPROFILE%\.entra-news-mcp\` |
| macOS / Linux | `~/.entra-news-mcp/` |

The server checks for a newer database release **once per week**. If you want to force an immediate re-download (e.g. after a new issue has been ingested), delete the cache folder and restart your MCP host:

**Windows (PowerShell):**
```powershell
Remove-Item "$env:USERPROFILE\.entra-news-mcp" -Recurse -Force
```

**macOS / Linux:**
```bash
rm -rf ~/.entra-news-mcp
```

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `search_entra_news` | Semantic + keyword hybrid search over all issues. Returns sourced excerpts. |
| `get_issue` | Retrieve the full content of a specific issue by number or date. |
| `list_issues` | Browse the archive with optional year/month filtering. |
| `find_tool_mentions` | Discover community tools and GitHub projects mentioned in the archive. |

### Example queries

- *"What did Entra.news cover about Conditional Access in 2024?"*
- *"Show me the issue from March 2025"*
- *"What PowerShell tools for Entra have been mentioned?"*
- *"Has there been coverage of Verified ID?"*
- *"List all issues from 2024"*

---

## Architecture

```
Substack API (entra.news/api/v1/posts)
    │
    ▼
Node.js ingestion script  ←  OpenAI text-embedding-3-small
    │
    ▼
SQLite + sqlite-vec (~15–20 MB)
    │
    ▼
GitHub Release asset  ──→  NPX MCP Server
                               └─ Downloads DB on first run
                               └─ Checks for updates weekly
                               └─ Local vector + FTS search
```

**Cost:** ~$0.01/week (embeddings on new issues only). Zero hosting.

---

## Running the Ingestion Pipeline

> **Note:** You only need to do this if you're maintaining your own fork or building the initial index. End users just run `npx entra-news-mcp` — the database is downloaded automatically.

### Prerequisites

- Node.js 22+
- An OpenAI API key (`text-embedding-3-small` access)

### Full ingest (first time)

```powershell
# Set your API key
$env:OPENAI_API_KEY = "sk-..."

# Run the ingestion pipeline
./scripts/ingest.ps1
```

Or directly with Node.js:

```bash
export OPENAI_API_KEY=sk-...
npm install && npm run build
node dist/scripts/ingest.js
```

### Incremental update (new issues only)

```powershell
./scripts/ingest.ps1 -Incremental
```

```bash
node dist/scripts/ingest.js --incremental
```

The output database (`entra-news.db`) should then be uploaded as a GitHub Release asset — the GitHub Actions workflow handles this automatically on a weekly schedule.

---

## Automated Weekly Updates

A GitHub Actions workflow (`.github/workflows/weekly-update.yml`) runs every Sunday at 14:00 UTC:

1. Downloads the current database from GitHub Releases
2. Runs the incremental ingestion pipeline
3. Publishes the updated database as a new GitHub Release

**Required secret:** Add `OPENAI_API_KEY` to your repository secrets (Settings → Secrets).

---

## Development

```bash
npm install
npm run build          # Compile TypeScript
npm start              # Run the MCP server
```

### Project structure

```
src/
  index.ts             # Entry point
  server.ts            # MCP server + tool registration
  db/
    client.ts          # SQLite + sqlite-vec client, DB download/cache
  tools/
    search.ts          # search_entra_news tool
    get-issue.ts       # get_issue tool
    list-issues.ts     # list_issues tool
    find-tool-mentions.ts  # find_tool_mentions tool
  utils/
    embeddings.ts      # OpenAI embedding helper
scripts/
  ingest.ts            # Full ingestion pipeline (TypeScript)
  ingest.ps1           # PowerShell wrapper for ingestion
.github/workflows/
  weekly-update.yml    # Automated weekly update
```

---

## Permissions & Content

The Entra.news content is © Merill Fernando & Joshua Fernando. This tool accesses the publicly available Substack API (not scraping) and is intended for personal/community use. Please reach out to [hey@entra.news](mailto:hey@entra.news) before any public deployment.

---

## Author

Built by [Darren Robinson](https://github.com/darrenjrobinson).

Entra.news by [Merill Fernando](https://merill.net).

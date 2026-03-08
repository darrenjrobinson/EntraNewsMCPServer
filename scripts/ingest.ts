#!/usr/bin/env ts-node
/**
 * Entra.news ingestion pipeline
 *
 * Fetches all (or new) issues from the Substack API, cleans the HTML,
 * chunks the content, generates OpenAI embeddings, and stores everything
 * in a local SQLite database with sqlite-vec for vector search.
 *
 * Usage:
 *   npx ts-node scripts/ingest.ts                    # Full ingest
 *   npx ts-node scripts/ingest.ts --incremental      # Only new issues
 *   npx ts-node scripts/ingest.ts --issue 42         # Single issue
 *   node dist/scripts/ingest.js --incremental        # Compiled
 *
 * Required environment variables:
 *   OPENAI_API_KEY   — OpenAI API key for embeddings
 *
 * Optional:
 *   INGEST_DB_PATH   — Output SQLite path (default: ./entra-news.db)
 */

import { DatabaseSync } from 'node:sqlite';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUBSTACK_BASE = 'https://entra.news/api/v1/posts';
const PAGE_SIZE = 50;
const CHUNK_TARGET_WORDS = 400;
const CHUNK_OVERLAP_WORDS = 50;
const OPENAI_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_BATCH = 20; // items per OpenAI request
const RATE_LIMIT_DELAY_MS = 200;

const DB_PATH =
  process.env.INGEST_DB_PATH ?? path.join(process.cwd(), 'entra-news.db');

const args = process.argv.slice(2);
const INCREMENTAL = args.includes('--incremental');
const SINGLE_ISSUE_ARG = (() => {
  const idx = args.indexOf('--issue');
  return idx >= 0 ? parseInt(args[idx + 1], 10) : null;
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface SubstackPost {
  id: number;
  title: string;
  subtitle?: string;
  slug: string;
  post_date: string;
  canonical_url: string;
  body_html?: string;
  audience?: string;
}

interface IssueRow {
  id: number;
  post_id: string;
  issue_number: number | null;
  title: string;
  subtitle: string | null;
  published_at: string;
  url: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'entra-news-mcp-ingest/0.1.0', ...headers },
    };
    https.get(url, options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(get(res.headers.location, headers));
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Substack API
// ---------------------------------------------------------------------------
async function fetchPage(offset: number): Promise<SubstackPost[]> {
  const url = `${SUBSTACK_BASE}?limit=${PAGE_SIZE}&offset=${offset}`;
  log(`Fetching page offset=${offset}…`);
  const raw = await get(url);
  const data = JSON.parse(raw) as SubstackPost[] | { posts: SubstackPost[] };
  return Array.isArray(data) ? data : (data as { posts: SubstackPost[] }).posts ?? [];
}

async function fetchPost(slug: string): Promise<SubstackPost> {
  const url = `https://entra.news/api/v1/posts/${slug}`;
  const raw = await get(url);
  return JSON.parse(raw) as SubstackPost;
}

async function fetchAllPosts(): Promise<SubstackPost[]> {
  const all: SubstackPost[] = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage(offset);
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(RATE_LIMIT_DELAY_MS);
  }
  return all;
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractSections(html: string): Array<{ heading: string | null; text: string }> {
  const sections: Array<{ heading: string | null; text: string }> = [];
  const headingRe = /<h[1-4][^>]*>(.*?)<\/h[1-4]>/gi;

  let lastEnd = 0;
  let currentHeading: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = headingRe.exec(html)) !== null) {
    const textBefore = stripHtml(html.slice(lastEnd, match.index)).trim();
    if (textBefore) {
      sections.push({ heading: currentHeading, text: textBefore });
    }
    currentHeading = stripHtml(match[1]).trim();
    lastEnd = match.index + match[0].length;
  }

  const remaining = stripHtml(html.slice(lastEnd)).trim();
  if (remaining) {
    sections.push({ heading: currentHeading, text: remaining });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------
function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= CHUNK_TARGET_WORDS) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + CHUNK_TARGET_WORDS, words.length);
    chunks.push(words.slice(start, end).join(' '));
    if (end >= words.length) break;
    start = end - CHUNK_OVERLAP_WORDS;
  }
  return chunks;
}

function buildChunks(
  post: SubstackPost
): Array<{ section_heading: string | null; text: string }> {
  const html = post.body_html ?? '';
  const sections = extractSections(html);
  const chunks: Array<{ section_heading: string | null; text: string }> = [];

  for (const section of sections) {
    if (wordCount(section.text) < 20) continue; // skip stub sections
    const subchunks = chunkText(section.text);
    for (const chunk of subchunks) {
      chunks.push({ section_heading: section.heading, text: chunk });
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// GitHub link / tool mention extraction
// ---------------------------------------------------------------------------
interface ToolMention {
  tool_name: string;
  github_url: string | null;
  description: string | null;
  context: string | null;
}

/**
 * Extract tool/product/resource mentions from newsletter HTML.
 * Captures:
 *  1. GitHub repo links  → tool_name derived from repo slug, github_url populated
 *  2. Microsoft-domain links (docs.microsoft.com, techcommunity, learn.microsoft.com,
 *     azure.microsoft.com, entra.microsoft.com) → treated as MS product/feature mentions
 */
function extractToolMentions(html: string, title: string): ToolMention[] {
  const mentions: ToolMention[] = [];
  const seen = new Set<string>();

  // ---- 1. GitHub repo links ------------------------------------------------
  const ghRe = /href="(https:\/\/github\.com\/[^"#?]+)"/gi;
  let m: RegExpExecArray | null;

  while ((m = ghRe.exec(html)) !== null) {
    const url = m[1];
    const parts = url.replace('https://github.com/', '').split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const repoUrl = `https://github.com/${parts[0]}/${parts[1]}`;
    if (seen.has(repoUrl)) continue;
    seen.add(repoUrl);

    const matchStart = Math.max(0, m.index - 200);
    const matchEnd = Math.min(html.length, m.index + 200);
    const context = stripHtml(html.slice(matchStart, matchEnd)).replace(/\s+/g, ' ').trim();
    const toolName = parts[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    mentions.push({
      tool_name: toolName,
      github_url: repoUrl,
      description: null,
      context: context.slice(0, 500),
    });
  }

  // ---- 2. Microsoft-domain feature/product links ---------------------------
  // Matches links under docs.microsoft.com, learn.microsoft.com,
  // techcommunity.microsoft.com, azure.microsoft.com, entra.microsoft.com, etc.
  const msRe = /href="(https?:\/\/(?:docs|learn|techcommunity|azure|entra|admin|portal)\.microsoft\.com\/[^"#?]*[^"#?/])"/gi;

  while ((m = msRe.exec(html)) !== null) {
    const url = m[1];
    // Derive a de-duplication key from the last two path segments
    const pathParts = url.split('/').filter(Boolean).slice(-3);
    const key = pathParts.join('/');
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // Try to extract anchor display text immediately before/after the href
    const anchorTextRe = /href="[^"]+">([^<]{4,80})<\/a/i;
    const surrounding = html.slice(Math.max(0, m.index - 10), m.index + m[0].length + 120);
    const anchorMatch = anchorTextRe.exec(surrounding);
    const anchorText = anchorMatch ? anchorMatch[1].trim() : null;

    // Derive a human-readable name: prefer anchor text, then last path slug
    const slug = pathParts[pathParts.length - 1] ?? '';
    const toolName = anchorText
      ? anchorText.replace(/\s+/g, ' ').trim()
      : slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    if (!toolName || toolName.length < 3) continue;

    const matchStart = Math.max(0, m.index - 200);
    const matchEnd = Math.min(html.length, m.index + 200);
    const context = stripHtml(html.slice(matchStart, matchEnd)).replace(/\s+/g, ' ').trim();

    mentions.push({
      tool_name: toolName,
      github_url: null,
      description: null,
      context: context.slice(0, 500),
    });
  }

  return mentions;
}

// ---------------------------------------------------------------------------
// OpenAI embeddings
// ---------------------------------------------------------------------------
async function embedBatch(
  texts: string[],
  apiKey: string
): Promise<Float32Array[]> {
  const body = JSON.stringify({
    input: texts,
    model: OPENAI_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const responseText = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      'https://api.openai.com/v1/embeddings',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const parsed = JSON.parse(responseText) as {
    data: Array<{ embedding: number[]; index: number }>;
    error?: { message: string };
  };

  if (parsed.error) throw new Error(`OpenAI error: ${parsed.error.message}`);

  // Sort by index (API returns in order, but be safe)
  const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => new Float32Array(d.embedding));
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
function openDb(): DatabaseSync {
  return new DatabaseSync(DB_PATH);
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id          INTEGER PRIMARY KEY,
      post_id     TEXT    UNIQUE NOT NULL,
      issue_number INTEGER,
      title       TEXT    NOT NULL,
      subtitle    TEXT,
      published_at TEXT   NOT NULL,
      url         TEXT    NOT NULL,
      slug        TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id              INTEGER PRIMARY KEY,
      issue_id        INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      chunk_index     INTEGER NOT NULL,
      section_heading TEXT,
      text            TEXT    NOT NULL,
      UNIQUE(issue_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS vec_embeddings (
      chunk_id  INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_mentions (
      id          INTEGER PRIMARY KEY,
      issue_id    INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      tool_name   TEXT    NOT NULL,
      github_url  TEXT,
      description TEXT,
      context     TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_issues_published ON issues(published_at);
    CREATE INDEX IF NOT EXISTS idx_issues_number   ON issues(issue_number);
    CREATE INDEX IF NOT EXISTS idx_chunks_issue    ON chunks(issue_id);
    CREATE INDEX IF NOT EXISTS idx_tools_issue     ON tool_mentions(issue_id);
  `);
}

function getKnownPostIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT post_id FROM issues').all() as Array<{ post_id: string }>;
  return new Set(rows.map((r) => r.post_id));
}

function upsertIssue(
  db: DatabaseSync,
  post: SubstackPost,
  issueNumber: number | null
): number {
  db.prepare(
    `INSERT INTO issues (post_id, issue_number, title, subtitle, published_at, url, slug)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id) DO UPDATE SET
       title        = excluded.title,
       subtitle     = excluded.subtitle,
       published_at = excluded.published_at,
       url          = excluded.url,
       issue_number = excluded.issue_number`
  ).run(
    String(post.id), issueNumber, post.title,
    post.subtitle ?? null, post.post_date, post.canonical_url, post.slug
  );
  const row = db.prepare('SELECT id FROM issues WHERE post_id = ?').get(String(post.id)) as { id: number };
  return row.id;
}

function insertChunk(
  db: DatabaseSync,
  issueId: number,
  chunkIndex: number,
  sectionHeading: string | null,
  text: string
): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO chunks (issue_id, chunk_index, section_heading, text)
       VALUES (?, ?, ?, ?)`
    )
    .run(issueId, chunkIndex, sectionHeading, text);
  if ((result as { changes: number }).changes > 0) {
    const row = db.prepare(
      'SELECT id FROM chunks WHERE issue_id = ? AND chunk_index = ?'
    ).get(issueId, chunkIndex) as { id: number };
    return row.id;
  }
  return -1;
}

function insertVecChunk(db: DatabaseSync, chunkId: number, embedding: Float32Array): void {
  const buf = Buffer.from(embedding.buffer);
  db.prepare(
    `INSERT OR REPLACE INTO vec_embeddings (chunk_id, embedding) VALUES (?, ?)`
  ).run(chunkId, buf);
}

function insertToolMentions(
  db: DatabaseSync,
  issueId: number,
  mentions: ToolMention[]
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tool_mentions (issue_id, tool_name, github_url, description, context)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const m of mentions) {
    stmt.run(issueId, m.tool_name, m.github_url, m.description, m.context);
  }
}

function updateMeta(db: DatabaseSync): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM issues').get() as { n: number };
  const count = row?.n ?? 0;
  const now = new Date().toISOString();
  const upsert = db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);
  upsert.run('last_updated', now);
  upsert.run('issue_count', String(count));
  upsert.run('schema_version', '1');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg: string): void {
  process.stdout.write(`[ingest] ${msg}\n`);
}

function inferIssueNumber(post: SubstackPost, index: number): number | null {
  // Look for "#N" patterns in the title
  const m = post.title.match(/#(\d+)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required for ingestion.');
  }

  log(`Database path: ${DB_PATH}`);
  log(`Mode: ${INCREMENTAL ? 'incremental' : SINGLE_ISSUE_ARG != null ? `single issue #${SINGLE_ISSUE_ARG}` : 'full'}`);

  const db = openDb();
  initSchema(db);

  const known = getKnownPostIds(db);
  log(`Known posts in DB: ${known.size}`);

  // ---- Fetch posts -------------------------------------------------------
  let posts: SubstackPost[];

  if (SINGLE_ISSUE_ARG != null) {
    // Fetch all pages and find the matching issue
    log('Fetching all posts to find target issue…');
    const all = await fetchAllPosts();
    const target = all.find(
      (p) => p.title.includes(`#${SINGLE_ISSUE_ARG}`) || known.size === 0
    );
    posts = target ? [target] : [];
    if (posts.length === 0) {
      log(`No post found matching issue #${SINGLE_ISSUE_ARG}`);
      return;
    }
  } else {
    posts = await fetchAllPosts();
    log(`Total posts from API: ${posts.length}`);
    if (INCREMENTAL) {
      posts = posts.filter((p) => !known.has(String(p.id)));
      log(`New posts to ingest: ${posts.length}`);
    }
  }

  if (posts.length === 0) {
    log('Nothing to ingest. Database is up to date.');
    updateMeta(db);
    return;
  }

  // ---- Process each post -------------------------------------------------
  let totalChunks = 0;

  for (let pi = 0; pi < posts.length; pi++) {
    const post = posts[pi];
    log(`[${pi + 1}/${posts.length}] "${post.title}"`);

    // Fetch full body if not included in the listing
    let fullPost = post;
    if (!post.body_html) {
      try {
        fullPost = await fetchPost(post.slug);
        await sleep(RATE_LIMIT_DELAY_MS);
      } catch (err) {
        log(`  ⚠ Failed to fetch body for "${post.slug}": ${err}`);
        continue;
      }
    }

    const issueNumber = inferIssueNumber(fullPost, pi);
    const issueId = upsertIssue(db, fullPost, issueNumber);

    const rawChunks = buildChunks(fullPost);
    if (rawChunks.length === 0) {
      log(`  ⚠ No chunks generated for this post. Skipping.`);
      continue;
    }

    log(`  → ${rawChunks.length} chunks`);

    // Embed in batches
    const texts = rawChunks.map((c) => c.text);
    const embeddings: Float32Array[] = [];

    for (let b = 0; b < texts.length; b += EMBEDDING_BATCH) {
      const batch = texts.slice(b, b + EMBEDDING_BATCH);
      log(`  Embedding batch ${Math.floor(b / EMBEDDING_BATCH) + 1}…`);
      const batchEmbeddings = await embedBatch(batch, apiKey);
      embeddings.push(...batchEmbeddings);
      await sleep(RATE_LIMIT_DELAY_MS);
    }

    // Store chunks + embeddings in a transaction
    db.exec('BEGIN');
    try {
      for (let ci = 0; ci < rawChunks.length; ci++) {
        const { section_heading, text } = rawChunks[ci];
        const chunkId = insertChunk(db, issueId, ci, section_heading, text);
        if (chunkId > 0) {
          insertVecChunk(db, chunkId, embeddings[ci]);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    totalChunks += rawChunks.length;

    // Extract and store tool mentions
    const toolMentions = extractToolMentions(fullPost.body_html ?? '', fullPost.title);
    if (toolMentions.length > 0) {
      log(`  → ${toolMentions.length} tool mention(s)`);
      insertToolMentions(db, issueId, toolMentions);
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  updateMeta(db);

  log(`Done. Ingested ${posts.length} posts, ${totalChunks} total chunks.`);
  log(`Database saved to: ${DB_PATH}`);

  db.close();
}

main().catch((err) => {
  process.stderr.write(`Ingestion failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';

const GITHUB_REPO = 'darrenjrobinson/EntraNewsMCPServer';
const DB_FILENAME = 'entra-news.db';
const META_FILENAME = 'release-meta.json';
const CACHE_DIR = path.join(os.homedir(), '.entra-news-mcp');
const DB_PATH = path.join(CACHE_DIR, DB_FILENAME);
const META_PATH = path.join(CACHE_DIR, META_FILENAME);

export interface SearchResult {
  chunk_id: number;
  text: string;
  section_heading: string | null;
  issue_number: number | null;
  title: string;
  published_at: string;
  url: string;
  distance: number;
}

export interface Issue {
  id: number;
  post_id: string;
  issue_number: number | null;
  title: string;
  subtitle: string | null;
  published_at: string;
  url: string;
  slug: string;
}

export interface Chunk {
  id: number;
  issue_id: number;
  chunk_index: number;
  section_heading: string | null;
  text: string;
}

export interface ToolMention {
  id: number;
  issue_id: number;
  issue_number: number | null;
  issue_title: string;
  published_at: string;
  issue_url: string;
  tool_name: string;
  github_url: string | null;
  description: string | null;
  context: string | null;
}

interface ReleaseMeta {
  tag: string;
  published_at: string;
  asset_url: string;
  checked_at: string;
}

// ---------------------------------------------------------------------------
// In-memory embedding cache for vector search
// ---------------------------------------------------------------------------
interface EmbeddingEntry {
  chunk_id: number;
  embedding: Float32Array;
  norm: number;
}

let db: DatabaseSync | null = null;
let embeddingCache: EmbeddingEntry[] = [];

function vecNorm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosineSimilarity(
  a: Float32Array, aNorm: number,
  b: Float32Array, bNorm: number
): number {
  if (aNorm === 0 || bNorm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'entra-news-mcp/0.1.0',
        Accept: 'application/json',
      },
    };
    client.get(url, options, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        if (res.headers.location) {
          resolve(fetchJson(res.headers.location));
          return;
        }
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: { 'User-Agent': 'entra-news-mcp/0.1.0' },
    };
    const file = fs.createWriteStream(dest + '.tmp');
    const request = client.get(url, options, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest + '.tmp');
        if (res.headers.location) {
          downloadFile(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(dest + '.tmp', dest);
          resolve();
        });
      });
    });
    request.on('error', (err) => {
      file.close();
      fs.unlink(dest + '.tmp', () => {});
      reject(err);
    });
    file.on('error', (err) => {
      file.close();
      fs.unlink(dest + '.tmp', () => {});
      reject(err);
    });
  });
}

async function getLatestRelease(): Promise<ReleaseMeta | null> {
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const release = (await fetchJson(apiUrl)) as {
      tag_name: string;
      published_at: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    const dbAsset = release.assets?.find((a) => a.name === DB_FILENAME);
    if (!dbAsset) return null;

    return {
      tag: release.tag_name,
      published_at: release.published_at,
      asset_url: dbAsset.browser_download_url,
      checked_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function loadCachedMeta(): ReleaseMeta | null {
  try {
    if (!fs.existsSync(META_PATH)) return null;
    return JSON.parse(fs.readFileSync(META_PATH, 'utf-8')) as ReleaseMeta;
  } catch {
    return null;
  }
}

function saveMeta(meta: ReleaseMeta): void {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf-8');
}

function isCheckStale(meta: ReleaseMeta): boolean {
  const checked = new Date(meta.checked_at);
  const now = new Date();
  const diffMs = now.getTime() - checked.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 1;
}

export async function initDb(): Promise<void> {
  // Allow a local DB path override — useful for development / testing
  const localOverride = process.env.ENTRA_NEWS_DB_PATH;
  if (localOverride) {
    if (!fs.existsSync(localOverride)) {
      throw new Error(`ENTRA_NEWS_DB_PATH points to a file that does not exist: ${localOverride}`);
    }
    process.stderr.write(`[entra-news-mcp] Using local database: ${localOverride}\n`);
    db = new DatabaseSync(localOverride);
    const rows = db.prepare('SELECT chunk_id, embedding FROM vec_embeddings').all() as Array<{ chunk_id: number; embedding: Buffer }>;
    embeddingCache = rows.map((r) => {
      const buf = Buffer.from(r.embedding);
      const embedding = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      return { chunk_id: r.chunk_id, embedding, norm: vecNorm(embedding) };
    });
    process.stderr.write(`[entra-news-mcp] Ready — ${embeddingCache.length} chunks indexed.\n`);
    return;
  }

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const dbExists = fs.existsSync(DB_PATH);
  const cached = loadCachedMeta();

  let shouldDownload = false;
  let latestMeta: ReleaseMeta | null = null;

  if (!dbExists) {
    process.stderr.write('[entra-news-mcp] No local database found. Downloading from GitHub Releases...\n');
    latestMeta = await getLatestRelease();
    shouldDownload = latestMeta !== null;
  } else if (!cached || isCheckStale(cached)) {
    process.stderr.write('[entra-news-mcp] Checking for database updates...\n');
    latestMeta = await getLatestRelease();
    if (latestMeta && cached && latestMeta.tag !== cached.tag) {
      process.stderr.write(`[entra-news-mcp] New version available: ${latestMeta.tag}. Updating...\n`);
      shouldDownload = true;
    } else if (latestMeta && !cached) {
      shouldDownload = true;
    } else if (latestMeta) {
      // Up to date — just refresh the check timestamp
      saveMeta({ ...latestMeta, checked_at: new Date().toISOString() });
    }
  }

  if (shouldDownload && latestMeta) {
    process.stderr.write(`[entra-news-mcp] Downloading ${DB_FILENAME} (${latestMeta.tag})...\n`);
    await downloadFile(latestMeta.asset_url, DB_PATH);
    saveMeta(latestMeta);
    process.stderr.write('[entra-news-mcp] Database downloaded.\n');
  } else if (!dbExists) {
    throw new Error(
      'No local database found and could not download from GitHub Releases. ' +
        'Please run the ingestion script first or check your internet connection.'
    );
  }

  db = new DatabaseSync(DB_PATH);

  // Load all embeddings into memory for fast cosine similarity search
  process.stderr.write('[entra-news-mcp] Loading embeddings into memory...\n');
  const rows = db
    .prepare('SELECT chunk_id, embedding FROM vec_embeddings')
    .all() as Array<{ chunk_id: number; embedding: Buffer }>;

  embeddingCache = rows.map((r) => {
    const buf = Buffer.from(r.embedding);
    const embedding = new Float32Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );
    const norm = vecNorm(embedding);
    return { chunk_id: r.chunk_id, embedding, norm };
  });

  process.stderr.write(`[entra-news-mcp] Ready — ${embeddingCache.length} chunks indexed.\n`);
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

export function semanticSearch(queryEmbedding: Float32Array, limit = 10): SearchResult[] {
  const database = getDb();
  const queryNorm = vecNorm(queryEmbedding);

  const scored = embeddingCache.map((e) => ({
    chunk_id: e.chunk_id,
    score: cosineSimilarity(queryEmbedding, queryNorm, e.embedding, e.norm),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topIds = scored.slice(0, limit);
  if (topIds.length === 0) return [];

  const placeholders = topIds.map(() => '?').join(',');
  const rows = database
    .prepare(
      `SELECT c.id AS chunk_id, c.text, c.section_heading,
              i.issue_number, i.title, i.published_at, i.url
       FROM chunks c JOIN issues i ON i.id = c.issue_id
       WHERE c.id IN (${placeholders})`
    )
    .all(...topIds.map((t) => t.chunk_id)) as Array<Omit<SearchResult, 'distance'>>;

  const scoreMap = new Map(topIds.map((t) => [t.chunk_id, t.score]));
  return rows
    .map((r) => ({ ...r, distance: 1 - (scoreMap.get(r.chunk_id) ?? 0) }))
    .sort((a, b) => a.distance - b.distance);
}

export function keywordSearch(query: string, limit = 10): SearchResult[] {
  const database = getDb();
  // Build LIKE patterns for each word in the query
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // Score chunks by counting how many query words appear in the text
  // First try to match the full phrase, then fall back to individual words
  const likePattern = `%${query}%`;
  const phraseRows = database
    .prepare(
      `SELECT c.id AS chunk_id, c.text, c.section_heading,
              i.issue_number, i.title, i.published_at, i.url
       FROM chunks c
       JOIN issues i ON i.id = c.issue_id
       WHERE c.text LIKE ? OR c.section_heading LIKE ?
       ORDER BY i.published_at DESC
       LIMIT ?`
    )
    .all(likePattern, likePattern, limit) as unknown as Array<Omit<SearchResult, 'distance'>>;

  if (phraseRows.length > 0) {
    return phraseRows.map((r, i) => ({ ...r, distance: i }));
  }

  // Fall back: match any individual word (OR semantics, ranked by match count)
  const wordConditions = words
    .map(() => `(c.text LIKE ? OR c.section_heading LIKE ?)`)
    .join(' OR ');
  const wordParams: string[] = [];
  for (const w of words) {
    wordParams.push(`%${w}%`, `%${w}%`);
  }
  wordParams.push(String(limit));

  const wordRows = database
    .prepare(
      `SELECT c.id AS chunk_id, c.text, c.section_heading,
              i.issue_number, i.title, i.published_at, i.url
       FROM chunks c
       JOIN issues i ON i.id = c.issue_id
       WHERE ${wordConditions}
       ORDER BY i.published_at DESC
       LIMIT ?`
    )
    .all(...wordParams) as unknown as Array<Omit<SearchResult, 'distance'>>;

  return wordRows.map((r, i) => ({ ...r, distance: i }));
}

export function getIssueByNumber(issueNumber: number): Issue | null {
  return (
    (getDb()
      .prepare('SELECT * FROM issues WHERE issue_number = ? LIMIT 1')
      .get(issueNumber) as Issue | undefined) ?? null
  );
}

export function getIssueByDate(dateStr: string): Issue | null {
  return (
    (getDb()
      .prepare(
        'SELECT * FROM issues WHERE published_at LIKE ? ORDER BY published_at ASC LIMIT 1'
      )
      .get(`${dateStr}%`) as Issue | undefined) ?? null
  );
}

export function getIssueById(id: number): Issue | null {
  return (
    (getDb().prepare('SELECT * FROM issues WHERE id = ? LIMIT 1').get(id) as Issue | undefined) ?? null
  );
}

export function getChunksForIssue(issueId: number): Chunk[] {
  return getDb()
    .prepare('SELECT * FROM chunks WHERE issue_id = ? ORDER BY chunk_index')
    .all(issueId) as unknown as Chunk[];
}

export function listIssues(opts: { year?: number; month?: number; limit?: number; offset?: number } = {}): Issue[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.year) {
    conditions.push("strftime('%Y', published_at) = ?");
    params.push(String(opts.year));
  }
  if (opts.month) {
    conditions.push("strftime('%m', published_at) = ?");
    params.push(String(opts.month).padStart(2, '0'));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  return getDb()
    .prepare(`SELECT * FROM issues ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as unknown as Issue[];
}

export function findToolMentions(query?: string, limit = 20): ToolMention[] {
  const database = getDb();

  if (query) {
    const like = `%${query}%`;
    const fromTable = database
      .prepare(
        `SELECT t.*, i.issue_number, i.title AS issue_title, i.published_at, i.url AS issue_url
         FROM tool_mentions t
         JOIN issues i ON i.id = t.issue_id
         WHERE t.tool_name LIKE ? OR t.description LIKE ? OR t.github_url LIKE ? OR t.context LIKE ?
         ORDER BY i.published_at DESC
         LIMIT ?`
      )
      .all(like, like, like, like, limit) as unknown as ToolMention[];

    if (fromTable.length > 0) return fromTable;

    // Fallback: search chunk text for the query term and synthesise mentions
    const fromChunks = database
      .prepare(
        `SELECT c.id, c.text, c.section_heading, i.id AS issue_id, i.issue_number,
                i.title AS issue_title, i.published_at, i.url AS issue_url
         FROM chunks c
         JOIN issues i ON i.id = c.issue_id
         WHERE c.text LIKE ?
         GROUP BY i.id
         ORDER BY i.published_at DESC
         LIMIT ?`
      )
      .all(like, limit) as unknown as Array<{
        id: number;
        text: string;
        section_heading: string | null;
        issue_id: number;
        issue_number: number | null;
        issue_title: string;
        published_at: string;
        issue_url: string;
      }>;

    return fromChunks.map((row) => {
      // Extract ~200 chars around the first match as context
      const lower = row.text.toLowerCase();
      const qi = lower.indexOf(query.toLowerCase());
      const start = Math.max(0, qi - 100);
      const end = Math.min(row.text.length, qi + query.length + 100);
      const context = (qi >= 0 ? '...' + row.text.slice(start, end).replace(/\s+/g, ' ').trim() + '...' : row.text.slice(0, 200));

      return {
        id: -(row.id),           // negative = synthetic (from chunks, not tool_mentions)
        issue_id: row.issue_id,
        issue_number: row.issue_number,
        issue_title: row.issue_title,
        published_at: row.published_at,
        issue_url: row.issue_url,
        tool_name: query.replace(/\b\w/g, (c) => c.toUpperCase()),
        github_url: null,
        description: null,
        context: context.slice(0, 500),
      } satisfies ToolMention;
    });
  }

  return database
    .prepare(
      `SELECT t.*, i.issue_number, i.title AS issue_title, i.published_at, i.url AS issue_url
       FROM tool_mentions t
       JOIN issues i ON i.id = t.issue_id
       ORDER BY i.published_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as ToolMention[];
}

export function getDbMeta(): Record<string, string> {
  try {
    const rows = getDb().prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

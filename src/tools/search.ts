import { z } from 'zod';
import { semanticSearch, keywordSearch, SearchResult } from '../db/client.js';
import { getEmbedding } from '../utils/embeddings.js';

export const searchSchema = z.object({
  query: z.string().min(1).describe('Natural language question or keywords to search for'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of results to return'),
  mode: z
    .enum(['hybrid', 'semantic', 'keyword'])
    .default('hybrid')
    .describe('Search mode: hybrid (default), semantic-only, or keyword-only'),
});

type SearchArgs = z.infer<typeof searchSchema>;

function formatResult(r: SearchResult, rank: number): string {
  const issueRef = r.issue_number != null ? `Issue #${r.issue_number}` : 'Issue';
  const date = new Date(r.published_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const heading = r.section_heading ? ` › ${r.section_heading}` : '';
  return [
    `**[${rank}] ${r.title}${heading}**`,
    `${issueRef} · ${date}`,
    `URL: ${r.url}`,
    '',
    r.text.trim(),
  ].join('\n');
}

function deduplicateAndMerge(
  semantic: SearchResult[],
  keyword: SearchResult[],
  limit: number
): SearchResult[] {
  const seen = new Set<number>();
  const merged: SearchResult[] = [];

  // Interleave results, prioritising semantic
  const maxLen = Math.max(semantic.length, keyword.length);
  for (let i = 0; i < maxLen && merged.length < limit; i++) {
    if (i < semantic.length && !seen.has(semantic[i].chunk_id)) {
      seen.add(semantic[i].chunk_id);
      merged.push(semantic[i]);
    }
    if (i < keyword.length && !seen.has(keyword[i].chunk_id) && merged.length < limit) {
      seen.add(keyword[i].chunk_id);
      merged.push(keyword[i]);
    }
  }
  return merged.slice(0, limit);
}

export async function handleSearchEntraNews(args: SearchArgs): Promise<string> {
  const { query, limit, mode } = args;
  const apiKey = process.env.OPENAI_API_KEY;

  let semanticResults: SearchResult[] = [];
  let keywordResults: SearchResult[] = [];

  if (mode !== 'keyword' && apiKey) {
    try {
      const embedding = await getEmbedding(query, apiKey);
      semanticResults = semanticSearch(embedding, limit);
    } catch (err) {
      process.stderr.write(`[entra-news-mcp] Semantic search failed, falling back to keyword: ${err}\n`);
    }
  }

  if (mode !== 'semantic') {
    keywordResults = keywordSearch(query, limit);
  }

  if (semanticResults.length === 0 && keywordResults.length === 0) {
    return `No results found for "${query}". Try different keywords or a broader query.`;
  }

  let results: SearchResult[];
  if (mode === 'semantic') {
    results = semanticResults.slice(0, limit);
  } else if (mode === 'keyword') {
    results = keywordResults.slice(0, limit);
  } else {
    results = deduplicateAndMerge(semanticResults, keywordResults, limit);
  }

  const modeNote =
    mode === 'hybrid' && !apiKey
      ? '\n> *(Keyword-only mode — set OPENAI_API_KEY for semantic search)*\n'
      : '';
  const header = `## Search results for: "${query}"\n${modeNote}\nFound ${results.length} result(s):\n\n---\n\n`;

  const body = results.map((r, i) => formatResult(r, i + 1)).join('\n\n---\n\n');
  return header + body;
}

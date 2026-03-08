import { z } from 'zod';
import { findToolMentions, ToolMention } from '../db/client.js';

export const findToolMentionsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Optional search query — filter by tool name, technology, or description keyword'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of tool mentions to return'),
});

type FindToolMentionsArgs = z.infer<typeof findToolMentionsSchema>;

function formatToolMention(t: ToolMention, rank: number): string {
  const date = new Date(t.published_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const issueRef = t.issue_number != null ? `Issue #${t.issue_number}` : 'Entra.news';
  // id < 0 means this is a synthetic result from chunk fallback, not a proper tool_mentions row
  const isSynthetic = t.id < 0;
  const typeTag = t.github_url
    ? '🔧 Open-source tool'
    : isSynthetic
    ? '📄 Content mention'
    : '📌 Microsoft resource';
  const githubLine = t.github_url ? `\n**GitHub:** ${t.github_url}` : '';
  const descLine = t.description ? `\n**Description:** ${t.description}` : '';
  const contextLine = t.context ? `\n**Context:** ${t.context}` : '';

  return [
    `**[${rank}] ${t.tool_name}** · ${typeTag}`,
    `Mentioned in: [${t.issue_title}](${t.issue_url}) · ${issueRef} · ${date}`,
    githubLine,
    descLine,
    contextLine,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function handleFindToolMentions(args: FindToolMentionsArgs): string {
  const { query, limit } = args;
  const mentions = findToolMentions(query, limit);

  if (mentions.length === 0) {
    const qualifier = query ? ` mentioning "${query}"` : '';
    return `No content found${qualifier} in the archive.`;
  }

  const hasSynthetic = mentions.some((m) => m.id < 0);
  const header = query
    ? `## Entra.news mentions of "${query}"\n\n` +
      (hasSynthetic
        ? `_(No GitHub/Microsoft tool entries matched — showing issues where this term appears in content.)_\n\n`
        : '') +
      `Found ${mentions.length} result(s):\n\n---\n\n`
    : `## Community Tools Mentioned in Entra.news\n\n${mentions.length} mention(s):\n\n---\n\n`;

  const body = mentions.map((t, i) => formatToolMention(t, i + 1)).join('\n\n---\n\n');
  return header + body;
}

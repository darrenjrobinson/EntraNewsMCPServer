import { z } from 'zod';
import {
  getIssueByNumber,
  getIssueByDate,
  getChunksForIssue,
  Issue,
} from '../db/client.js';

export const getIssueSchema = z.object({
  issue_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Issue number (e.g. 42)'),
  date: z
    .string()
    .optional()
    .describe('Date in YYYY-MM-DD or YYYY-MM format to find the nearest issue'),
});

type GetIssueArgs = z.infer<typeof getIssueSchema>;

function formatIssue(issue: Issue, fullText: string): string {
  const date = new Date(issue.published_at).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const issueRef = issue.issue_number != null ? `Issue #${issue.issue_number}` : 'Entra.news';
  const subtitle = issue.subtitle ? `\n*${issue.subtitle}*` : '';

  return [
    `## ${issueRef}: ${issue.title}`,
    subtitle,
    '',
    `**Published:** ${date}`,
    `**URL:** ${issue.url}`,
    '',
    '---',
    '',
    fullText,
  ].join('\n');
}

export function handleGetIssue(args: GetIssueArgs): string {
  if (args.issue_number == null && !args.date) {
    return 'Please provide either an issue_number or a date to look up.';
  }

  let issue: Issue | null = null;

  if (args.issue_number != null) {
    issue = getIssueByNumber(args.issue_number);
    if (!issue) {
      return `Issue #${args.issue_number} not found in the archive.`;
    }
  } else if (args.date) {
    issue = getIssueByDate(args.date);
    if (!issue) {
      return `No issue found for date "${args.date}". Try a broader date range (e.g. just the year-month like "2024-03").`;
    }
  }

  if (!issue) return 'Issue not found.';

  const chunks = getChunksForIssue(issue.id);
  const fullText = chunks
    .map((c) => {
      const heading = c.section_heading ? `### ${c.section_heading}\n\n` : '';
      return `${heading}${c.text.trim()}`;
    })
    .join('\n\n');

  return formatIssue(issue, fullText || '*No content available for this issue.*');
}

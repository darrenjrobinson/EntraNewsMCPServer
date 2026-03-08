import { z } from 'zod';
import { listIssues, getDbMeta, Issue } from '../db/client.js';

export const listIssuesSchema = z.object({
  year: z
    .number()
    .int()
    .min(2023)
    .max(2030)
    .optional()
    .describe('Filter by year (e.g. 2024)'),
  month: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe('Filter by month number (1–12). Requires year to be set.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum issues to return'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pagination offset'),
});

type ListIssuesArgs = z.infer<typeof listIssuesSchema>;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatIssueRow(issue: Issue): string {
  const date = new Date(issue.published_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const issueRef = issue.issue_number != null ? `#${String(issue.issue_number).padStart(3, ' ')}` : '   ';
  const subtitle = issue.subtitle ? ` — ${issue.subtitle.slice(0, 80)}` : '';
  return `${issueRef}  ${date.padEnd(12)}  [${issue.title}](${issue.url})${subtitle}`;
}

export function handleListIssues(args: ListIssuesArgs): string {
  const { year, month, limit, offset } = args;

  const issues = listIssues({ year, month, limit, offset });
  const meta = getDbMeta();

  if (issues.length === 0) {
    const filter = [year, month ? MONTH_NAMES[month - 1] : null].filter(Boolean).join(' ');
    return `No issues found${filter ? ` for ${filter}` : ''}.`;
  }

  const filterDesc = [
    month ? MONTH_NAMES[month - 1] : null,
    year ? String(year) : null,
  ]
    .filter(Boolean)
    .join(' ');

  const totalNote = meta.issue_count ? ` (${meta.issue_count} total in archive)` : '';
  const paginationNote =
    offset > 0 || issues.length === limit
      ? `\nShowing ${offset + 1}–${offset + issues.length}${totalNote}`
      : `\n${issues.length} issue(s)${totalNote}`;

  const header = `## Entra.news Archive${filterDesc ? ` — ${filterDesc}` : ''}${paginationNote}\n\n`;
  const lastUpdated = meta.last_updated
    ? `*Last updated: ${new Date(meta.last_updated).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}*\n\n`
    : '';

  const rows = issues.map(formatIssueRow).join('\n');
  return `${header}${lastUpdated}\`\`\`\n${rows}\n\`\`\``;
}

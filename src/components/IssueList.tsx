import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getStatusIcon, getStatusColor } from '../issues/lifecycle.js';
import type { Issue } from '../issues/parser.js';

interface IssueListProps {
  issues: Issue[];
  selectedIndex: number;
  focused: boolean;
}

// Fixed height: border(2) + header(1) = 3 overhead, leave 1 row for issues in compact mode
const VISIBLE_ROWS = 2;

export function IssueList({ issues, selectedIndex, focused }: IssueListProps) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const inProgress = issues.filter(i => i.status === 'in_progress');

  // Calculate how many issues fit per row based on terminal width
  // Each issue label: icon(1) + space(1) + #(1) + id(3) + space(1) + title(24) + space(1) + [status](~13) ≈ 45 chars + gap(2)
  const itemWidth = 47;
  const usableWidth = termWidth - 4; // border(2) + paddingX(2)
  const perRow = Math.max(1, Math.floor(usableWidth / itemWidth));

  // Determine which rows to show based on selected index
  const visibleIssues = useMemo(() => {
    if (issues.length === 0) return [];

    const selectedRow = Math.floor(selectedIndex / perRow);
    const totalRows = Math.ceil(issues.length / perRow);

    // Window of VISIBLE_ROWS rows centered on selected row
    let startRow = Math.max(0, selectedRow - Math.floor(VISIBLE_ROWS / 2));
    if (startRow + VISIBLE_ROWS > totalRows) {
      startRow = Math.max(0, totalRows - VISIBLE_ROWS);
    }
    const endRow = Math.min(totalRows, startRow + VISIBLE_ROWS);

    const startIdx = startRow * perRow;
    const endIdx = Math.min(issues.length, endRow * perRow);

    return issues.slice(startIdx, endIdx);
  }, [issues, selectedIndex, perRow]);

  const totalRows = Math.ceil(issues.length / perRow);
  const hasMore = totalRows > VISIBLE_ROWS;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} height={VISIBLE_ROWS + 3} overflow="hidden">
      <Box>
        <Text bold color={focused ? 'cyan' : 'white'}> Issues </Text>
        {inProgress.length > 0 && (
          <Text dimColor>
            {' '}| Worktrees: {inProgress.map(i => `${i.id}-${i.slug}`).join(', ')}
          </Text>
        )}
        {hasMore && focused && (
          <Text dimColor> [{selectedIndex + 1}/{issues.length}]</Text>
        )}
      </Box>

      <Box flexDirection="row" gap={2} flexWrap="wrap" overflow="hidden">
        {issues.length === 0 ? (
          <Text dimColor>No issues yet</Text>
        ) : (
          visibleIssues.map((issue) => {
            const idx = issues.indexOf(issue);
            return (
              <Text
                key={issue.id}
                color={idx === selectedIndex ? 'cyan' : getStatusColor(issue.status)}
                inverse={idx === selectedIndex && focused}
              >
                {getStatusIcon(issue.status)} #{issue.id} {issue.title.substring(0, 24)} [{issue.status}]
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}

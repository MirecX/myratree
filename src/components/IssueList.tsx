import React from 'react';
import { Box, Text } from 'ink';
import { getStatusIcon, getStatusColor } from '../issues/lifecycle.js';
import type { Issue } from '../issues/parser.js';

interface IssueListProps {
  issues: Issue[];
  selectedIndex: number;
  focused: boolean;
}

export function IssueList({ issues, selectedIndex, focused }: IssueListProps) {
  const inProgress = issues.filter(i => i.status === 'in_progress');

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} paddingX={1}>
      <Box>
        <Text bold color={focused ? 'cyan' : 'white'}> Issues </Text>
        {inProgress.length > 0 && (
          <Text dimColor>
            {' '}| Worktrees: {inProgress.map(i => `${i.id}-${i.slug}`).join(', ')}
          </Text>
        )}
      </Box>

      <Box flexDirection="row" gap={2} flexWrap="wrap">
        {issues.length === 0 ? (
          <Text dimColor>No issues yet</Text>
        ) : (
          issues.map((issue, i) => (
            <Text
              key={issue.id}
              color={i === selectedIndex ? 'cyan' : getStatusColor(issue.status)}
              inverse={i === selectedIndex && focused}
            >
              {getStatusIcon(issue.status)} #{issue.id} {issue.title.substring(0, 24)} [{issue.status}]
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

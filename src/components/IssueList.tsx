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
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} width={28} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={focused ? 'cyan' : 'white'}> Issues </Text>
      </Box>

      {issues.length === 0 ? (
        <Text dimColor>No issues yet</Text>
      ) : (
        issues.map((issue, i) => (
          <Box key={issue.id}>
            <Text
              color={i === selectedIndex ? 'cyan' : getStatusColor(issue.status)}
              inverse={i === selectedIndex && focused}
            >
              {' '}{getStatusIcon(issue.status)} #{issue.id} {issue.title.substring(0, 16)}
            </Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text bold dimColor> Worktrees </Text>
      </Box>
      {issues.filter(i => i.status === 'in_progress').map(issue => (
        <Box key={issue.id} flexDirection="column">
          <Text dimColor> {issue.id}-{issue.slug}</Text>
          <Text dimColor>  {issue.branch}</Text>
        </Box>
      ))}
    </Box>
  );
}

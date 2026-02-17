import React from 'react';
import { Box, Text, useInput } from 'ink';

interface DiffViewProps {
  title: string;
  content: string;
  onClose: () => void;
}

export function DiffView({ title, content, onClose }: DiffViewProps) {
  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onClose();
    }
  });

  const lines = content.split('\n');

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      position="absolute"
      marginTop={2}
      marginLeft={4}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="yellow"> {title} </Text>
        <Text dimColor>Press q or Esc to close</Text>
      </Box>

      <Box flexDirection="column" height={20} overflow="hidden">
        {lines.slice(0, 40).map((line, i) => {
          let color: string | undefined;
          if (line.startsWith('+')) color = 'green';
          else if (line.startsWith('-')) color = 'red';
          else if (line.startsWith('@@')) color = 'cyan';
          else if (line.startsWith('diff') || line.startsWith('index')) color = 'yellow';

          return (
            <Text key={i} color={color}>
              {line}
            </Text>
          );
        })}
        {lines.length > 40 && (
          <Text dimColor>... {lines.length - 40} more lines</Text>
        )}
      </Box>
    </Box>
  );
}

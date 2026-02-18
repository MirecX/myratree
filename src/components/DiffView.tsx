import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

interface DiffViewProps {
  title: string;
  content: string;
  onClose: () => void;
}

export function DiffView({ title, content, onClose }: DiffViewProps) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const { stdout } = useStdout();
  const termHeight = (stdout?.rows ?? 24) - 6; // Reserve for border + header + footer

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setScrollOffset(prev => Math.max(0, prev - 1));
    }
    if (key.downArrow) {
      setScrollOffset(prev => Math.min(Math.max(0, lines.length - termHeight), prev + 1));
    }
    if (key.pageUp) {
      setScrollOffset(prev => Math.max(0, prev - 10));
    }
    if (key.pageDown) {
      setScrollOffset(prev => Math.min(Math.max(0, lines.length - termHeight), prev + 10));
    }
  });

  const lines = content.split('\n');
  const visibleLines = lines.slice(scrollOffset, scrollOffset + termHeight);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} width="100%" height="100%">
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="yellow"> {title} </Text>
        <Text dimColor>q/Esc=close  ↑↓=scroll  PgUp/PgDn=page</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {visibleLines.length === 0 ? (
          <Text dimColor>No content to display.</Text>
        ) : (
          visibleLines.map((line, i) => {
            let color: string | undefined;
            if (line.startsWith('+')) color = 'green';
            else if (line.startsWith('-')) color = 'red';
            else if (line.startsWith('@@')) color = 'cyan';
            else if (line.startsWith('diff') || line.startsWith('index')) color = 'yellow';

            return (
              <Text key={scrollOffset + i} color={color}>
                {line}
              </Text>
            );
          })
        )}
      </Box>

      <Box justifyContent="space-between">
        <Text dimColor>
          Line {scrollOffset + 1}-{Math.min(scrollOffset + termHeight, lines.length)} of {lines.length}
        </Text>
        {scrollOffset > 0 && <Text dimColor>↑ more above</Text>}
        {scrollOffset + termHeight < lines.length && <Text dimColor>↓ more below</Text>}
      </Box>
    </Box>
  );
}

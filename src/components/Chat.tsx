import React, { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ChatInput } from './ChatInput.js';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

interface ChatProps {
  messages: ChatMessage[];
  focused: boolean;
  onSend: (message: string) => void;
  isLoading: boolean;
  awaitingInput?: boolean;
}

export function Chat({ messages, focused, onSend, isLoading, awaitingInput }: ChatProps) {
  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const { stdout } = useStdout();
  const [termHeight, setTermHeight] = useState(stdout?.rows ?? 24);

  // Track terminal resize and reset scroll to bottom
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setTermHeight(stdout.rows);
      setScrollOffset(0);
    };
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  const handleSubmit = (value: string) => {
    if (value.trim() && (!isLoading || awaitingInput)) {
      onSend(value.trim());
      setInput('');
    }
  };

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    setScrollOffset(0);
  }, [messages.length]);

  // Reserve lines: border(2) + header(2) + input box(3) + agent status bar(~4) + buffer(1)
  const reservedLines = 12;
  const availableLines = Math.max(4, termHeight - reservedLines);

  // Calculate visible window with scroll offset
  const { visibleMessages, canScrollUp, canScrollDown } = useMemo(() => {
    // First figure out how many messages fit in a window
    const windowMessages = (startFromEnd: number): ChatMessage[] => {
      let lineCount = isLoading && startFromEnd === 0 ? 1 : 0;
      const result: ChatMessage[] = [];
      const endIdx = messages.length - startFromEnd;

      for (let i = endIdx - 1; i >= 0; i--) {
        const msg = messages[i];
        const contentLines = msg.content.split('\n').length;
        const msgLines = 1 + contentLines + 1;

        if (lineCount + msgLines > availableLines && result.length > 0) break;
        lineCount += msgLines;
        result.unshift(msg);
      }
      return result;
    };

    const visible = windowMessages(scrollOffset);
    const canUp = scrollOffset < messages.length - 1 && visible[0] !== messages[0];
    const canDown = scrollOffset > 0;

    return { visibleMessages: visible, canScrollUp: canUp, canScrollDown: canDown };
  }, [messages, availableLines, isLoading, scrollOffset]);

  // Scroll with PageUp/PageDown — only handle scroll keys, don't swallow others
  useInput((_input, key) => {
    if (!focused) return;
    if (key.pageUp) {
      setScrollOffset(prev => Math.min(prev + 5, Math.max(0, messages.length - 1)));
    } else if (key.pageDown) {
      setScrollOffset(prev => Math.max(0, prev - 5));
    }
  }, { isActive: focused });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} flexGrow={1} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={focused ? 'cyan' : 'white'}> Chat </Text>
        {canScrollUp && <Text dimColor> [Shift+Up for more]</Text>}
        {scrollOffset > 0 && <Text color="yellow"> [scrolled +{scrollOffset}]</Text>}
      </Box>

      <Box flexDirection="column" height={availableLines} overflow="hidden">
        {visibleMessages.map((msg, i) => (
          <Box key={i} marginBottom={1} flexDirection="column">
            <Text bold color={msg.role === 'user' ? 'green' : msg.role === 'system' ? 'yellow' : 'blue'}>
              {msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'Novatree'}:
            </Text>
            <Text wrap="wrap">{msg.content}</Text>
          </Box>
        ))}

        {isLoading && !awaitingInput && scrollOffset === 0 && (
          <Box>
            <Text color="yellow">Thinking...</Text>
          </Box>
        )}
      </Box>

      <Box borderStyle="round" borderColor={focused ? 'green' : 'gray'} paddingX={1}>
        <Text color="green">&gt; </Text>
        {focused ? (
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            focus={focused}
            placeholder={awaitingInput ? 'y/n to approve or deny...' : isLoading ? 'Waiting for response...' : 'Type a message...'}
          />
        ) : (
          <Text dimColor>{input || 'Press Tab to focus chat'}</Text>
        )}
      </Box>
    </Box>
  );
}

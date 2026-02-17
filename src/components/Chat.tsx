import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

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
}

export function Chat({ messages, focused, onSend, isLoading }: ChatProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (value: string) => {
    if (value.trim() && !isLoading) {
      onSend(value.trim());
      setInput('');
    }
  };

  // Show last N messages that fit
  const visibleMessages = messages.slice(-20);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} flexGrow={1} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={focused ? 'cyan' : 'white'}> Chat </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map((msg, i) => (
          <Box key={i} marginBottom={1} flexDirection="column">
            <Text bold color={msg.role === 'user' ? 'green' : msg.role === 'system' ? 'yellow' : 'blue'}>
              {msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'Novatree'}:
            </Text>
            <Text wrap="wrap">{msg.content}</Text>
          </Box>
        ))}

        {isLoading && (
          <Box>
            <Text color="yellow">Thinking...</Text>
          </Box>
        )}
      </Box>

      <Box borderStyle="round" borderColor={focused ? 'green' : 'gray'} paddingX={1}>
        <Text color="green">&gt; </Text>
        {focused ? (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder={isLoading ? 'Waiting for response...' : 'Type a message...'}
          />
        ) : (
          <Text dimColor>{input || 'Press Tab to focus chat'}</Text>
        )}
      </Box>
    </Box>
  );
}

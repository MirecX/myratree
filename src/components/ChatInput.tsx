import React, { useState, useEffect } from 'react';
import { Text, useInput } from 'ink';
import chalk from 'chalk';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focus: boolean;
  placeholder?: string;
}

export function ChatInput({ value, onChange, onSubmit, focus, placeholder = '' }: ChatInputProps) {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Keep cursor in bounds when value changes externally
  useEffect(() => {
    setCursorOffset(prev => Math.min(prev, value.length));
  }, [value]);

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) return;
    if (key.ctrl && input === 'c') return;

    if (key.return) {
      onSubmit(value);
      return;
    }

    // Home / Ctrl+A — move to start
    if ((key.ctrl && input === 'a') || (key.meta && input === 'a')) {
      setCursorOffset(0);
      return;
    }

    // End / Ctrl+E — move to end
    if ((key.ctrl && input === 'e') || (key.meta && input === 'e')) {
      setCursorOffset(value.length);
      return;
    }

    // Ctrl+U — clear line before cursor
    if (key.ctrl && input === 'u') {
      onChange(value.slice(cursorOffset));
      setCursorOffset(0);
      return;
    }

    // Ctrl+K — clear line after cursor
    if (key.ctrl && input === 'k') {
      onChange(value.slice(0, cursorOffset));
      return;
    }

    // Ctrl+W — delete word before cursor
    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursorOffset);
      const trimmed = before.replace(/\s+$/, '');
      const lastSpace = trimmed.lastIndexOf(' ');
      const newOffset = lastSpace === -1 ? 0 : lastSpace + 1;
      onChange(value.slice(0, newOffset) + value.slice(cursorOffset));
      setCursorOffset(newOffset);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset(prev => Math.max(0, prev - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset(prev => Math.min(value.length, prev + 1));
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const next = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        onChange(next);
        setCursorOffset(prev => prev - 1);
      }
      return;
    }

    // Regular input or paste (input can be multiple characters for paste)
    if (input) {
      const next = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
      onChange(next);
      setCursorOffset(prev => prev + input.length);
    }
  }, { isActive: focus });

  // Render value with cursor
  if (!focus) {
    return <Text>{value || chalk.grey(placeholder)}</Text>;
  }

  if (value.length === 0) {
    if (placeholder) {
      return <Text>{chalk.inverse(placeholder[0])}{chalk.grey(placeholder.slice(1))}</Text>;
    }
    return <Text>{chalk.inverse(' ')}</Text>;
  }

  let rendered = '';
  for (let i = 0; i < value.length; i++) {
    rendered += i === cursorOffset ? chalk.inverse(value[i]) : value[i];
  }
  if (cursorOffset === value.length) {
    rendered += chalk.inverse(' ');
  }

  return <Text>{rendered}</Text>;
}

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function readMarkdown(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

export function writeMarkdown(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function appendMarkdown(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const existing = readMarkdown(path);
  writeFileSync(path, existing + content, 'utf-8');
}

export function extractMetadataField(content: string, field: string): string | undefined {
  const regex = new RegExp(`^- \\*\\*${field}\\*\\*:\\s*(.+)$`, 'm');
  const match = content.match(regex);
  return match?.[1]?.trim();
}

export function setMetadataField(content: string, field: string, value: string): string {
  const regex = new RegExp(`^(- \\*\\*${field}\\*\\*:\\s*)(.+)$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `$1${value}`);
  }
  return content;
}

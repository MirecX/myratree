import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let logFile: string | null = null;
let minLevel: LogLevel = 'info';

export function initLogger(myratreeDir: string, level: LogLevel = 'info') {
  mkdirSync(myratreeDir, { recursive: true });
  logFile = join(myratreeDir, 'myratree.log');
  minLevel = level;
}

export function log(level: LogLevel, component: string, message: string, data?: unknown) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...(data !== undefined ? { data } : {}),
  };

  if (logFile) {
    try {
      appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch {
      // Silently fail if we can't write to log
    }
  }
}

export const logger = {
  debug: (component: string, message: string, data?: unknown) => log('debug', component, message, data),
  info: (component: string, message: string, data?: unknown) => log('info', component, message, data),
  warn: (component: string, message: string, data?: unknown) => log('warn', component, message, data),
  error: (component: string, message: string, data?: unknown) => log('error', component, message, data),
};

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface LlmEndpoint {
  name: string;
  url: string;
  apiType: 'anthropic';
  weight: number;
  maxConcurrent: number;
}

export interface LlmConfig {
  endpoints: LlmEndpoint[];
  healthCheckIntervalMs: number;
  contextSize: number;
  model: string;
  debugLog: boolean;
}

export interface ManagerConfig {
  systemPromptFile: string;
  yoloMode: boolean;
}

export interface WorkerConfig {
  claudeCodePath: string;
  maxConcurrent: number;
  testCommand: string;
  buildCommand: string;
}

export interface ProjectConfig {
  specsDir: string;
  mainBranch: string;
}

export interface MyratreeConfig {
  llm: LlmConfig;
  manager: ManagerConfig;
  worker: WorkerConfig;
  project: ProjectConfig;
}

export function defaultConfig(): MyratreeConfig {
  return {
    llm: {
      endpoints: [
        {
          name: 'local',
          url: 'http://localhost:11434',
          apiType: 'anthropic',
          weight: 1,
          maxConcurrent: 1,
        },
      ],
      healthCheckIntervalMs: 30000,
      contextSize: 81920,
      model: 'qwen2.5-coder-32b',
      debugLog: false,
    },
    manager: {
      systemPromptFile: '.myratree/manager-system.md',
      yoloMode: false,
    },
    worker: {
      claudeCodePath: 'claude',
      maxConcurrent: 1,
      testCommand: 'npm test',
      buildCommand: 'npm run build',
    },
    project: {
      specsDir: 'specs/',
      mainBranch: 'master',
    },
  };
}

export function configPath(projectRoot: string): string {
  return join(projectRoot, '.myratree', 'config.json');
}

export function loadConfig(projectRoot: string): MyratreeConfig {
  const path = configPath(projectRoot);
  if (!existsSync(path)) {
    return defaultConfig();
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<MyratreeConfig>;
  const defaults = defaultConfig();
  return {
    llm: { ...defaults.llm, ...parsed.llm },
    manager: { ...defaults.manager, ...parsed.manager },
    worker: { ...defaults.worker, ...parsed.worker },
    project: { ...defaults.project, ...parsed.project },
  };
}

export function saveConfig(projectRoot: string, config: MyratreeConfig): void {
  const path = configPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.myratree'))) {
      return dir;
    }
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

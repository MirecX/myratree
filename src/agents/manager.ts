import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { NovatreeConfig } from '../core/config.js';
import type { Message, ContentBlock, ToolDefinition, LlmRequest, StreamEvent } from '../llm/types.js';
import type { LlmRouter } from '../llm/router.js';
import { IssueTracker } from '../issues/tracker.js';
import { createWorktree, mergeWorktree, getWorktreeDiff, removeWorktree, worktreePath } from '../core/git.js';
import { Worker, type WorkerState } from './worker.js';
import { logger } from '../utils/logger.js';

export interface ManagerEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'worker_update';
  content: string;
  data?: unknown;
}

type ManagerEventCallback = (event: ManagerEvent) => void;

const MANAGER_TOOLS: ToolDefinition[] = [
  {
    name: 'create_issue',
    description: 'Create a new issue in the tracker',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title' },
        description: { type: 'string', description: 'Detailed description' },
        specs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Spec file paths (e.g., specs/auth-flow.md)',
        },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority level' },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Acceptance criteria items',
        },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'list_issues',
    description: 'List all issues, optionally filtered by status',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done', 'blocked'] },
      },
    },
  },
  {
    name: 'spawn_worker',
    description: 'Start a worker agent on an issue. Creates a git worktree and spawns Claude Code.',
    input_schema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Issue ID (e.g., "001")' },
      },
      required: ['issue_id'],
    },
  },
  {
    name: 'review_diff',
    description: 'Get the git diff for a completed issue worktree',
    input_schema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Issue ID' },
      },
      required: ['issue_id'],
    },
  },
  {
    name: 'merge_issue',
    description: 'Merge a completed issue branch to main and clean up',
    input_schema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Issue ID' },
      },
      required: ['issue_id'],
    },
  },
  {
    name: 'run_tests',
    description: 'Run the test command in a worktree',
    input_schema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Issue ID of the worktree to test' },
      },
      required: ['issue_id'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the project',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
      },
      required: ['path'],
    },
  },
];

export class Manager {
  private messages: Message[] = [];
  private tracker: IssueTracker;
  private workers: Map<string, Worker> = new Map();
  private eventCallback: ManagerEventCallback | null = null;
  private historyPath: string;
  private managerMdPath: string;
  private systemPrompt: string = '';

  constructor(
    private projectRoot: string,
    private config: NovatreeConfig,
    private router: LlmRouter,
  ) {
    this.tracker = new IssueTracker(projectRoot);
    this.historyPath = join(projectRoot, '.novatree', 'manager-history.jsonl');
    this.managerMdPath = join(projectRoot, '.novatree', 'manager.md');
  }

  onEvent(callback: ManagerEventCallback): void {
    this.eventCallback = callback;
  }

  private emit(event: ManagerEvent): void {
    this.eventCallback?.(event);
  }

  async initialize(): Promise<void> {
    // Load system prompt
    const systemPromptPath = join(this.projectRoot, this.config.manager.systemPromptFile);
    const systemTemplate = existsSync(systemPromptPath)
      ? readFileSync(systemPromptPath, 'utf-8')
      : 'You are a helpful project manager agent.';

    // Load manager knowledge
    const managerMd = existsSync(this.managerMdPath)
      ? readFileSync(this.managerMdPath, 'utf-8')
      : '';

    // Build current context
    const issues = this.tracker.list();
    const issuesSummary = issues.length > 0
      ? issues.map(i => `- #${i.id} ${i.title} [${i.status}]`).join('\n')
      : 'No issues yet.';

    this.systemPrompt = [
      systemTemplate,
      '',
      '## Project Knowledge',
      managerMd,
      '',
      '## Current Issues',
      issuesSummary,
      '',
      `## Configuration`,
      `- Yolo mode: ${this.config.manager.yoloMode ? 'ON' : 'OFF'}`,
      `- Test command: ${this.config.worker.testCommand}`,
      `- Build command: ${this.config.worker.buildCommand}`,
    ].join('\n');

    // Load conversation history (last 50 messages)
    this.loadHistory(50);

    logger.info('manager', 'Manager initialized', { messageCount: this.messages.length });
  }

  private loadHistory(maxMessages: number): void {
    if (!existsSync(this.historyPath)) return;

    const content = readFileSync(this.historyPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const recentLines = lines.slice(-maxMessages);

    this.messages = [];
    for (const line of recentLines) {
      try {
        const msg = JSON.parse(line) as Message;
        this.messages.push(msg);
      } catch {
        // Skip malformed lines
      }
    }
  }

  private persistMessage(msg: Message): void {
    appendFileSync(this.historyPath, JSON.stringify(msg) + '\n');
  }

  async chat(userMessage: string): Promise<string> {
    const userMsg: Message = { role: 'user', content: userMessage };
    this.messages.push(userMsg);
    this.persistMessage(userMsg);

    let fullResponse = '';
    let continueLoop = true;

    while (continueLoop) {
      const request: LlmRequest = {
        model: this.config.llm.model,
        max_tokens: 4096,
        system: this.systemPrompt,
        messages: this.messages,
        tools: MANAGER_TOOLS,
      };

      try {
        const response = await this.router.complete(request);
        const assistantMsg: Message = {
          role: 'assistant',
          content: response.content,
        };
        this.messages.push(assistantMsg);
        this.persistMessage(assistantMsg);

        // Process content blocks
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const textBlocks = response.content.filter(b => b.type === 'text');

        for (const block of textBlocks) {
          if (block.text) {
            fullResponse += block.text;
            this.emit({ type: 'text', content: block.text });
          }
        }

        if (toolUseBlocks.length > 0 && response.stop_reason === 'tool_use') {
          // Execute tools and continue
          const toolResults: ContentBlock[] = [];
          for (const toolBlock of toolUseBlocks) {
            this.emit({ type: 'tool_call', content: `Calling ${toolBlock.name}...`, data: toolBlock });
            const result = await this.executeTool(toolBlock.name!, toolBlock.input!);
            this.emit({ type: 'tool_result', content: result });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: result,
            });
          }

          const toolResultMsg: Message = { role: 'user', content: toolResults };
          this.messages.push(toolResultMsg);
          this.persistMessage(toolResultMsg);
        } else {
          continueLoop = false;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'error', content: errorMsg });
        fullResponse = `Error communicating with LLM: ${errorMsg}`;
        continueLoop = false;
      }
    }

    return fullResponse;
  }

  async *chatStream(userMessage: string): AsyncGenerator<ManagerEvent> {
    const userMsg: Message = { role: 'user', content: userMessage };
    this.messages.push(userMsg);
    this.persistMessage(userMsg);

    const request: LlmRequest = {
      model: this.config.llm.model,
      max_tokens: 4096,
      system: this.systemPrompt,
      messages: this.messages,
      tools: MANAGER_TOOLS,
      stream: true,
    };

    let fullText = '';
    try {
      for await (const event of this.router.stream(request)) {
        if (event.type === 'content_block_delta' && event.delta?.text) {
          fullText += event.delta.text;
          yield { type: 'text', content: event.delta.text };
        }
      }

      if (fullText) {
        const assistantMsg: Message = { role: 'assistant', content: fullText };
        this.messages.push(assistantMsg);
        this.persistMessage(assistantMsg);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', content: errorMsg };
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    logger.info('manager', `Executing tool: ${name}`, input);

    switch (name) {
      case 'create_issue': {
        const issue = this.tracker.create(
          input.title as string,
          input.description as string,
          (input.specs as string[]) ?? [],
          (input.priority as 'high' | 'medium' | 'low') ?? 'medium',
          (input.acceptance_criteria as string[]) ?? [],
        );
        return `Created issue #${issue.id}: ${issue.title} [${issue.status}]`;
      }

      case 'list_issues': {
        const filter = input.status ? { status: input.status as any } : undefined;
        const issues = this.tracker.list(filter);
        if (issues.length === 0) return 'No issues found.';
        return issues.map(i =>
          `#${i.id} ${i.title} [${i.status}] (${i.priority})`
        ).join('\n');
      }

      case 'spawn_worker': {
        const issueId = input.issue_id as string;
        return await this.spawnWorker(issueId);
      }

      case 'review_diff': {
        const issueId = input.issue_id as string;
        const issue = this.tracker.get(issueId);
        if (!issue) return `Issue #${issueId} not found.`;
        const wtPath = worktreePath(this.projectRoot, issueId, issue.slug);
        try {
          const diff = await getWorktreeDiff(wtPath);
          return diff || 'No changes found in worktree.';
        } catch (err) {
          return `Error getting diff: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'merge_issue': {
        const issueId = input.issue_id as string;
        const issue = this.tracker.get(issueId);
        if (!issue) return `Issue #${issueId} not found.`;
        const result = await mergeWorktree(this.projectRoot, issueId, issue.slug);
        if (result.success) {
          this.tracker.updateStatus(issueId, 'done');
          await removeWorktree(this.projectRoot, issueId, issue.slug);
          this.workers.delete(issueId);
          return `Merged and closed issue #${issueId}. Worktree cleaned up.`;
        }
        return `Merge failed: ${result.message}`;
      }

      case 'run_tests': {
        const issueId = input.issue_id as string;
        const issue = this.tracker.get(issueId);
        if (!issue) return `Issue #${issueId} not found.`;
        const wtPath = worktreePath(this.projectRoot, issueId, issue.slug);
        return await this.runCommand(this.config.worker.testCommand, wtPath);
      }

      case 'read_file': {
        const filePath = join(this.projectRoot, input.path as string);
        try {
          return readFileSync(filePath, 'utf-8');
        } catch {
          return `File not found: ${input.path}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async spawnWorker(issueId: string): Promise<string> {
    const issue = this.tracker.get(issueId);
    if (!issue) return `Issue #${issueId} not found.`;

    if (this.workers.has(issueId)) {
      const worker = this.workers.get(issueId)!;
      if (worker.getState().status === 'running') {
        return `Worker for #${issueId} is already running.`;
      }
    }

    try {
      // Create worktree
      const wt = await createWorktree(this.projectRoot, issueId, issue.slug);

      // Update issue status
      this.tracker.updateStatus(issueId, 'in_progress');

      // Pick an endpoint
      const health = this.router.getHealth();
      const healthyEndpoint = health.find(e => e.healthy);
      if (!healthyEndpoint) {
        return 'No healthy LLM endpoints available.';
      }

      // Create and start worker
      const worker = new Worker(this.projectRoot, this.config, issue, wt.path);
      this.workers.set(issueId, worker);

      await worker.start(healthyEndpoint.url);

      this.emit({
        type: 'worker_update',
        content: `Worker started for #${issueId}`,
        data: { issueId, status: 'running' },
      });

      return `Worker spawned for issue #${issueId} in worktree ${wt.path}. Branch: ${wt.branch}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to spawn worker: ${msg}`;
    }
  }

  private runCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const [cmd, ...args] = command.split(' ');
      const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { output += d.toString(); });

      proc.on('close', (code: number) => {
        resolve(`Exit code: ${code}\n${output}`);
      });

      proc.on('error', (err: Error) => {
        resolve(`Command failed: ${err.message}`);
      });

      setTimeout(() => {
        proc.kill();
        resolve(`Command timed out after 60s\n${output}`);
      }, 60000);
    });
  }

  getWorkers(): Map<string, Worker> {
    return this.workers;
  }

  getIssueTracker(): IssueTracker {
    return this.tracker;
  }

  toggleYoloMode(): boolean {
    this.config.manager.yoloMode = !this.config.manager.yoloMode;
    return this.config.manager.yoloMode;
  }

  isYoloMode(): boolean {
    return this.config.manager.yoloMode;
  }

  shutdown(): void {
    for (const [, worker] of this.workers) {
      worker.kill();
    }
    this.tracker.stopWatching();
  }
}

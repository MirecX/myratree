import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { spawn as spawnProcess } from 'child_process';
import { join } from 'path';
import type { MyratreeConfig } from '../core/config.js';
import type { Message, ContentBlock, ToolDefinition, LlmRequest, StreamEvent } from '../llm/types.js';
import type { LlmRouter } from '../llm/router.js';
import { IssueTracker } from '../issues/tracker.js';
import { createWorktree, mergeWorktree, getWorktreeDiff, removeWorktree, worktreePath, listWorktrees } from '../core/git.js';
import { Worker, type WorkerState } from './worker.js';
import { logger } from '../utils/logger.js';

const DESTRUCTIVE_TOOLS = new Set(['delete_issue', 'spawn_worker', 'merge_issue', 'git_commit']);

export interface ManagerEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'worker_update' | 'auto_response' | 'chat_done';
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
    name: 'create_spec',
    description: 'Create or update a specification file in the specs/ directory. MUST be called before create_issue so the issue can reference the spec. specs/readme.md is auto-generated as a lookup table — do not create it manually.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Spec filename (e.g., "auth-flow.md", "api-design.md"). Will be placed in specs/ directory.' },
        content: { type: 'string', description: 'Full markdown content of the specification. Should describe requirements, architecture, acceptance criteria, and constraints in detail.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'list_specs',
    description: 'List all existing specification files in the specs/ directory',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'worker_status',
    description: 'Get the current status and output of a worker agent',
    input_schema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Issue ID' },
      },
      required: ['issue_id'],
    },
  },
  {
    name: 'reprioritize',
    description: 'Change issue priority and reorder the worker queue. Use this to manage which issues get worked on first.',
    input_schema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Issue ID' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'New priority' },
      },
      required: ['issue_id', 'priority'],
    },
  },
  {
    name: 'delete_issue',
    description: 'Delete an issue from the tracker',
    input_schema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string', description: 'Issue ID to delete' },
      },
      required: ['issue_id'],
    },
  },
  {
    name: 'git_commit',
    description: 'Stage and commit files to the main branch. Use this after create_spec to commit spec files before spawning a worker.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to stage (relative to project root, e.g., "specs/auth-flow.md")',
        },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['files', 'message'],
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

interface QueuedWorker {
  issueId: string;
  priority: 'high' | 'medium' | 'low';
  queuedAt: Date;
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export class Manager {
  private messages: Message[] = [];
  private tracker: IssueTracker;
  private workers: Map<string, Worker> = new Map();
  private workerEndpoints: Map<string, string> = new Map(); // issueId → endpoint URL
  private workerQueue: QueuedWorker[] = [];
  private chatBusy = false;
  private pendingMessages: string[] = [];
  private eventCallback: ManagerEventCallback | null = null;
  private confirmCallback: ((tool: string, description: string) => Promise<boolean>) | null = null;
  private historyPath: string;
  private managerMdPath: string;
  private systemPrompt: string = '';
  private _recoveryInfo: string | null = null;

  constructor(
    private projectRoot: string,
    private config: MyratreeConfig,
    private router: LlmRouter,
  ) {
    this.tracker = new IssueTracker(projectRoot);
    this.historyPath = join(projectRoot, '.myratree', 'manager-history.jsonl');
    this.managerMdPath = join(projectRoot, '.myratree', 'manager.md');
  }

  onEvent(callback: ManagerEventCallback): void {
    this.eventCallback = callback;
  }

  onConfirm(callback: (tool: string, description: string) => Promise<boolean>): void {
    this.confirmCallback = callback;
  }

  getRecoveryInfo(): string | null {
    return this._recoveryInfo;
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
      `- Project root: ${this.projectRoot}`,
      `- Yolo mode: ${this.config.manager.yoloMode ? 'ON' : 'OFF'}`,
      `- Test command: ${this.config.worker.testCommand}`,
      `- Build command: ${this.config.worker.buildCommand}`,
    ].join('\n');

    // Ensure specs/readme.md is up to date
    const specsDir = join(this.projectRoot, this.config.project.specsDir);
    if (existsSync(specsDir)) {
      this.regenerateSpecsReadme(specsDir);
    }

    // Detect orphaned worktrees (exist on disk but have no live Worker)
    try {
      const worktrees = await listWorktrees(this.projectRoot);
      const orphaned: string[] = [];
      for (const wt of worktrees) {
        if (!this.workers.has(wt.issueId)) {
          const issue = this.tracker.get(wt.issueId);
          if (issue && (issue.status === 'in_progress' || issue.status === 'review')) {
            this.tracker.updateStatus(wt.issueId, 'open');
            orphaned.push(`#${wt.issueId} "${issue.title}" (was ${issue.status}, reset to open)`);
          }
        }
      }
      if (orphaned.length > 0) {
        this._recoveryInfo = `Found ${orphaned.length} orphaned worktree(s) from a previous session:\n${orphaned.map(o => `  - ${o}`).join('\n')}\nTheir status has been reset to "open". You can spawn_worker to resume or delete_issue to clean up.`;
        logger.info('manager', 'Recovery: orphaned worktrees detected', { orphaned });
      }
    } catch (err) {
      logger.warn('manager', 'Failed to check for orphaned worktrees', err);
    }

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

  async chat(userMessage: string): Promise<void> {
    // Queue message if a chat is already in progress
    if (this.chatBusy) {
      this.pendingMessages.push(userMessage);
      return;
    }

    this.chatBusy = true;
    try {
      await this.processChat(userMessage);
    } finally {
      this.chatBusy = false;
      this.emit({ type: 'chat_done', content: '' });

      // Process any queued messages
      if (this.pendingMessages.length > 0) {
        const next = this.pendingMessages.shift()!;
        this.chat(next);
      }
    }
  }

  private async processChat(userMessage: string): Promise<void> {
    const userMsg: Message = { role: 'user', content: userMessage };
    this.messages.push(userMsg);
    this.persistMessage(userMsg);

    let continueLoop = true;
    let iterations = 0;
    const MAX_TOOL_ITERATIONS = this.config.manager.yoloMode ? Infinity : 25;

    while (continueLoop) {
      iterations++;
      if (iterations > MAX_TOOL_ITERATIONS) {
        const msg = `Stopped after ${MAX_TOOL_ITERATIONS} tool calls to prevent infinite loop.`;
        this.emit({ type: 'error', content: msg });
        break;
      }
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
            this.emit({ type: 'text', content: block.text });
          }
        }

        if (toolUseBlocks.length > 0 && response.stop_reason === 'tool_use') {
          // Detect repeated identical tool calls
          const callSig = toolUseBlocks.map(b => `${b.name}:${JSON.stringify(b.input)}`).join('|');
          if ((this as any)._lastToolSig === callSig) {
            (this as any)._repeatCount = ((this as any)._repeatCount ?? 0) + 1;
          } else {
            (this as any)._repeatCount = 0;
          }
          (this as any)._lastToolSig = callSig;

          if ((this as any)._repeatCount >= 3) {
            const msg = 'Stopped: same tool called 3 times in a row.';
            this.emit({ type: 'error', content: msg });
            (this as any)._repeatCount = 0;
            break;
          }

          // Execute tools and continue
          const toolResults: ContentBlock[] = [];
          let spawnedWorker = false;
          for (const toolBlock of toolUseBlocks) {
            this.emit({ type: 'tool_call', content: `Calling ${toolBlock.name}...`, data: toolBlock });
            const result = await this.executeTool(toolBlock.name!, toolBlock.input!);
            this.emit({ type: 'tool_result', content: result });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: result,
            });
            if (toolBlock.name === 'spawn_worker' && result.startsWith('Worker spawned')) {
              spawnedWorker = true;
            }
          }

          const toolResultMsg: Message = { role: 'user', content: toolResults };
          this.messages.push(toolResultMsg);
          this.persistMessage(toolResultMsg);

          // After spawning a worker, break out of the loop immediately
          // so the chat is unblocked for further user interaction
          if (spawnedWorker) {
            this.emit({ type: 'text', content: `Worker spawned. You'll be notified when it finishes.` });
            continueLoop = false;
          }
        } else {
          continueLoop = false;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'error', content: errorMsg });
        continueLoop = false;
      }
    }
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

  private buildToolDescription(name: string, input: Record<string, unknown>): string {
    switch (name) {
      case 'delete_issue':
        return `Delete issue #${input.issue_id}`;
      case 'spawn_worker':
        return `Spawn worker for issue #${input.issue_id}`;
      case 'merge_issue':
        return `Merge issue #${input.issue_id} to main`;
      case 'git_commit':
        return `Git commit: "${input.message}" (${(input.files as string[])?.length ?? 0} files)`;
      default:
        return `${name}(${JSON.stringify(input)})`;
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    logger.info('manager', `Executing tool: ${name}`, input);

    // Confirmation gate for destructive tools when yolo mode is off
    if (DESTRUCTIVE_TOOLS.has(name) && !this.config.manager.yoloMode && this.confirmCallback) {
      const description = this.buildToolDescription(name, input);
      const approved = await this.confirmCallback(name, description);
      if (!approved) {
        return 'Action cancelled by user.';
      }
    }

    switch (name) {
      case 'create_issue': {
        const specs = (input.specs as string[]) ?? [];
        const missingSpecs = specs.filter(s => !existsSync(join(this.projectRoot, s)));
        if (missingSpecs.length > 0) {
          return `Cannot create issue: spec files not found: ${missingSpecs.join(', ')}. Create them first with create_spec.`;
        }
        if (specs.length === 0) {
          return `Cannot create issue without specs. Create a spec first with create_spec, then reference it here.`;
        }
        const issue = this.tracker.create(
          input.title as string,
          input.description as string,
          specs,
          (input.priority as 'high' | 'medium' | 'low') ?? 'medium',
          (input.acceptance_criteria as string[]) ?? [],
        );
        return `Created issue #${issue.id}: ${issue.title} [${issue.status}] (specs: ${specs.join(', ')})`;
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
          const diff = await getWorktreeDiff(wtPath, this.config.project.mainBranch);
          return diff || 'No changes found in worktree.';
        } catch (err) {
          return `Error getting diff: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'merge_issue': {
        const issueId = input.issue_id as string;
        const issue = this.tracker.get(issueId);
        if (!issue) return `Issue #${issueId} not found.`;
        const result = await mergeWorktree(this.projectRoot, issueId, issue.slug, this.config.project.mainBranch);
        if (result.success) {
          this.tracker.updateStatus(issueId, 'done');
          await removeWorktree(this.projectRoot, issueId, issue.slug);
          this.workers.delete(issueId);
          return `Merged and closed issue #${issueId}. ${result.message}. Worktree cleaned up.`;
        }
        return `Merge failed: ${result.message}. Do NOT retry — tell the user what went wrong and ask how to proceed.`;
      }

      case 'run_tests': {
        const issueId = input.issue_id as string;
        const issue = this.tracker.get(issueId);
        if (!issue) return `Issue #${issueId} not found.`;
        if (issue.status !== 'in_progress' && issue.status !== 'review') {
          return `Cannot run tests: issue #${issueId} status is "${issue.status}". A worker must be working on it first.`;
        }
        const wtPath = worktreePath(this.projectRoot, issueId, issue.slug);
        if (!existsSync(wtPath)) {
          return `Worktree does not exist at ${wtPath}. Spawn a worker first with spawn_worker.`;
        }
        return await this.runCommand(this.config.worker.testCommand, wtPath);
      }

      case 'create_spec': {
        const filename = input.filename as string;
        const content = input.content as string;
        const specsDir = join(this.projectRoot, this.config.project.specsDir);
        mkdirSync(specsDir, { recursive: true });
        const specPath = join(specsDir, filename);
        writeFileSync(specPath, content, 'utf-8');
        const relativePath = join(this.config.project.specsDir, filename);
        logger.info('manager', `Created spec: ${relativePath}`);
        this.regenerateSpecsReadme(specsDir);
        return `Created spec file: ${relativePath}`;
      }

      case 'list_specs': {
        const specsDir = join(this.projectRoot, this.config.project.specsDir);
        if (!existsSync(specsDir)) return 'No specs/ directory found.';
        const files = readdirSync(specsDir).filter(f => f.endsWith('.md'));
        if (files.length === 0) return 'No spec files found in specs/.';
        return files.map(f => `- ${this.config.project.specsDir}${f}`).join('\n');
      }

      case 'reprioritize': {
        const issueId = input.issue_id as string;
        const priority = input.priority as 'high' | 'medium' | 'low';
        const issue = this.tracker.update(issueId, { priority });
        if (!issue) return `Issue #${issueId} not found.`;

        // Re-sort the queue if the issue is queued
        const queueIdx = this.workerQueue.findIndex(q => q.issueId === issueId);
        if (queueIdx >= 0) {
          this.workerQueue[queueIdx].priority = priority;
          this.workerQueue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
          const newPos = this.workerQueue.findIndex(q => q.issueId === issueId) + 1;
          return `Issue #${issueId} priority changed to ${priority}. Queue position: ${newPos}/${this.workerQueue.length}.`;
        }

        return `Issue #${issueId} priority changed to ${priority}.`;
      }

      case 'worker_status': {
        const issueId = input.issue_id as string;
        const worker = this.workers.get(issueId);
        if (!worker) return `No worker found for issue #${issueId}.`;
        const state = worker.getState();
        let result = `Worker #${issueId}: ${state.status}`;
        if (state.startedAt) result += ` | Started: ${state.startedAt.toISOString()}`;
        if (state.exitCode !== null) result += ` | Exit code: ${state.exitCode}`;
        result += `\nElapsed: ${worker.getElapsedTime()}`;
        result += `\n\n${worker.getLastOutput(30)}`;
        return result;
      }

      case 'delete_issue': {
        const issueId = input.issue_id as string;
        const issue = this.tracker.get(issueId);
        if (!issue) return `Issue #${issueId} not found.`;
        // Clean up worktree if exists
        const wtPath = worktreePath(this.projectRoot, issueId, issue.slug);
        if (existsSync(wtPath)) {
          try {
            await removeWorktree(this.projectRoot, issueId, issue.slug);
          } catch { /* ignore */ }
        }
        this.workers.delete(issueId);
        // Delete the issue file
        const issuePath = join(this.projectRoot, '.myratree', 'issues', `${issueId}-${issue.slug}.md`);
        if (existsSync(issuePath)) {
          const { unlinkSync } = await import('fs');
          unlinkSync(issuePath);
        }
        return `Deleted issue #${issueId}: ${issue.title}`;
      }

      case 'git_commit': {
        const files = input.files as string[];
        const message = input.message as string;
        try {
          const { getGit } = await import('../core/git.js');
          const git = getGit(this.projectRoot);
          // Verify we're on main/master before committing
          const status = await git.status();
          if (status.current !== this.config.project.mainBranch) {
            return `Cannot commit: project root is on branch "${status.current}", expected "${this.config.project.mainBranch}".`;
          }
          await git.add(files);
          await git.commit(message);
          return `Committed ${files.length} file(s): ${message}`;
        } catch (err) {
          return `Git commit failed: ${err instanceof Error ? err.message : String(err)}`;
        }
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

  private getRunningWorkerCount(): number {
    let count = 0;
    for (const [, worker] of this.workers) {
      if (worker.getState().status === 'running') count++;
    }
    return count;
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

    // Check if already queued
    if (this.workerQueue.some(q => q.issueId === issueId)) {
      return `Issue #${issueId} is already in the worker queue.`;
    }

    // Check concurrency limit
    const maxConcurrent = this.config.worker.maxConcurrent;
    if (this.getRunningWorkerCount() >= maxConcurrent) {
      // Queue the worker
      this.workerQueue.push({
        issueId,
        priority: issue.priority,
        queuedAt: new Date(),
      });
      // Sort queue by priority
      this.workerQueue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

      this.emit({
        type: 'worker_update',
        content: `Issue #${issueId} queued (${this.workerQueue.length} in queue, ${maxConcurrent} workers at capacity)`,
        data: { issueId, status: 'queued' },
      });

      return `Worker queue is full (${this.getRunningWorkerCount()}/${maxConcurrent} running). Issue #${issueId} has been queued at position ${this.workerQueue.findIndex(q => q.issueId === issueId) + 1}. It will start automatically when a slot opens.`;
    }

    return await this.launchWorker(issueId, issue);
  }

  private async launchWorker(issueId: string, issue: import('../issues/parser.js').Issue): Promise<string> {
    // Check for file conflicts with running workers
    const conflicts = this.detectConflicts(issue);
    if (conflicts.length > 0) {
      this.emit({
        type: 'worker_update',
        content: `Warning: potential file conflicts for #${issueId} with: ${conflicts.join(', ')}`,
        data: { issueId, conflicts },
      });
    }

    try {
      // Create worktree
      const wt = await createWorktree(this.projectRoot, issueId, issue.slug, this.config.project.mainBranch);

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

      worker.onComplete((id, status, message) => {
        // Release the LLM endpoint slot reserved for this worker
        const epUrl = this.workerEndpoints.get(id);
        if (epUrl) {
          this.router.releaseWorkerSlot(epUrl);
          this.workerEndpoints.delete(id);
        }
        this.emit({
          type: 'worker_update',
          content: `Worker #${id} ${status}: ${message}`,
          data: { issueId: id, status },
        });
        // Drain the queue when a worker finishes
        this.drainWorkerQueue();
        // Feed result back into manager conversation
        this.handleWorkerResult(id, status, message);
      });

      // Reserve an LLM slot for the worker before starting it
      this.router.reserveWorkerSlot(healthyEndpoint.url);
      this.workerEndpoints.set(issueId, healthyEndpoint.url);

      await worker.start(healthyEndpoint.url);

      this.emit({
        type: 'worker_update',
        content: `Worker started for #${issueId}`,
        data: { issueId, status: 'running' },
      });

      const conflictWarning = conflicts.length > 0
        ? ` WARNING: Potential file conflicts with workers: ${conflicts.join(', ')}.`
        : '';

      return `Worker spawned for issue #${issueId}.${conflictWarning} The worker is now running asynchronously in the background. Do NOT call review_diff, run_tests, or merge_issue until the worker finishes. You will be notified when the worker completes or fails. Tell the user the worker has been spawned and to wait.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to spawn worker: ${msg}`;
    }
  }

  private async drainWorkerQueue(): Promise<void> {
    while (this.workerQueue.length > 0 && this.getRunningWorkerCount() < this.config.worker.maxConcurrent) {
      const next = this.workerQueue.shift()!;
      const issue = this.tracker.get(next.issueId);
      if (!issue) continue;

      this.emit({
        type: 'worker_update',
        content: `Dequeuing issue #${next.issueId} (was queued for ${Math.round((Date.now() - next.queuedAt.getTime()) / 1000)}s)`,
        data: { issueId: next.issueId, status: 'starting' },
      });

      await this.launchWorker(next.issueId, issue);
    }
  }

  private async handleWorkerResult(issueId: string, status: string, message: string): Promise<void> {
    const worker = this.workers.get(issueId);
    const output = worker ? worker.getLastOutput(15) : '';

    let notification: string;
    if (status === 'completed') {
      notification = `[SYSTEM] Worker for issue #${issueId} has COMPLETED. ${message}\n\nWorker output:\n${output}\n\nYou should now review_diff and run_tests for this issue, then merge if everything looks good.`;
    } else if (status === 'blocked') {
      notification = `[SYSTEM] Worker for issue #${issueId} is BLOCKED. ${message}\n\nWorker output:\n${output}\n\nInform the user about the blocker and discuss how to proceed.`;
    } else {
      notification = `[SYSTEM] Worker for issue #${issueId} has FAILED. ${message}\n\nWorker output:\n${output}\n\nAnalyze what went wrong and inform the user. Consider whether to retry with an updated prompt or if the issue needs to be reworked.`;
    }

    // Inject as a user message so the manager will respond
    try {
      const response = await this.chat(notification);
      if (response) {
        this.emit({ type: 'auto_response', content: response });
      }
    } catch (err) {
      logger.error('manager', `Failed to process worker result for #${issueId}`, err);
    }
  }

  private detectConflicts(issue: import('../issues/parser.js').Issue): string[] {
    const conflicts: string[] = [];
    const issuePaths = this.extractFilePaths(issue);
    if (issuePaths.length === 0) return conflicts;

    for (const [workerId, worker] of this.workers) {
      if (worker.getState().status !== 'running') continue;
      if (workerId === issue.id) continue;

      const otherIssue = this.tracker.get(workerId);
      if (!otherIssue) continue;

      const otherPaths = this.extractFilePaths(otherIssue);
      const overlapping = issuePaths.filter(p => otherPaths.some(op => p.startsWith(op) || op.startsWith(p)));

      if (overlapping.length > 0) {
        conflicts.push(`#${workerId} (overlapping: ${overlapping.join(', ')})`);
      }
    }

    return conflicts;
  }

  private extractFilePaths(issue: import('../issues/parser.js').Issue): string[] {
    const paths: string[] = [];
    const text = `${issue.description}\n${issue.acceptanceCriteria.join('\n')}`;
    // Match common file path patterns
    const pathRegex = /(?:src|lib|app|pages|components|api|utils|hooks|styles|public|test|tests)\/[\w/.-]+/g;
    const matches = text.match(pathRegex);
    if (matches) {
      for (const m of matches) {
        // Normalize to directory level for broader conflict detection
        const dir = m.includes('.') ? m.substring(0, m.lastIndexOf('/')) : m;
        if (dir && !paths.includes(dir)) paths.push(dir);
      }
    }
    // Also check spec file overlap
    for (const spec of issue.specs) {
      if (!paths.includes(spec)) paths.push(spec);
    }
    return paths;
  }

  private regenerateSpecsReadme(specsDir: string): void {
    try {
      const files = readdirSync(specsDir)
        .filter(f => f.endsWith('.md') && f !== 'readme.md')
        .sort();

      const rows: string[] = [];
      for (const file of files) {
        const content = readFileSync(join(specsDir, file), 'utf-8');
        const heading = content.match(/^#\s+(.+)/m)?.[1] ?? file.replace(/\.md$/, '');
        rows.push(`| [${file}](${file}) | ${heading} |`);
      }

      const specIndex = [
        '## Spec Index',
        '',
        '| Spec | Scope |',
        '|---|---|',
        ...rows,
        '',
      ].join('\n');

      const readmePath = join(specsDir, 'readme.md');

      if (existsSync(readmePath)) {
        // Preserve everything above ## Spec Index, replace the rest
        const existing = readFileSync(readmePath, 'utf-8');
        const marker = existing.indexOf('## Spec Index');
        if (marker >= 0) {
          writeFileSync(readmePath, existing.slice(0, marker) + specIndex, 'utf-8');
        } else {
          // Append spec index to existing content
          writeFileSync(readmePath, existing.trimEnd() + '\n\n' + specIndex, 'utf-8');
        }
      } else if (rows.length > 0) {
        // No readme yet — write a minimal one (manager will flesh it out via create_spec)
        writeFileSync(readmePath, specIndex, 'utf-8');
      }
    } catch (err) {
      logger.warn('manager', 'Failed to regenerate specs/readme.md', err);
    }
  }

  private runCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve) => {
      const [cmd, ...args] = command.split(' ');
      const proc = spawnProcess(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

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

  getWorkerQueueLength(): number {
    return this.workerQueue.length;
  }

  getMaxConcurrent(): number {
    return this.config.worker.maxConcurrent;
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

  getBaseBranch(): string {
    return this.config.project.mainBranch;
  }

  shutdown(): void {
    for (const [issueId, worker] of this.workers) {
      worker.kill();
      const epUrl = this.workerEndpoints.get(issueId);
      if (epUrl) {
        this.router.releaseWorkerSlot(epUrl);
      }
    }
    this.workerEndpoints.clear();
    this.tracker.stopWatching();
  }
}

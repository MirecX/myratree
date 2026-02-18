import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, createReadStream } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import type { Issue } from '../issues/parser.js';
import type { NovatreeConfig } from '../core/config.js';
import { generateWorkerPrompt } from './prompt-generator.js';
import { logger } from '../utils/logger.js';

export type WorkerStatus = 'idle' | 'running' | 'completed' | 'failed' | 'blocked';

export type WorkerEventCallback = (issueId: string, status: WorkerStatus, message: string) => void;

export interface WorkerState {
  issueId: string;
  slug: string;
  status: WorkerStatus;
  startedAt: Date | null;
  process: ChildProcess | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class Worker {
  private state: WorkerState;
  private onFinished: WorkerEventCallback | null = null;

  constructor(
    private projectRoot: string,
    private config: NovatreeConfig,
    private issue: Issue,
    private worktreePath: string,
  ) {
    this.state = {
      issueId: issue.id,
      slug: issue.slug,
      status: 'idle',
      startedAt: null,
      process: null,
      stdout: '',
      stderr: '',
      exitCode: null,
    };
  }

  getState(): Readonly<WorkerState> {
    return { ...this.state, process: this.state.process };
  }

  onComplete(callback: WorkerEventCallback): void {
    this.onFinished = callback;
  }

  async start(endpointUrl: string): Promise<void> {
    const promptPath = generateWorkerPrompt(
      this.projectRoot,
      this.issue,
      this.worktreePath,
      this.config.worker.testCommand,
    );

    const promptContent = readFileSync(promptPath, 'utf-8');

    // Pipe prompt content via stdin, use -p for a short directive
    // stdin becomes context, -p is the instruction
    const args = [
      '-p', 'Execute the task described in the context piped via stdin. Follow all instructions exactly.',
      '--dangerously-skip-permissions',
      '--model', this.config.llm.model,
      '--append-system-prompt', `You are a worker agent implementing issue #${this.issue.id}: ${this.issue.title}. Your working directory is a git worktree. Make changes, commit them, and write ITHAVEBEENDONE to the issue file when done.`,
    ];

    logger.info('worker', `Starting worker for issue #${this.issue.id}`, {
      cwd: this.worktreePath,
      endpoint: endpointUrl,
      promptLength: promptContent.length,
    });

    this.state.status = 'running';
    this.state.startedAt = new Date();

    const proc = spawn(this.config.worker.claudeCodePath, args, {
      cwd: this.worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: endpointUrl,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'nokey',
        ANTHROPIC_MODEL: this.config.llm.model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        CLAUDECODE: '', // Unset to allow nested sessions
      },
    });

    // Pipe the full prompt content via stdin as context
    if (proc.stdin) {
      proc.stdin.write(promptContent);
      proc.stdin.end();
    }

    this.state.process = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      this.state.stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.state.stderr += data.toString();
    });

    proc.on('close', (code) => {
      this.state.exitCode = code;
      this.state.process = null;
      this.evaluateResult();
    });

    proc.on('error', (err) => {
      logger.error('worker', `Worker process error for #${this.issue.id}`, err.message);
      this.state.status = 'failed';
      this.state.process = null;
    });
  }

  private evaluateResult(): void {
    // Check the issue file for completion markers
    const issuePath = join(
      this.projectRoot, '.novatree', 'issues',
      `${this.issue.id}-${this.issue.slug}.md`,
    );

    let message = '';

    try {
      const content = readFileSync(issuePath, 'utf-8');
      if (content.includes('ITHAVEBEENDONE')) {
        this.state.status = 'completed';
        message = 'Worker completed successfully. Ready for review.';
        logger.info('worker', `Worker for #${this.issue.id} completed successfully`);
      } else if (content.includes('STATUS: BLOCKED')) {
        this.state.status = 'blocked';
        const blockMatch = content.match(/STATUS: BLOCKED\s*(.+)/);
        message = `Worker is blocked: ${blockMatch?.[1] ?? 'unknown reason'}`;
        logger.info('worker', `Worker for #${this.issue.id} is blocked`);
      } else {
        this.state.status = this.state.exitCode === 0 ? 'completed' : 'failed';
        if (this.state.status === 'failed') {
          const lastStderr = this.state.stderr.split('\n').filter(Boolean).slice(-5).join('\n');
          const lastStdout = this.state.stdout.split('\n').filter(Boolean).slice(-5).join('\n');
          message = `Worker failed (exit code ${this.state.exitCode}).`;
          if (lastStderr) message += `\nStderr: ${lastStderr}`;
          else if (lastStdout) message += `\nOutput: ${lastStdout}`;
        } else {
          message = 'Worker exited successfully but did not write ITHAVEBEENDONE.';
        }
        logger.info('worker', `Worker for #${this.issue.id} exited with code ${this.state.exitCode}`);
      }
    } catch {
      this.state.status = 'failed';
      const lastStderr = this.state.stderr.split('\n').filter(Boolean).slice(-5).join('\n');
      message = `Worker failed - could not read issue file.`;
      if (lastStderr) message += `\nStderr: ${lastStderr}`;
      logger.error('worker', `Could not read issue file for #${this.issue.id}`);
    }

    this.onFinished?.(this.issue.id, this.state.status, message);
  }

  getLastOutput(lines = 20): string {
    const stderr = this.state.stderr.split('\n').filter(Boolean).slice(-lines);
    const stdout = this.state.stdout.split('\n').filter(Boolean).slice(-lines);
    const parts: string[] = [];
    if (stdout.length > 0) parts.push(`=== stdout (last ${stdout.length} lines) ===\n${stdout.join('\n')}`);
    if (stderr.length > 0) parts.push(`=== stderr (last ${stderr.length} lines) ===\n${stderr.join('\n')}`);
    if (parts.length === 0) return 'No output captured.';
    return parts.join('\n\n');
  }

  kill(): void {
    if (this.state.process) {
      this.state.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.state.process) {
          this.state.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  getElapsedTime(): string {
    if (!this.state.startedAt) return '0s';
    const elapsed = Math.floor((Date.now() - this.state.startedAt.getTime()) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
}

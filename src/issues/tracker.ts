import { readdirSync, existsSync, watch, type FSWatcher } from 'fs';
import { join, basename } from 'path';
import { readMarkdown, writeMarkdown } from '../utils/markdown.js';
import { parseIssue, serializeIssue, slugify, type Issue, type IssueStatus, type IssuePriority, type AgentLogEntry } from './parser.js';
import { logger } from '../utils/logger.js';

export class IssueTracker {
  private issuesDir: string;
  private watcher: FSWatcher | null = null;
  private changeListeners: Array<() => void> = [];

  constructor(private projectRoot: string) {
    this.issuesDir = join(projectRoot, '.myratree', 'issues');
  }

  private getNextId(): string {
    const existing = this.list();
    if (existing.length === 0) return '001';
    const maxId = Math.max(...existing.map(i => parseInt(i.id, 10)));
    return String(maxId + 1).padStart(3, '0');
  }

  private issueFilePath(id: string, slug: string): string {
    return join(this.issuesDir, `${id}-${slug}.md`);
  }

  create(
    title: string,
    description: string,
    specs: string[] = [],
    priority: IssuePriority = 'medium',
    acceptanceCriteria: string[] = [],
  ): Issue {
    const id = this.getNextId();
    const slug = slugify(title);
    const branch = `myratree/${id}-${slug}`;

    const issue: Issue = {
      id,
      title,
      slug,
      status: 'open',
      created: new Date().toISOString(),
      branch,
      specs,
      priority,
      description,
      acceptanceCriteria,
      agentLog: [],
    };

    const path = this.issueFilePath(id, slug);
    writeMarkdown(path, serializeIssue(issue));
    logger.info('tracker', `Created issue #${id}: ${title}`);
    return issue;
  }

  list(filter?: { status?: IssueStatus }): Issue[] {
    if (!existsSync(this.issuesDir)) return [];

    const files = readdirSync(this.issuesDir).filter(f => f.endsWith('.md')).sort();
    const issues: Issue[] = [];

    for (const file of files) {
      const content = readMarkdown(join(this.issuesDir, file));
      if (!content) continue;
      const issue = parseIssue(content, file);
      if (filter?.status && issue.status !== filter.status) continue;
      issues.push(issue);
    }

    return issues;
  }

  get(id: string): Issue | null {
    const files = existsSync(this.issuesDir)
      ? readdirSync(this.issuesDir).filter(f => f.startsWith(id + '-'))
      : [];
    if (files.length === 0) return null;

    const content = readMarkdown(join(this.issuesDir, files[0]));
    if (!content) return null;
    return parseIssue(content, files[0]);
  }

  update(id: string, updates: Partial<Pick<Issue, 'status' | 'title' | 'description' | 'priority' | 'specs' | 'acceptanceCriteria'>>): Issue | null {
    const issue = this.get(id);
    if (!issue) return null;

    const updated = { ...issue, ...updates };
    const path = this.issueFilePath(id, issue.slug);
    writeMarkdown(path, serializeIssue(updated));
    logger.info('tracker', `Updated issue #${id}`, updates);
    return updated;
  }

  updateStatus(id: string, status: IssueStatus): Issue | null {
    return this.update(id, { status });
  }

  appendAgentLog(id: string, agent: string, content: string): void {
    const issue = this.get(id);
    if (!issue) return;

    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      agent,
      content,
    };

    issue.agentLog.push(entry);
    const path = this.issueFilePath(id, issue.slug);
    writeMarkdown(path, serializeIssue(issue));
  }

  checkForCompletion(id: string): 'done' | 'blocked' | null {
    const issue = this.get(id);
    if (!issue) return null;

    const lastLog = issue.agentLog[issue.agentLog.length - 1];
    if (!lastLog) return null;

    if (lastLog.content.includes('ITHAVEBEENDONE')) return 'done';
    if (lastLog.content.includes('STATUS: BLOCKED')) return 'blocked';
    return null;
  }

  watchChanges(callback: () => void): void {
    this.changeListeners.push(callback);
    if (this.watcher) return;

    if (!existsSync(this.issuesDir)) return;

    this.watcher = watch(this.issuesDir, () => {
      for (const listener of this.changeListeners) {
        listener();
      }
    });
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.changeListeners = [];
  }
}

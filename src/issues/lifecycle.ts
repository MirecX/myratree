import type { IssueStatus } from './parser.js';

const VALID_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open: ['in_progress', 'blocked'],
  in_progress: ['review', 'blocked', 'open'],
  review: ['done', 'in_progress', 'open'],
  done: ['open'], // Reopen
  blocked: ['open', 'in_progress'],
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getStatusIcon(status: IssueStatus): string {
  switch (status) {
    case 'open': return '○';
    case 'in_progress': return '●';
    case 'review': return '◐';
    case 'done': return '✓';
    case 'blocked': return '✗';
  }
}

export function getStatusColor(status: IssueStatus): string {
  switch (status) {
    case 'open': return 'white';
    case 'in_progress': return 'blue';
    case 'review': return 'yellow';
    case 'done': return 'green';
    case 'blocked': return 'red';
  }
}

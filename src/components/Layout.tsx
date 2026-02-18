import React, { useState, useEffect, useCallback } from 'react';
import { Box, useInput, useApp } from 'ink';
import { IssueList } from './IssueList.js';
import { Chat } from './Chat.js';
import { AgentStatus } from './AgentStatus.js';
import { DiffView } from './DiffView.js';
import type { Manager } from '../agents/manager.js';
import type { LlmRouter } from '../llm/router.js';
import type { Issue } from '../issues/parser.js';

type Panel = 'issues' | 'chat';

interface LayoutProps {
  manager: Manager;
  router: LlmRouter;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function Layout({ manager, router }: LayoutProps) {
  const { exit } = useApp();
  const [activePanel, setActivePanel] = useState<Panel>('chat');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selectedIssue, setSelectedIssue] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'system', content: 'Welcome to Novatree. Describe a feature or type /help.' },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [diffView, setDiffView] = useState<{ title: string; content: string } | null>(null);
  const [, setTick] = useState(0);

  // Refresh issues periodically
  useEffect(() => {
    const refresh = () => {
      const tracker = manager.getIssueTracker();
      setIssues(tracker.list());
    };
    refresh();
    const interval = setInterval(() => {
      refresh();
      setTick(t => t + 1); // Force re-render for elapsed time
    }, 2000);
    return () => clearInterval(interval);
  }, [manager]);

  // Listen to manager events
  useEffect(() => {
    manager.onEvent((event) => {
      if (event.type === 'text') {
        // Handled via chat response (user-initiated)
      } else if (event.type === 'auto_response') {
        // Manager auto-responded to a worker event
        setChatMessages(prev => [...prev, { role: 'assistant', content: event.content }]);
      } else if (event.type === 'tool_call') {
        setChatMessages(prev => [...prev, { role: 'system', content: event.content }]);
      } else if (event.type === 'worker_update') {
        setChatMessages(prev => [...prev, { role: 'system', content: event.content }]);
      } else if (event.type === 'error') {
        setChatMessages(prev => [...prev, { role: 'system', content: `Error: ${event.content}` }]);
      }
    });
  }, [manager]);

  const handleSend = useCallback(async (message: string) => {
    setChatMessages(prev => [...prev, { role: 'user', content: message }]);
    setIsLoading(true);

    try {
      const response = await manager.chat(message);
      if (response) {
        setChatMessages(prev => [...prev, { role: 'assistant', content: response }]);
      }
    } catch (err) {
      setChatMessages(prev => [...prev, {
        role: 'system',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [manager]);

  useInput((input, key) => {
    if (diffView) return; // DiffView handles its own input

    if (key.tab) {
      setActivePanel(p => p === 'issues' ? 'chat' : 'issues');
    }

    if (input === 'q' && activePanel !== 'chat') {
      const workers = manager.getWorkers();
      if (workers.size > 0) {
        setChatMessages(prev => [...prev, {
          role: 'system',
          content: 'Workers are running. Press q again to force quit.',
        }]);
      } else {
        manager.shutdown();
        exit();
      }
    }

    if (input === 'y' && activePanel !== 'chat') {
      const yolo = manager.toggleYoloMode();
      setChatMessages(prev => [...prev, {
        role: 'system',
        content: `Yolo mode ${yolo ? 'ENABLED' : 'DISABLED'}`,
      }]);
    }

    if (input === 'i') {
      setActivePanel('chat');
    }

    // Issue list navigation
    if (activePanel === 'issues') {
      if (key.upArrow) {
        setSelectedIssue(i => Math.max(0, i - 1));
      }
      if (key.downArrow) {
        setSelectedIssue(i => Math.min(issues.length - 1, i + 1));
      }
      if (input === 'd' && issues[selectedIssue]) {
        // Show diff view
        const issue = issues[selectedIssue];
        import('../core/git.js').then(({ getWorktreeDiff, worktreePath }) => {
          const wtPath = worktreePath(
            (manager as any).projectRoot,
            issue.id,
            issue.slug,
          );
          getWorktreeDiff(wtPath).then(diff => {
            setDiffView({ title: `Diff: #${issue.id} ${issue.title}`, content: diff || 'No changes' });
          }).catch(() => {
            setDiffView({ title: `Diff: #${issue.id}`, content: 'No worktree found for this issue.' });
          });
        });
      }
      if (input === 'l' && issues[selectedIssue]) {
        const issue = issues[selectedIssue];
        const logContent = issue.agentLog.length > 0
          ? issue.agentLog.map(e => `[${e.timestamp}] ${e.agent}:\n${e.content}`).join('\n\n')
          : 'No agent log entries.';
        setDiffView({ title: `Log: #${issue.id} ${issue.title}`, content: logContent });
      }
    }
  });

  if (diffView) {
    return (
      <Box flexDirection="column" width="100%" height="100%">
        <DiffView
          title={diffView.title}
          content={diffView.content}
          onClose={() => setDiffView(null)}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <IssueList
        issues={issues}
        selectedIndex={selectedIssue}
        focused={activePanel === 'issues'}
      />
      <Box flexGrow={1}>
        <Chat
          messages={chatMessages}
          focused={activePanel === 'chat'}
          onSend={handleSend}
          isLoading={isLoading}
        />
      </Box>
      <AgentStatus
        workers={manager.getWorkers()}
        endpoints={router.getHealth()}
        queueLength={router.getQueueLength()}
        workerQueueLength={manager.getWorkerQueueLength()}
        maxConcurrent={manager.getMaxConcurrent()}
        yoloMode={manager.isYoloMode()}
      />
    </Box>
  );
}

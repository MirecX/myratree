import React from 'react';
import { Box, Text } from 'ink';
import type { Worker } from '../agents/worker.js';
import type { EndpointHealth } from '../llm/types.js';

interface AgentStatusProps {
  workers: Map<string, Worker>;
  endpoints: EndpointHealth[];
  queueLength: number;
  yoloMode: boolean;
}

export function AgentStatus({ workers, endpoints, queueLength, yoloMode }: AgentStatusProps) {
  const workerEntries = Array.from(workers.entries());
  const healthyCount = endpoints.filter(e => e.healthy).length;

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text bold dimColor> Agent Status </Text>
        {yoloMode && <Text color="red" bold> [YOLO] </Text>}
      </Box>

      <Box flexDirection="row" gap={2}>
        <Box flexDirection="column" flexGrow={1}>
          {workerEntries.length === 0 ? (
            <Text dimColor>No active workers</Text>
          ) : (
            workerEntries.map(([issueId, worker]) => {
              const state = worker.getState();
              const statusColor = state.status === 'running' ? 'green'
                : state.status === 'failed' ? 'red'
                : state.status === 'completed' ? 'cyan'
                : 'yellow';
              return (
                <Text key={issueId}>
                  <Text color={statusColor}>worker-{issueId}</Text>
                  <Text dimColor> | </Text>
                  <Text color={statusColor}>{state.status}</Text>
                  <Text dimColor> | </Text>
                  <Text>{worker.getElapsedTime()}</Text>
                </Text>
              );
            })
          )}
        </Box>

        <Box>
          <Text dimColor>LLM: </Text>
          <Text color={healthyCount > 0 ? 'green' : 'red'}>
            {healthyCount}/{endpoints.length} healthy
          </Text>
          <Text dimColor> | Queue: </Text>
          <Text>{queueLength}</Text>
        </Box>
      </Box>
    </Box>
  );
}

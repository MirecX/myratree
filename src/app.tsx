import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Layout } from './components/Layout.js';
import { Manager } from './agents/manager.js';
import { LlmRouter } from './llm/router.js';
import type { NovatreeConfig } from './core/config.js';

interface AppProps {
  projectRoot: string;
  config: NovatreeConfig;
}

export function App({ projectRoot, config }: AppProps) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manager, setManager] = useState<Manager | null>(null);
  const [router, setRouter] = useState<LlmRouter | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const llmRouter = new LlmRouter(config.llm.endpoints, config.llm.healthCheckIntervalMs);
        await llmRouter.start();

        const mgr = new Manager(projectRoot, config, llmRouter);
        await mgr.initialize();

        setRouter(llmRouter);
        setManager(mgr);
        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    init();

    return () => {
      manager?.shutdown();
      router?.stop();
    };
  }, []);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>Novatree failed to start:</Text>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (!ready || !manager || !router) {
    return (
      <Box padding={1}>
        <Text color="cyan">Initializing Novatree...</Text>
      </Box>
    );
  }

  return <Layout manager={manager} router={router} />;
}

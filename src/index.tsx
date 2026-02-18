import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { initNovatree } from './core/init.js';
import { loadConfig, findProjectRoot, saveConfig } from './core/config.js';
import { IssueTracker } from './issues/tracker.js';
import { initLogger } from './utils/logger.js';
import { join } from 'path';

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
novatree - LLM-driven git project manager

Usage:
  novatree              Launch the TUI
  novatree init         Initialize novatree in the current repo
  novatree reset        Clear all issues, history, and worktrees (keeps config)
  novatree issue create <title> [--specs <files>] [--priority <level>]
  novatree issue list   List all issues
  novatree status       Show project status
  novatree config set <key> <value>
  novatree help         Show this help message
`);
}

async function main() {
  switch (command) {
    case 'init': {
      const projectRoot = process.cwd();
      const result = initNovatree(projectRoot);
      if (result.alreadyExisted) {
        console.log('Novatree already initialized. Updated missing files:');
      } else {
        console.log('Novatree initialized successfully!');
      }
      for (const path of result.created) {
        console.log(`  + ${path}`);
      }
      if (result.created.length === 0) {
        console.log('  (everything already exists)');
      }
      console.log('\nNext: edit .novatree/config.json to configure your LLM endpoints.');
      break;
    }

    case 'issue': {
      const projectRoot = findProjectRoot();
      if (!projectRoot) {
        console.error('Not in a novatree project. Run `novatree init` first.');
        process.exit(1);
      }

      const subcommand = args[1];
      const tracker = new IssueTracker(projectRoot);

      if (subcommand === 'create') {
        const title = args[2];
        if (!title) {
          console.error('Usage: novatree issue create <title> [--specs <files>] [--priority <level>]');
          process.exit(1);
        }

        const specsIdx = args.indexOf('--specs');
        const specs = specsIdx >= 0 ? args[specsIdx + 1]?.split(',') ?? [] : [];

        const priorityIdx = args.indexOf('--priority');
        const priority = (priorityIdx >= 0 ? args[priorityIdx + 1] : 'medium') as 'high' | 'medium' | 'low';

        const issue = tracker.create(title, '', specs, priority);
        console.log(`Created issue #${issue.id}: ${issue.title}`);
      } else if (subcommand === 'list') {
        const issues = tracker.list();
        if (issues.length === 0) {
          console.log('No issues.');
        } else {
          for (const issue of issues) {
            console.log(`#${issue.id} [${issue.status}] ${issue.title} (${issue.priority})`);
          }
        }
      } else {
        console.error(`Unknown issue subcommand: ${subcommand}`);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const projectRoot = findProjectRoot();
      if (!projectRoot) {
        console.error('Not in a novatree project. Run `novatree init` first.');
        process.exit(1);
      }

      const config = loadConfig(projectRoot);
      const tracker = new IssueTracker(projectRoot);
      const issues = tracker.list();

      console.log('Novatree Status');
      console.log('===============');
      console.log(`Project root: ${projectRoot}`);
      console.log(`LLM endpoints: ${config.llm.endpoints.map(e => e.name).join(', ')}`);
      console.log(`Model: ${config.llm.model}`);
      console.log(`Issues: ${issues.length} total`);
      for (const status of ['open', 'in_progress', 'review', 'done', 'blocked'] as const) {
        const count = issues.filter(i => i.status === status).length;
        if (count > 0) console.log(`  ${status}: ${count}`);
      }
      break;
    }

    case 'config': {
      const projectRoot = findProjectRoot();
      if (!projectRoot) {
        console.error('Not in a novatree project. Run `novatree init` first.');
        process.exit(1);
      }

      if (args[1] === 'set' && args[2] && args[3]) {
        const config = loadConfig(projectRoot);
        const keys = args[2].split('.');
        let obj: any = config;
        for (let i = 0; i < keys.length - 1; i++) {
          const key = keys[i];
          const arrayMatch = key.match(/^(.+)\[(\d+)\]$/);
          if (arrayMatch) {
            obj = obj[arrayMatch[1]][parseInt(arrayMatch[2])];
          } else {
            obj = obj[key];
          }
        }
        const lastKey = keys[keys.length - 1];
        // Try to parse as JSON, fall back to string
        try {
          obj[lastKey] = JSON.parse(args[3]);
        } catch {
          obj[lastKey] = args[3];
        }
        saveConfig(projectRoot, config);
        console.log(`Set ${args[2]} = ${args[3]}`);
      } else {
        console.error('Usage: novatree config set <key> <value>');
        process.exit(1);
      }
      break;
    }

    case 'reset': {
      const projectRoot = findProjectRoot();
      if (!projectRoot) {
        console.error('Not in a novatree project. Run `novatree init` first.');
        process.exit(1);
      }
      const { resetNovatree } = await import('./core/init.js');
      const cleared = resetNovatree(projectRoot);
      console.log('Novatree reset complete:');
      for (const item of cleared) {
        console.log(`  - ${item}`);
      }
      // Re-init to recreate defaults
      const result = initNovatree(projectRoot);
      for (const path of result.created) {
        console.log(`  + ${path}`);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      printUsage();
      break;
    }

    case undefined: {
      // Launch TUI
      const projectRoot = findProjectRoot();
      if (!projectRoot) {
        console.error('Not in a novatree project. Run `novatree init` first.');
        process.exit(1);
      }

      const config = loadConfig(projectRoot);
      initLogger(join(projectRoot, '.novatree'));

      render(<App projectRoot={projectRoot} config={config} />, {
        exitOnCtrlC: true,
      });
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

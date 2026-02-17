import type { LlmEndpoint } from '../core/config.js';
import type { LlmRequest, LlmResponse, StreamEvent, EndpointHealth } from './types.js';
import { LlmClient } from './client.js';
import { logger } from '../utils/logger.js';

interface EndpointState {
  config: LlmEndpoint;
  client: LlmClient;
  healthy: boolean;
  lastCheck: Date;
  currentRequests: number;
  weightCounter: number;
}

export class LlmRouter {
  private endpoints: EndpointState[] = [];
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private queue: Array<{
    request: LlmRequest;
    resolve: (value: LlmResponse) => void;
    reject: (reason: unknown) => void;
  }> = [];

  constructor(
    endpointConfigs: LlmEndpoint[],
    private healthCheckIntervalMs: number = 30000,
  ) {
    this.endpoints = endpointConfigs.map(config => ({
      config,
      client: new LlmClient(config.url),
      healthy: true, // Assume healthy until first check
      lastCheck: new Date(),
      currentRequests: 0,
      weightCounter: 0,
    }));
  }

  async start(): Promise<void> {
    // Initial health check
    await this.checkAllHealth();

    // Periodic health checks
    this.healthCheckTimer = setInterval(() => {
      this.checkAllHealth().catch(err => {
        logger.error('router', 'Health check cycle failed', err);
      });
    }, this.healthCheckIntervalMs);
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async checkAllHealth(): Promise<void> {
    const checks = this.endpoints.map(async ep => {
      const wasHealthy = ep.healthy;
      ep.healthy = await ep.client.healthCheck();
      ep.lastCheck = new Date();
      if (wasHealthy !== ep.healthy) {
        logger.info('router', `Endpoint ${ep.config.name}: ${ep.healthy ? 'healthy' : 'unhealthy'}`);
      }
    });
    await Promise.allSettled(checks);
    // Try to drain queue after health changes
    this.drainQueue();
  }

  private selectEndpoint(): EndpointState | null {
    const available = this.endpoints.filter(
      ep => ep.healthy && ep.currentRequests < ep.config.maxConcurrent,
    );
    if (available.length === 0) return null;

    // Weighted round-robin: pick the endpoint with the highest remaining weight
    let best: EndpointState | null = null;
    for (const ep of available) {
      if (!best || ep.weightCounter < best.weightCounter) {
        best = ep;
      }
    }

    if (best) {
      best.weightCounter++;
      // Reset counters when all have been incremented proportionally
      const totalWeight = this.endpoints.reduce((s, e) => s + e.config.weight, 0);
      if (best.weightCounter >= best.config.weight) {
        const allMaxed = available.every(ep => ep.weightCounter >= ep.config.weight);
        if (allMaxed) {
          for (const ep of this.endpoints) {
            ep.weightCounter = 0;
          }
        }
      }
    }

    return best;
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const endpoint = this.selectEndpoint();
      if (!endpoint) break;

      const item = this.queue.shift()!;
      this.executeRequest(endpoint, item.request)
        .then(item.resolve)
        .catch(item.reject);
    }
  }

  private async executeRequest(
    endpoint: EndpointState,
    request: LlmRequest,
  ): Promise<LlmResponse> {
    endpoint.currentRequests++;
    try {
      const response = await endpoint.client.complete(request);
      return response;
    } catch (err) {
      logger.error('router', `Request to ${endpoint.config.name} failed`, err);
      endpoint.healthy = false;
      throw err;
    } finally {
      endpoint.currentRequests--;
      this.drainQueue();
    }
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const endpoint = this.selectEndpoint();
    if (endpoint) {
      return this.executeRequest(endpoint, request);
    }

    // Queue the request
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
    });
  }

  async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
    const endpoint = this.selectEndpoint();
    if (!endpoint) {
      throw new Error('No healthy endpoints available');
    }

    endpoint.currentRequests++;
    try {
      yield* endpoint.client.stream(request);
    } finally {
      endpoint.currentRequests--;
      this.drainQueue();
    }
  }

  getHealth(): EndpointHealth[] {
    return this.endpoints.map(ep => ({
      name: ep.config.name,
      url: ep.config.url,
      healthy: ep.healthy,
      lastCheck: ep.lastCheck,
      currentRequests: ep.currentRequests,
      maxConcurrent: ep.config.maxConcurrent,
    }));
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getHealthySummary(): string {
    const healthy = this.endpoints.filter(e => e.healthy).length;
    return `${healthy}/${this.endpoints.length} healthy`;
  }
}

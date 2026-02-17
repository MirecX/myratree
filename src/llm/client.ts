import type { LlmRequest, LlmResponse, StreamEvent } from './types.js';
import { logger } from '../utils/logger.js';

export class LlmClient {
  constructor(private baseUrl: string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl}/v1/messages`;
    logger.debug('llm-client', `POST ${url}`, { model: request.model });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'nokey',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body}`);
    }

    return (await response.json()) as LlmResponse;
  }

  async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
    const url = `${this.baseUrl}/v1/messages`;
    logger.debug('llm-client', `POST ${url} (streaming)`, { model: request.model });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'nokey',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM stream failed (${response.status}): ${body}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try {
            yield JSON.parse(data) as StreamEvent;
          } catch {
            logger.warn('llm-client', `Failed to parse SSE data: ${data}`);
          }
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: { 'x-api-key': 'nokey' },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

import type { LlmRequest, LlmResponse, StreamEvent } from './types.js';
import { logger } from '../utils/logger.js';
import { appendFileSync } from 'fs';

let llmLogFile: string | null = null;

export function enableLlmDebugLog(filePath: string): void {
  llmLogFile = filePath;
  // Write CSV header
  appendFileSync(filePath, 'DateTime,Direction,Endpoint,Model,InputTokens,OutputTokens,TotalMs,TTFT_Ms,TPS,MessagePreview\n');
}

function llmLog(entry: {
  direction: 'REQ' | 'RES' | 'ERR';
  endpoint: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalMs?: number;
  ttftMs?: number;
  tps?: number;
  preview?: string;
}): void {
  if (!llmLogFile) return;
  const now = new Date().toISOString();
  const preview = (entry.preview ?? '').replace(/"/g, '""').replace(/\n/g, ' ').substring(0, 200);
  const line = [
    now,
    entry.direction,
    entry.endpoint,
    entry.model,
    entry.inputTokens ?? '',
    entry.outputTokens ?? '',
    entry.totalMs ?? '',
    entry.ttftMs ?? '',
    entry.tps !== undefined ? entry.tps.toFixed(1) : '',
    `"${preview}"`,
  ].join(',');
  try {
    appendFileSync(llmLogFile, line + '\n');
  } catch { /* ignore */ }
}

function extractPreview(request: LlmRequest): string {
  const lastMsg = request.messages[request.messages.length - 1];
  if (!lastMsg) return '';
  if (typeof lastMsg.content === 'string') return lastMsg.content;
  const textBlock = lastMsg.content.find(b => b.type === 'text' && b.text);
  if (textBlock?.text) return textBlock.text;
  const toolResult = lastMsg.content.find(b => b.type === 'tool_result' && b.content);
  if (toolResult?.content) return `[tool_result] ${toolResult.content}`;
  return `[${lastMsg.content.map(b => b.type).join(',')}]`;
}

function extractResponsePreview(response: LlmResponse): string {
  for (const block of response.content) {
    if (block.type === 'text' && block.text) return block.text;
    if (block.type === 'tool_use' && block.name) return `[tool_use: ${block.name}]`;
  }
  return '';
}

export class LlmClient {
  constructor(private baseUrl: string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl}/v1/messages`;
    logger.debug('llm-client', `POST ${url}`, { model: request.model });

    llmLog({
      direction: 'REQ',
      endpoint: this.baseUrl,
      model: request.model,
      preview: extractPreview(request),
    });

    const startTime = Date.now();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || 'nokey',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!response.ok) {
      const body = await response.text();
      const totalMs = Date.now() - startTime;
      llmLog({
        direction: 'ERR',
        endpoint: this.baseUrl,
        model: request.model,
        totalMs,
        preview: `${response.status}: ${body}`,
      });
      throw new Error(`LLM request failed (${response.status}): ${body}`);
    }

    const result = (await response.json()) as LlmResponse;
    const totalMs = Date.now() - startTime;
    const outputTokens = result.usage?.output_tokens ?? 0;
    const tps = totalMs > 0 ? (outputTokens / (totalMs / 1000)) : 0;

    llmLog({
      direction: 'RES',
      endpoint: this.baseUrl,
      model: request.model,
      inputTokens: result.usage?.input_tokens,
      outputTokens,
      totalMs,
      tps,
      preview: extractResponsePreview(result),
    });

    return result;
  }

  async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
    const url = `${this.baseUrl}/v1/messages`;
    logger.debug('llm-client', `POST ${url} (streaming)`, { model: request.model });

    llmLog({
      direction: 'REQ',
      endpoint: this.baseUrl,
      model: request.model,
      preview: `[stream] ${extractPreview(request)}`,
    });

    const startTime = Date.now();
    let ttftMs: number | undefined;
    let outputTokens = 0;
    let inputTokens = 0;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || 'nokey',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!response.ok) {
      const body = await response.text();
      const totalMs = Date.now() - startTime;
      llmLog({
        direction: 'ERR',
        endpoint: this.baseUrl,
        model: request.model,
        totalMs,
        preview: `[stream] ${response.status}: ${body}`,
      });
      throw new Error(`LLM stream failed (${response.status}): ${body}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let firstText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              const totalMs = Date.now() - startTime;
              const tps = totalMs > 0 ? (outputTokens / (totalMs / 1000)) : 0;
              llmLog({
                direction: 'RES',
                endpoint: this.baseUrl,
                model: request.model,
                inputTokens,
                outputTokens,
                totalMs,
                ttftMs,
                tps,
                preview: `[stream] ${firstText}`,
              });
              return;
            }
            try {
              const event = JSON.parse(data) as StreamEvent;

              // Track TTFT on first content
              if (!ttftMs && event.type === 'content_block_delta' && event.delta?.text) {
                ttftMs = Date.now() - startTime;
                firstText = event.delta.text;
              }

              // Capture text for preview
              if (event.type === 'content_block_delta' && event.delta?.text && firstText.length < 200) {
                firstText += event.delta.text;
              }

              // Capture usage from message_delta
              if (event.type === 'message_delta' && event.delta) {
                const usage = (event as any).usage;
                if (usage) {
                  outputTokens = usage.output_tokens ?? outputTokens;
                }
              }

              // Capture usage from message_start
              if (event.type === 'message_start' && event.message?.usage) {
                inputTokens = event.message.usage.input_tokens ?? 0;
              }

              yield event;
            } catch {
              logger.warn('llm-client', `Failed to parse SSE data: ${data}`);
            }
          }
        }
      }
    } finally {
      // If stream ends without [DONE], still log
      const totalMs = Date.now() - startTime;
      if (!ttftMs) ttftMs = totalMs;
      const tps = totalMs > 0 ? (outputTokens / (totalMs / 1000)) : 0;
      llmLog({
        direction: 'RES',
        endpoint: this.baseUrl,
        model: request.model,
        inputTokens,
        outputTokens,
        totalMs,
        ttftMs,
        tps,
        preview: `[stream/end] ${firstText}`,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || 'nokey' },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LlmRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  stream?: boolean;
}

export interface LlmResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface StreamEvent {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop' |
        'message_start' | 'message_delta' | 'message_stop' | 'ping' | 'error';
  index?: number;
  content_block?: ContentBlock;
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: LlmResponse;
  error?: { type: string; message: string };
}

export interface EndpointHealth {
  name: string;
  url: string;
  healthy: boolean;
  lastCheck: Date;
  currentRequests: number;
  maxConcurrent: number;
}

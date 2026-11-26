// Minimal OpenAI Responses compatibility layer.
// Internally the gateway keeps using Anthropic Messages so existing provider
// adapters, tool handling, usage accounting, and retry behavior stay shared.
import { randomUUID } from 'node:crypto';
import { ssePayloads } from '../sse.js';

const enc = new TextEncoder();
const responseStore = new Map();

function createEmitter() {
  let sequence = 0;
  return (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify({ ...data, sequence_number: sequence++ })}\n\n`);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part?.text ?? part?.value ?? '').join('');
}

function inputParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      return [{ type: 'text', text: part.text ?? part.value ?? '' }];
    }
    if (part.type === 'input_image' || part.type === 'image') {
      const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      return [{ type: 'image', source: imageUrl ? { type: 'url', url: imageUrl } : part.source }];
    }
    return [];
  });
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('function arguments must be an object');
    return parsed;
  } catch (error) {
    throw new Error(`Responses function arguments invalid: ${error.message}`);
  }
}

function appendMessage(messages, role, content) {
  const parts = inputParts(content);
  if (parts.length || role === 'user') messages.push({ role, content: parts.length ? parts : '' });
}

export function responsesToAnthropic(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Responses body must be an object');
  if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('Responses request requires model');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new Error('Responses stream must be boolean');
  const messages = [];
  const system = body.instructions ? textOf(body.instructions) : undefined;
  const input = body.input ?? '';

  if (body.previous_response_id) {
    const previous = responseStore.get(body.previous_response_id);
    if (!previous) throw new Error(`Unknown previous_response_id: ${body.previous_response_id}`);
    for (const item of previous.output ?? []) {
      if (item.type === 'message') appendMessage(messages, 'assistant', item.content);
      else if (item.type === 'function_call') messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id ?? item.id, name: item.name, input: parseArguments(item.arguments) }] });
    }
  }

  if (typeof input === 'string') {
    appendMessage(messages, 'user', input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') throw new Error('Responses input item must be an object');
      if (item.type === 'message' || item.role) {
        appendMessage(messages, item.role === 'assistant' ? 'assistant' : item.role === 'system' || item.role === 'developer' ? 'system' : 'user', item.content);
      } else if (item.type === 'function_call') {
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id ?? item.id ?? randomUUID(), name: item.name, input: parseArguments(item.arguments) }] });
      } else if (item.type === 'function_call_output') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: item.call_id, content: String(item.output ?? '') }] });
      } else if (item.type === 'input_text') {
        appendMessage(messages, 'user', [item]);
      } else {
        throw new Error(`Unsupported Responses input item type: ${item.type ?? '(missing)'}`);
      }
    }
  } else {
    throw new Error('Responses input must be a string or array');
  }

  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || (tool.type !== 'function' && tool.type !== undefined)) throw new Error('Only function tools are supported by this gateway');
    if (typeof tool.name !== 'string' || !tool.name) throw new Error('Function tool requires name');
    return { name: tool.name, description: tool.description ?? '', input_schema: tool.parameters ?? { type: 'object', properties: {} } };
  }) : undefined;
  const choice = body.tool_choice;
  const tool_choice = choice === 'none' ? { type: 'none' }
    : choice === 'required' ? { type: 'any' }
      : choice?.type === 'function' ? { type: 'tool', name: choice.name }
        : undefined;

  return {
    model: body.model,
    ...(system ? { system } : {}),
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    max_tokens: body.max_output_tokens ?? body.max_tokens ?? 4096,
    stream: Boolean(body.stream),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
  };
}

function responseUsage(usage = {}) {
  const cached = Number(usage.cache_read_input_tokens ?? 0) || 0;
  const written = Number(usage.cache_creation_input_tokens ?? 0) || 0;
  const input = (Number(usage.input_tokens ?? 0) || 0) + cached + written;
  const output = Number(usage.output_tokens ?? 0) || 0;
  const details = {};
  // 标准字段 cached_tokens 保持原样；缓存写入走兼容字段，只在来源明确上报写入时添加。
  if (usage.cache_read_input_tokens != null) details.cached_tokens = cached;
  if (usage.cache_creation_input_tokens != null) details.cache_write_tokens = written;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output,
    ...(Object.keys(details).length ? { input_tokens_details: details } : {}) };
}

function outputItems(message) {
  const items = [];
  for (const block of message?.content ?? []) {
    if (block?.type === 'text') {
      items.push({
        id: message.id ?? `msg_${randomUUID().slice(0, 12)}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', annotations: [], text: block.text ?? '' }],
      });
    } else if (block?.type === 'tool_use') {
      items.push({
        id: block.id ?? `fc_${randomUUID().slice(0, 12)}`,
        type: 'function_call',
        status: 'completed',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  if (!items.length) {
    items.push({ id: `msg_${randomUUID().slice(0, 12)}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: '' }] });
  }
  return items;
}

export function anthropicToResponses(message, requestedModel, responseId = `resp_${randomUUID().replaceAll('-', '')}`) {
  const output = outputItems(message);
  const outputText = output.flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text).join('');
  const response = {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: requestedModel,
    output,
    output_text: outputText,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: responseUsage(message?.usage),
    metadata: {},
  };
  responseStore.set(responseId, response);
  while (responseStore.size > 128) responseStore.delete(responseStore.keys().next().value);
  return response;
}

export function responsesJsonToStream(response) {
  const responseId = response.id;
  const emit = createEmitter();
  const iterator = (async function* () {
    yield emit('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [], output_text: '', usage: null } });
    yield emit('response.in_progress', { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [], output_text: '', usage: null } });
    for (const [outputIndex, item] of response.output.entries()) {
      yield emit('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress' } });
      if (item.type === 'message') {
        for (const [contentIndex, part] of item.content.entries()) {
          yield emit('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { ...part, text: '' } });
          if (part.text) yield emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text });
          yield emit('response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text ?? '' });
          yield emit('response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part });
        }
      } else if (item.type === 'function_call') {
        if (item.arguments) yield emit('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: item.arguments });
        yield emit('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: item.arguments });
      }
      yield emit('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    }
    yield emit('response.completed', { type: 'response.completed', response });
    void responseId;
  })();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close(); else controller.enqueue(next.value);
    },
    async cancel() { await iterator.return(); },
  });
}

export function anthropicToResponsesStream(upstreamBody, requestedModel, options = {}) {
  const responseId = `resp_${randomUUID().replaceAll('-', '')}`;
  const emit = createEmitter();
  const state = { message: { type: 'message', role: 'assistant', content: [], usage: {} }, text: '', blocks: new Map(), usage: {} };
  const iterator = (async function* () {
    yield emit('response.created', { type: 'response.created', response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: requestedModel, output: [], output_text: '', usage: null } });
    yield emit('response.in_progress', { type: 'response.in_progress', response: { id: responseId, object: 'response', status: 'in_progress', model: requestedModel, output: [], output_text: '', usage: null } });
    let outputIndex = 0;
    for await (const raw of ssePayloads(upstreamBody)) {
      const event = JSON.parse(raw);
      if (event.type === 'message_start') {
        state.message.id = event.message?.id;
        state.usage = event.message?.usage ?? {};
        try { options.onUsage?.({ ...state.usage }); } catch { /* Usage reporting must not affect the stream. */ }
        continue;
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block ?? {};
        state.blocks.set(event.index, { outputIndex, block, text: '', args: '', itemId: block.type === 'text' ? (state.message.id ?? `msg_${randomUUID().slice(0, 12)}`) : block.id });
        if (block.type === 'text') {
          const item = { id: state.blocks.get(event.index).itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: '' }] };
          state.message.content.push({ type: 'text', text: '' });
          yield emit('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
          yield emit('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: 0, part: item.content[0] });
        } else if (block.type === 'tool_use') {
          const item = { id: state.blocks.get(event.index).itemId, type: 'function_call', status: 'in_progress', call_id: block.id, name: block.name, arguments: '' };
          state.message.content.push({ type: 'tool_use', id: block.id, name: block.name, input: {} });
          yield emit('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
        }
        outputIndex++;
        continue;
      }
      const current = state.blocks.get(event.index);
      if (event.type === 'content_block_delta' && current) {
        if (event.delta?.type === 'text_delta') {
          current.text += event.delta.text ?? '';
          state.text += event.delta.text ?? '';
          const item = state.message.content.find((b) => b.type === 'text');
          if (item) item.text = current.text;
          yield emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: current.itemId, output_index: current.outputIndex, content_index: 0, delta: event.delta.text ?? '' });
        } else if (event.delta?.type === 'input_json_delta') {
          current.args += event.delta.partial_json ?? '';
          yield emit('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: current.block.id, output_index: current.outputIndex, delta: event.delta.partial_json ?? '' });
        }
        continue;
      }
      if (event.type === 'content_block_stop' && current) {
        if (current.block.type === 'text') {
          yield emit('response.output_text.done', { type: 'response.output_text.done', item_id: current.itemId, output_index: current.outputIndex, content_index: 0, text: current.text });
          yield emit('response.content_part.done', { type: 'response.content_part.done', item_id: current.itemId, output_index: current.outputIndex, content_index: 0, part: { type: 'output_text', annotations: [], text: current.text } });
          yield emit('response.output_item.done', { type: 'response.output_item.done', output_index: current.outputIndex, item: { id: current.itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: current.text }] } });
        } else if (current.block.type === 'tool_use') {
          const toolBlock = state.message.content.find((b) => b.type === 'tool_use' && b.id === current.block.id);
          if (toolBlock) {
            toolBlock.input = parseArguments(current.args);
          }
          yield emit('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: current.itemId, output_index: current.outputIndex, arguments: current.args });
          yield emit('response.output_item.done', { type: 'response.output_item.done', output_index: current.outputIndex, item: { id: current.itemId, type: 'function_call', status: 'completed', call_id: current.block.id, name: current.block.name, arguments: current.args } });
        }
        continue;
      }
      if (event.type === 'message_delta') {
        for (const [key, value] of Object.entries(event.usage ?? {})) {
          if (value != null) state.usage[key] = value;
        }
        try { options.onUsage?.(event.usage); } catch { /* Usage reporting must not affect the stream. */ }
        continue;
      }
      if (event.type === 'message_stop') continue;
    }
    const response = anthropicToResponses(state.message, requestedModel, responseId);
    response.output_text = state.text || response.output_text;
    response.usage = responseUsage(state.usage);
    yield emit('response.completed', { type: 'response.completed', response });
  })();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) {
        controller.enqueue(emit('error', { type: 'error', error: { type: 'server_error', message: error.message } }));
        controller.close();
      }
    },
    async cancel() { await iterator.return(); },
  });
}

export const RESPONSES_SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

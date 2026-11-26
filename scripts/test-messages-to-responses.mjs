import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResponsesBody, responseToCompletion, parseCompletion, toChatStream } from '../src/providers/messages-to-responses.js';
import { openAIToAnthropicStream } from '../src/stream.js';

function sse(events) {
  const text = events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

test('Messages body converts text, image, tools and tool results to Responses input', () => {
  const body = buildResponsesBody({
    model: 'route-model',
    system: 'be concise',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'exec', input: { cmd: 'pwd' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
    ],
    tools: [{ name: 'exec', description: 'run command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'exec' },
    stream: true,
  }, 'real-model');
  assert.equal(body.model, 'real-model');
  assert.equal(body.instructions, 'be concise');
  // 同一 user 消息里的文本与图片合并成一个 input item，顺序不变
  assert.deepEqual(body.input[0].content.map((part) => part.type), ['input_text', 'input_image']);
  assert.equal(body.input[0].content[0].text, 'inspect');
  assert.equal(body.input[0].content[1].image_url, 'https://example.test/a.png');
  assert.deepEqual(body.input[1], { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"pwd"}' });
  assert.deepEqual(body.input[2], { type: 'function_call_output', call_id: 'call_1', output: 'done' });
  assert.equal(body.tools[0].type, 'function');
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'exec' });
});

test('Messages body rejects unsupported protocol shapes instead of dropping them', () => {
  assert.throws(() => buildResponsesBody({ messages: [{ role: 'user', content: [{ type: 'document' }] }] }, 'm'), /Unsupported Messages content block/);
  assert.throws(() => buildResponsesBody({ stop_sequences: ['stop'], messages: [] }, 'm'), /stop_sequences/);
  assert.throws(() => buildResponsesBody({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f1' } }] }] }, 'm'), /Unsupported Messages image source/);
  assert.throws(() => buildResponsesBody({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'document' }] }] }] }, 'm'), /text-only/);
});

// DeepSeek Harness 的请求形状：必带顶层 thinking 开关、system 角色的 tool_addition
// 控制块、助手历史里的带签名思考块、工具结果里可能内联图片。
test('DeepSeek Harness Messages shapes convert instead of failing the whole request', () => {
  const body = buildResponsesBody({
    model: 'route-model',
    stream: true,
    thinking: { type: 'enabled' },
    system: 'You are a coding agent.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'search' } }] },
      { role: 'system', content: [{ type: 'text', text: 'tools changed' }, { type: 'tool_removal', tool: { type: 'tool_reference', name: 'fetch' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason', signature: 'sig' }, { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'done' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }] },
    ],
    tools: [{ name: 'search', description: 'search', input_schema: { type: 'object' }, defer_loading: true }],
  }, 'real-model');

  assert.equal(body.model, 'real-model');
  // 只有控制块的 system 消息整体省略；带文本的保留文本，控制块被跳过
  assert.equal(body.instructions, 'You are a coding agent.\n\ntools changed');
  // 思考块被跳过，工具调用保留；文本与图片合并成一个 item，顺序不变
  assert.deepEqual(body.input[0].content.map((part) => part.type), ['input_text', 'input_image']);
  assert.deepEqual(body.input.slice(1).map((item) => item.type), ['function_call', 'function_call_output']);
  assert.deepEqual(body.input[1], { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' });
  // 工具结果里的图片降级为标记，不丢整条结果
  assert.match(body.input[2].output, /^done\n\[图片输入在非 Anthropic 上游被忽略\]$/);
  assert.equal(body.tools[0].name, 'search');
});

test('Messages body groups same-message content, uses output_text for assistant and keeps tool order', () => {
  const body = buildResponsesBody({
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'call_1', name: 'exec', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }, { type: 'text', text: 'and do more' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
  }, 'm');
  // 助手文本用 output_text；文本与紧随其后的工具调用保持先后顺序
  assert.deepEqual(body.input[0], { role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] });
  assert.deepEqual(body.input[1], { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{}' });
  // 工具结果先于同一条 user 消息里的文本
  assert.deepEqual(body.input[2], { type: 'function_call_output', call_id: 'call_1', output: 'ok' });
  assert.deepEqual(body.input[3], { role: 'user', content: [{ type: 'input_text', text: 'and do more' }] });
  assert.deepEqual(body.input[4], { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] });
});

test('buildResponsesBody adds a stable prompt_cache_key only when a session context exists', () => {
  const withSession = buildResponsesBody({ messages: [{ role: 'user', content: 'hi' }] }, 'm', { codexContext: { sessionId: 'session-abc' } });
  assert.equal(withSession.prompt_cache_key, 'session-abc');
  assert.equal(withSession.store, false);
  assert.equal(withSession.max_output_tokens, 4096);
  const withoutSession = buildResponsesBody({ messages: [{ role: 'user', content: 'hi' }] }, 'm');
  assert.equal(Object.hasOwn(withoutSession, 'prompt_cache_key'), false);
  const blankSession = buildResponsesBody({ messages: [{ role: 'user', content: 'hi' }] }, 'm', { codexContext: {} });
  assert.equal(Object.hasOwn(blankSession, 'prompt_cache_key'), false);
});

test('Responses JSON converts text, tool calls and cache usage to Chat Completion', () => {
  const out = responseToCompletion({
    id: 'resp_1', status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"pwd"}' },
    ],
    usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 12 } },
  });
  assert.equal(out.choices[0].message.content, 'done');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'exec');
  assert.equal(out.usage.prompt_tokens, 20);
  assert.equal(out.usage.prompt_tokens_details.cached_tokens, 12);
});

test('Responses usage keeps every original field and only adds Chat aliases for valid sources', () => {
  const out = responseToCompletion({
    id: 'r', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
    usage: {
      input_tokens: 20, output_tokens: 4, total_tokens: 24,
      input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 3 },
    },
  });
  assert.deepEqual(out.usage, {
    input_tokens: 20, output_tokens: 4, total_tokens: 24,
    input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 3 },
    prompt_tokens: 20, completion_tokens: 4,
    prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 3 },
  });

  // 缺 input_tokens 源字段时不注入 prompt_tokens: undefined，已有的兼容字段原样保留
  const compat = responseToCompletion({
    id: 'r', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
    usage: { output_tokens: 5, prompt_tokens: 7 },
  });
  assert.deepEqual(compat.usage, { output_tokens: 5, prompt_tokens: 7, completion_tokens: 5 });
  assert.equal(Object.hasOwn(compat.usage, 'prompt_tokens_details'), false);
});

test('Responses usage details merge native and compatible sources instead of overwriting', () => {
  const out = responseToCompletion({
    id: 'r', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
    usage: {
      input_tokens: 30, output_tokens: 5,
      input_tokens_details: { cached_tokens: 12 },
      prompt_tokens_details: { cache_write_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 2 },
      completion_tokens_details: { accepted_prediction_tokens: 1 },
    },
  });
  // 源同时带原生与兼容 details：合并保留双方字段，而不是整体覆盖
  assert.deepEqual(out.usage.prompt_tokens_details, { cache_write_tokens: 4, cached_tokens: 12 });
  assert.deepEqual(out.usage.completion_tokens_details, { accepted_prediction_tokens: 1, reasoning_tokens: 2 });
  assert.equal(out.usage.prompt_tokens, 30);
  assert.equal(out.usage.completion_tokens, 5);
});

test('parseCompletion accumulates segment usage and keeps reported fields on a partial terminal', async () => {
  // 终止事件完全没带 usage：保留先到分段已上报的字段，不编造未上报的输出
  const fromSegments = await parseCompletion(sse([
    { type: 'response.in_progress', response: { usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 5 } } } },
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] } },
  ]));
  assert.equal(fromSegments.usage.input_tokens, 40);
  assert.deepEqual(fromSegments.usage.input_tokens_details, { cached_tokens: 5 });
  assert.equal(fromSegments.usage.output_tokens, undefined);
  assert.equal(Object.hasOwn(fromSegments.usage, 'completion_tokens'), false);

  // 终止事件只带部分 usage：与先到字段合并，双方字段都保留
  const partial = await parseCompletion(sse([
    { type: 'response.in_progress', response: { usage: { input_tokens: 40 } } },
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { output_tokens: 3 } } },
  ]));
  assert.equal(partial.usage.input_tokens, 40);
  assert.equal(partial.usage.output_tokens, 3);
  assert.equal(partial.usage.completion_tokens, 3);
});

test('toChatStream emits early usage as its own accounting frame and terminal usage merged, zero preserved', async () => {
  const output = await readStream(toChatStream(sse([
    { type: 'response.in_progress', response: { usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 0 } } } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hi' },
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { output_tokens: 2 } } },
  ]).body));
  const frames = output.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  // 早期分段 usage 单独成帧（choices 为空），供记账消费
  const early = frames.find((frame) => frame.choices.length === 0 && frame.usage);
  assert.deepEqual(early.usage, { input_tokens: 30, input_tokens_details: { cached_tokens: 0 } });
  // 终止帧带合并后的 usage：早期输入 + 终止输出，零值字段保留
  const terminal = frames.at(-1);
  assert.equal(terminal.usage.input_tokens, 30);
  assert.equal(terminal.usage.output_tokens, 2);
  assert.equal(terminal.usage.completion_tokens, 2);
  assert.deepEqual(terminal.usage.input_tokens_details, { cached_tokens: 0 });
});

test('toChatStream keeps usage reported before a terminal event that omits usage', async () => {
  const output = await readStream(toChatStream(sse([
    { type: 'response.in_progress', response: { usage: { input_tokens: 11, output_tokens: 0 } } },
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } },
  ]).body));
  const frames = output.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const terminal = frames.at(-1);
  assert.equal(terminal.usage.input_tokens, 11);
  assert.equal(terminal.usage.output_tokens, 0);
});

test('Responses usage aliases survive the streaming Chat and Anthropic conversions', async () => {
  const output = await readStream(openAIToAnthropicStream(toChatStream(sse([
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hi' },
    { type: 'response.completed', response: {
      id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
      usage: { input_tokens: 30, output_tokens: 2, input_tokens_details: { cached_tokens: 20 } },
    } },
  ]).body), 'm'));
  const frames = output.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(frames.find((frame) => frame.type === 'message_delta').usage, { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20 });
});

test('Responses JSON and SSE failures are rejected', async () => {
  await assert.rejects(parseCompletion(new Response(JSON.stringify({ status: 'failed', error: { message: 'no' } }), { headers: { 'content-type': 'application/json' } })), /did not complete/);
  await assert.rejects(parseCompletion(sse([{ type: 'response.completed', response: { id: 'x', status: 'completed', output: [{ type: 'unsupported' }] } }])), /Unsupported Responses output item/);
  await assert.rejects(parseCompletion(new Response('data: {"type":"response.failed"}\n\n', { headers: { 'content-type': 'text/event-stream' } })), /failed/);
});

test('Responses SSE text and function argument deltas become Chat Completion SSE', async () => {
  const result = {
    id: 'resp_stream', status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"pwd"}' },
    ],
    usage: { input_tokens: 3, output_tokens: 2 },
  };
  const output = await readStream(toChatStream(sse([
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'exec' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"cmd":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"pwd"}' },
    { type: 'response.completed', response: result },
  ]).body));
  assert.match(output, /"content":"hello"/);
  assert.match(output, /"name":"exec"/);
  assert.match(output, /\\\"cmd\\\":/);
  assert.match(output, /"finish_reason":"tool_calls"/);
  assert.match(output, /"prompt_tokens":3/);
});

test('Responses SSE without terminal event fails', async () => {
  await assert.rejects(readStream(toChatStream(sse([{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' }]).body)), /ended without a terminal event/);
});

test('full Messages stream emits each tool exactly once after text/reasoning output indexes', async () => {
  const tools = [
    { type: 'function_call', call_id: 'a', name: 'exec', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call', call_id: 'b', name: 'read', arguments: '{"path":"file.txt"}' },
  ];
  const events = [
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'hello' },
    ...tools.flatMap((item, index) => [
      { type: 'response.output_item.added', output_index: index + 2, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: index + 2, delta: item.arguments },
    ]),
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [
      { type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'hello' }] }, ...tools,
    ], usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 12 } } } },
  ];
  const output = await readStream(openAIToAnthropicStream(toChatStream(sse(events).body), 'original-model'));
  const frames = output.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const blocks = frames.filter((frame) => frame.content_block?.type === 'tool_use');
  assert.deepEqual(blocks.map((frame) => [frame.content_block.id, frame.content_block.name]), [['a', 'exec'], ['b', 'read']]);
  assert.deepEqual(frames.filter((frame) => frame.delta?.type === 'input_json_delta').map((frame) => JSON.parse(frame.delta.partial_json)), [{ cmd: 'pwd' }, { path: 'file.txt' }]);
  assert.equal(frames.at(-1).type, 'message_stop');
  assert.equal(frames.find((frame) => frame.type === 'message_delta').usage.cache_read_input_tokens, 12);
  assert.equal(frames.some((frame) => frame.type === 'error'), false);
});

test('a tool-only completion keeps exactly one tool block and gains no empty text block', async () => {
  const chunks = [
    { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec', arguments: '{"cmd":"pwd"}' } }] }, finish_reason: null }] },
    { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const upstream = new Response(chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  const output = await readStream(openAIToAnthropicStream(upstream.body, 'm'));
  const frames = output.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(frames.filter((frame) => frame.type === 'content_block_start').map((frame) => frame.content_block.type), ['tool_use']);
  assert.equal(frames.filter((frame) => frame.type === 'content_block_start').length, 1);
  assert.equal(frames.find((frame) => frame.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('cancelling a Responses stream releases the upstream reader immediately', async () => {
  let cancelled = false;
  const upstream = new ReadableStream({ cancel() { cancelled = true; } });
  const reader = toChatStream(upstream).getReader();
  const pending = reader.read();
  await reader.cancel();
  await pending;
  assert.equal(cancelled, true);
  assert.equal(upstream.locked, false);
});

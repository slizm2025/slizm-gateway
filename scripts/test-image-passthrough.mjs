// 回归测试：Anthropic 图片块 → Chat Completions image_url 部件的透传规则。
// 网关是 Messages 客户端（DSH / Claude Code）与聊天补全上游之间的翻译层；
// 以前 image 块一律降级成占位符文字，视觉模型永远看不到图。
// 现在 base64 / url 来源要翻成 image_url，无法表达的文件句柄才降级。
import assert from 'node:assert/strict';
import { toOpenAIMessages, NON_ANTHROPIC_IMAGE_PLACEHOLDER } from '../src/providers/openai.js';

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imageBlock = (source) => ({ type: 'image', source });

// 1. base64 图片：翻成 data URL，文本在前、图片在后，文本仍是纯字符串以外的部件数组。
const base64Messages = toOpenAIMessages(undefined, [
  { role: 'user', content: [{ type: 'text', text: 'what is in this image?' }, imageBlock({ type: 'base64', media_type: 'image/png', data: TINY_PNG })] },
]);
assert.equal(base64Messages.length, 1);
assert.equal(base64Messages[0].role, 'user');
assert.deepEqual(base64Messages[0].content, [
  { type: 'text', text: 'what is in this image?' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
]);

// 2. 只有图片没有文本：content 里不应出现空文本部件。
const imageOnly = toOpenAIMessages(undefined, [
  { role: 'user', content: [imageBlock({ type: 'base64', media_type: 'image/jpeg', data: TINY_PNG })] },
]);
assert.deepEqual(imageOnly[0].content, [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${TINY_PNG}` } }]);

// 3. url 来源：原样直传，不加 data 前缀。
const urlImage = toOpenAIMessages(undefined, [
  { role: 'user', content: [imageBlock({ type: 'url', url: 'https://example.com/cat.png' })] },
]);
assert.deepEqual(urlImage[0].content, [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }]);

// 4. 缺 media_type 时退回 image/png，避免把 undefined 写进 data URL。
const defaulted = toOpenAIMessages(undefined, [
  { role: 'user', content: [imageBlock({ type: 'base64', data: TINY_PNG })] },
]);
assert.equal(defaulted[0].content[0].image_url.url, `data:image/png;base64,${TINY_PNG}`);

// 5. Files API 文件句柄无法在网关侧还原成字节：降级为占位符，不能抛错也不能静默丢消息。
const fileSource = toOpenAIMessages(undefined, [
  { role: 'user', content: [imageBlock({ type: 'file', file_id: 'file_abc' })] },
]);
assert.equal(fileSource[0].content, NON_ANTHROPIC_IMAGE_PLACEHOLDER);

// 6. 纯文本消息保持字符串 content：聊天补全里数组形式是给多模态用的，文本不该无端变形。
const plain = toOpenAIMessages(undefined, [{ role: 'user', content: 'hello' }]);
assert.equal(plain[0].content, 'hello');

// 7. tool_result 之后同一消息里的图片仍要透传（工具返回截图/图像的场景）。
const afterTool = toOpenAIMessages(undefined, [
  { role: 'user', content: 'shot it' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'screenshot', input: {} }] },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
      { type: 'text', text: 'here it is' },
      imageBlock({ type: 'base64', media_type: 'image/png', data: TINY_PNG }),
    ],
  },
]);
assert.equal(afterTool.at(-2).role, 'tool');
assert.deepEqual(afterTool.at(-1).content, [
  { type: 'text', text: 'here it is' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
]);

// 8. assistant 消息不带图片部件：聊天补全的 assistant 侧只能输出文本。
const assistantWithImage = toOpenAIMessages(undefined, [
  { role: 'assistant', content: [{ type: 'text', text: 'look' }, imageBlock({ type: 'base64', media_type: 'image/png', data: TINY_PNG })] },
]);
assert.equal(assistantWithImage[0].role, 'assistant');
assert.equal(assistantWithImage[0].content, 'look');

console.log('✓ 图片透传规则通过（base64→data URL、url 直传、file 降级、纯文本不变形、assistant 不带图片）');

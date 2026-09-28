// The request was already JSON-validated. Locate top-level string tokens without
// reserializing other values (notably integers beyond JavaScript's precision).
export function replaceResponseModel(rawBody, targetModel) {
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g;
  let depth = 0;
  let keyExpected = false;
  let modelValue = false;
  let cursor = 0;
  const parts = [];
  for (const match of rawBody.matchAll(tokens)) {
    const token = match[0];
    if (depth === 1 && token.startsWith('"')) {
      if (keyExpected) {
        modelValue = JSON.parse(token) === 'model';
        keyExpected = false;
      } else if (modelValue) {
        parts.push(rawBody.slice(cursor, match.index), JSON.stringify(targetModel));
        cursor = match.index + token.length;
        modelValue = false;
      }
    } else if (token === '{' || token === '[') {
      if (depth === 1 && modelValue) throw new Error('Top-level model must be a string');
      depth++;
      if (depth === 1) keyExpected = true;
    } else if (token === '}' || token === ']') {
      if (depth === 1 && modelValue) throw new Error('Top-level model must be a string');
      depth--;
    } else if (depth === 1 && token === ',') {
      if (modelValue) throw new Error('Top-level model must be a string');
      keyExpected = true;
    }
  }
  if (!parts.length) throw new Error('Missing top-level model');
  parts.push(rawBody.slice(cursor));
  return parts.join('');
}

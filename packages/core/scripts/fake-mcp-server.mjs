// A tiny MCP server over stdio for tests: tools echo (read-only), danger (not read-only), big (long result), objarg (array/object argument).
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const tools = [
  { name: 'echo', description: 'Echo the text back. Extra words that should be cut from the prompt.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'what to echo' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'danger', description: 'Pretend to delete something.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, force: { type: 'boolean' } }, required: ['target'] } },
  { name: 'big', description: 'Return a long text.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'objarg', description: 'Take an array and an object.', inputSchema: { type: 'object', properties: { list: { type: 'array', items: { type: 'number' } }, opts: { type: 'object' } }, required: ['list'] }, annotations: { readOnlyHint: true } },
];
console.log('this stray log line must be ignored');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.2.3' } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
  else if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    if (name === 'echo') send({ id: m.id, result: { content: [{ type: 'text', text: `echo: ${a.text}` }] } });
    else if (name === 'danger') send({ id: m.id, result: { content: [{ type: 'text', text: `deleted ${a.target} force=${a.force}` }] } });
    else if (name === 'big') send({ id: m.id, result: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } });
    else if (name === 'objarg') send({ id: m.id, result: { content: [{ type: 'text', text: `list is ${Array.isArray(a.list) ? 'array of ' + a.list.length : typeof a.list}` }] } });
    else send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: 'unknown tool' }] } });
  } else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'no such method' } });
});

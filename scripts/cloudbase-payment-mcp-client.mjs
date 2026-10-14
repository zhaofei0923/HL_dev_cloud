import { spawn } from 'node:child_process';

// Official MCP stdio keeps secret tool arguments out of process command lines.
// It uses the official client's existing login; no credential files are read.
export class PaymentMcpClient {
  constructor(bin, { envId, region, cwd, timeoutMs = 45000 }) {
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.child = spawn(process.execPath, [bin], { cwd, windowsHide: true,
      env: { ...process.env, CLOUDBASE_ENV_ID: envId, TCB_REGION: region, TCB_SITE: 'domestic' },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch (_) { continue; }
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer); this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error('官方 MCP 操作失败，未输出含凭据的结果'));
        else waiter.resolve(message.result);
      }
    });
    this.child.stderr.on('data', () => {});
    const fail = () => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer); waiter.reject(new Error('官方 MCP 连接中断'));
      }
      this.pending.clear();
    };
    this.child.on('error', fail);
    this.child.on('close', fail);
    this.child.stdin.on('error', fail);
    this.ready = this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'HL-payment-configuration', version: '1.0.0' } }).then(() => {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    });
    this.ready.catch(() => {}); // Deferred callers still receive initialization errors.
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('官方 MCP 操作超时')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args) {
    await this.ready;
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error('官方 MCP 工具未成功，未输出含凭据的结果');
    if (result?.structuredContent) return result.structuredContent;
    for (const item of result?.content || []) {
      if (item.type !== 'text') continue;
      let parsed;
      try { parsed = JSON.parse(item.text); } catch (_) { continue; }
      if (parsed?.success === false) throw new Error('官方 MCP 操作未成功，未输出含凭据的结果');
      return parsed;
    }
    throw new Error('官方 MCP 工具返回格式不符');
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

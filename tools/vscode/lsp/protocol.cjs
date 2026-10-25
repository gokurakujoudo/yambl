'use strict';

// Shared by the stdio server and the small VS Code client. No npm runtime is required.
function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
class Reader {
  constructor(receive) { this.receive = receive; this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffer.length > 8192) throw new Error('LSP header is too large');
        return;
      }
      const header = this.buffer.subarray(0, end).toString('ascii');
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if (!match || Number(match[1]) > 16 * 1024 * 1024) throw new Error('Invalid LSP Content-Length');
      const length = Number(match[1]);
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      this.receive(JSON.parse(body.toString('utf8')));
    }
  }
}
module.exports = { encode, Reader };

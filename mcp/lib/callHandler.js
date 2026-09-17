// mcp/lib/callHandler.js
//
// The api/cj-*.js files are plain (req, res) handlers, written for direct
// mounting as Express routes. Rather than re-deriving their normalization
// logic (variant shapes, stock summaries, friendly status labels, the
// idempotency check in cj-order.js) a second time for MCP tools — which
// would be exactly the kind of business-logic duplication the MCP README
// warned against — this calls the SAME handler function in-process with a
// minimal fake req/res, and captures whatever it would have sent back.

function callHandler(handler, { method = 'GET', query = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, query, body, headers: {} };
    const res = {
      _status: 200,
      status(code) { this._status = code; return this; },
      setHeader() { return this; },
      json(payload) { resolve({ status: this._status, body: payload }); return this; },
      end(payload) { resolve({ status: this._status, body: payload }); return this; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

module.exports = { callHandler };

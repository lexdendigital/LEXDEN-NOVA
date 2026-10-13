// mcp/lib/callHandler.js
//
// The api/*.js files are plain (req, res) handlers, written for direct
// mounting as Express routes. Rather than re-deriving their validation and
// state-machine logic a second time for MCP tools — exactly the kind of
// business-logic duplication that lets two code paths drift apart — this
// calls the SAME handler function in-process with a minimal fake req/res,
// and captures whatever it would have sent back.
//
// `extras` is merged onto the fake request (own enumerable keys AND
// symbols). The Creator MCP uses it to pass the TRUSTED_CREATOR identity
// (see api/creator/shared.js).

function callHandler(handler, { method = 'GET', query = {}, body = {}, extras = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, query, body, headers: {}, ...extras };
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

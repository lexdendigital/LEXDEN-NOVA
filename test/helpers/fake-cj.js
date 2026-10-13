// Scriptable fake of the CJ HTTP API, shaped like fetch().
function makeFakeCj(opts = {}) {
  const st = {
    validKey: 'good-api-key', variants: { VID12345: { vid: 'VID12345', variantSku: 'SKU1', variantSellPrice: 5, variantNameEn: 'Red' } },
    stock: { VID12345: 10 }, freight: { NG: [{ logisticName: 'CJPacket', logisticPrice: 9 }, { logisticName: 'DHL', logisticPrice: 20 }] },
    orders: {}, calls: [], failNext: null, tokenSeq: 0, createOrderDelay: null, ...opts,
  };
  const ok = (data) => ({ status: 200, ok: true, json: async () => ({ result: true, code: 200, data, requestId: 'r' }) });
  const bad = (message, status = 200, code = 1600100) => ({ status, ok: status >= 200 && status < 300, json: async () => ({ result: false, code, message }) });
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace(/^https:\/\/developers\.cjdropshipping\.com\/api2\.0\/v1/, '').split('?')[0];
    const q = Object.fromEntries(new URL(url).searchParams);
    const body = init.body ? JSON.parse(init.body) : null;
    st.calls.push({ path, q, body, token: init.headers && init.headers['CJ-Access-Token'] });
    if (st.failNext) { const f = st.failNext; st.failNext = null; if (f === 'network') throw new Error('boom'); return f; }
    if (path === '/authentication/getAccessToken') {
      if (body.password !== st.validKey) return bad('Email or password is incorrect', 200, 1600001);
      st.tokenSeq += 1;
      return ok({ accessToken: `AT${st.tokenSeq}`, refreshToken: `RT${st.tokenSeq}`, accessTokenExpiryDate: new Date(Date.now() + 15 * 864e5).toISOString(), refreshTokenExpiryDate: new Date(Date.now() + 180 * 864e5).toISOString(), openId: 1 });
    }
    if (path === '/authentication/refreshAccessToken') return bad('refresh unsupported in fake', 200);
    if (!init.headers || !init.headers['CJ-Access-Token']) return bad('no token', 401, 1004001);
    if (path === '/product/getCategory') return ok([{ categoryFirstName: 'x' }]);
    if (path === '/product/variant/queryByVid') return st.variants[q.vid] ? ok(st.variants[q.vid]) : bad('Variant not found');
    if (path === '/product/stock/queryByVid') return st.stock[q.vid] === undefined ? bad('no stock row') : ok([{ storageNum: st.stock[q.vid] }]);
    if (path === '/logistic/freightCalculate') return ok(st.freight[body.endCountryCode] || []);
    if (path === '/shopping/order/getOrderDetail') {
      const o = st.orders[q.orderId] || Object.values(st.orders).find((x) => x.orderNumber === q.orderId);
      return o ? ok(o) : bad('Order not found');
    }
    if (path === '/shopping/order/createOrderV2') {
      if (st.createOrderDelay) await st.createOrderDelay();
      const id = `CJO${Object.keys(st.orders).length + 1}`;
      st.orders[id] = { orderId: id, orderNumber: body.orderNumber, orderStatus: 'CREATED', payType: body.payType, body };
      return ok({ orderId: id, orderNumber: body.orderNumber, orderStatus: 'CREATED' });
    }
    return bad(`unhandled ${path}`, 404);
  };
  return { st, fetchImpl, deps: { fetchImpl, pace: async () => {} } };
}
module.exports = { makeFakeCj };

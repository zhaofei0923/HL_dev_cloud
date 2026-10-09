'use strict';

const { createMembershipBridge } = require('./hl-membership-bridge');

function install(app, { express, PayService, OrderService, cloud, payConfig, merchant, env = process.env }) {
  if (String(payConfig.mchId || '') !== merchant.merchantId
    || String(payConfig.appId || '') !== merchant.appId) {
    throw new Error('支付集成的商户号或小程序 AppID 与登记配置不一致');
  }
  const callbackToken = String(env.PAYMENT_CALLBACK_TOKEN || '').trim();
  if (callbackToken.length < 32) throw new Error('会员支付内部通信尚未配置');
  cloud.init({ env: merchant.envId });
  const bridge = createMembershipBridge({
    callFunction: options => cloud.callFunction(options),
    payService: new PayService(),
    merchant,
    callbackToken
  });

  // The generated service invokes this hook only after its callback handler.
  // The bridge independently queries WeChat before fulfilling any membership.
  OrderService.prototype.handlerUnifiedTrigger = result => bridge.confirmVerifiedCallback(result);

  const router = express.Router();
  function route(operation) {
    return async (req, res) => {
      const openid = typeof req.headers['x-wx-openid'] === 'string' ? req.headers['x-wx-openid'].trim() : '';
      if (!openid) return res.status(401).json({ code: 40101, message: '请使用当前小程序微信身份付款' });
      try {
        const data = await bridge[operation](req.body || {}, openid);
        return res.status(200).json({ code: 0, message: 'success', data });
      } catch (error) {
        const status = Number(error && error.status);
        return res.status(status >= 400 && status < 500 ? status : 502)
          .json({ code: -1, message: '微信支付暂时无法完成，请稍后查询订单或重试' });
      }
    };
  }
  router.post('/create', route('create'));
  router.post('/query', route('query'));
  app.use('/hl-membership', router);

  // Keep only the generated payment callback routes. Generic template order,
  // refund and transfer APIs must not expose this merchant's account controls.
  app.use((req, res, next) => {
    const body = req.body || {};
    const eventType = (body.rawData && body.rawData.event_type)
      || (body.ParsedNotify && body.ParsedNotify.event_type);
    const direct = req.path === '/wx-pay/unifiedOrderTrigger';
    const action = body._action || body.path || (['TRANSACTION.SUCCESS', 'TRANSACTION.FAIL'].includes(eventType)
      ? 'unifiedOrderTrigger' : '');
    const forwarded = ['/', '/wechatpay/order'].includes(req.path)
      && ['unifiedOrderTrigger', '/wx-pay/unifiedOrderTrigger'].includes(action);
    if (req.method === 'POST' && (direct || forwarded)) return next();
    return res.status(403).json({ code: 40304, message: '该支付操作未向会员开放' });
  });
  return bridge;
}

module.exports = { install };

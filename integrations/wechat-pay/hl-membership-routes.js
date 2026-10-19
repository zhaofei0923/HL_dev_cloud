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
  OrderService.prototype.handlerRefundTrigger = result => bridge.confirmVerifiedRefund(result);

  const router = express.Router();
  function route(operation) {
    return async (req, res) => {
      const openid = typeof req.headers['x-wx-openid'] === 'string' ? req.headers['x-wx-openid'].trim() : '';
      const appId = req.headers['x-wx-appid'];
      if (!openid || typeof appId !== 'string' || appId !== merchant.appId) {
        return res.status(401).json({ code: 40101, message: '请使用当前小程序微信身份付款' });
      }
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
  router.post('/refund-query', route('queryRefund'));
  app.use('/hl-membership', router);

  // Keep only the generated payment callback routes. Generic template order,
  // refund and transfer APIs must not expose this merchant's account controls.
  app.use((req, res, next) => {
    const body = req.body || {};
    const selectors = [body._action, body.path].filter(value => value !== undefined && value !== null && value !== '');
    const events = [body.event_type, body.rawData && body.rawData.event_type, body.ParsedNotify && body.ParsedNotify.event_type]
      .filter(value => value !== undefined);
    const selectorsMatch = selectors.every(value => typeof value === 'string'
      && ['unifiedOrderTrigger', '/wx-pay/unifiedOrderTrigger'].includes(value));
    const eventsMatch = events.every(value => ['TRANSACTION.SUCCESS', 'TRANSACTION.FAIL'].includes(value));
    const direct = req.path === '/wx-pay/unifiedOrderTrigger';
    const forwarded = ['/', '/wechatpay/order'].includes(req.path)
      && (selectors.length > 0 || events.length > 0);
    const refundSelectorsMatch = selectors.every(value => typeof value === 'string'
      && ['refundTrigger', '/wx-pay/refundTrigger'].includes(value));
    const refundEventsMatch = events.length > 0 && events.every(value => value === 'REFUND.SUCCESS');
    const directRefund = req.path === '/wx-pay/refundTrigger';
    // Check every supplied selector rather than relying on template precedence:
    // a refund/transfer hint cannot be concealed by a payment callback hint.
    if (req.method === 'POST' && selectorsMatch && eventsMatch && (direct || forwarded)) return next();
    if (req.method === 'POST' && refundSelectorsMatch && refundEventsMatch && (directRefund || forwarded)) return next();
    return res.status(403).json({ code: 40304, message: '该支付操作未向会员开放' });
  });
  return bridge;
}

module.exports = { install };

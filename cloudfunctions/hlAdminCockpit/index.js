'use strict';

const cloudbase = require('@cloudbase/node-sdk');
const { tcb } = require('tencentcloud-sdk-nodejs-tcb');
const { authorize, ENV_ID } = require('./auth');
const { buildCockpit } = require('./service');

const app = cloudbase.init({ env: ENV_ID });
const describeUsers = async (config, params) => new tcb.v20180608.Client(config).DescribeUserList(params);

exports.main = async (event = {}, context = {}) => {
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || (event.periodDays !== undefined && ![7, 30, 90].includes(event.periodDays))) {
      return { code: 42250, message: '统计周期须为7、30或90天' };
    }
    let parsed;
    try { parsed = cloudbase.parseContext(context); }
    catch { return { code: 40150, message: '请使用已授权的内部管理员账号查看经营统计' }; }
    await authorize(parsed, describeUsers);
    // Never dispatch arbitrary paths, actions, database queries or identity input.
    const data = await buildCockpit(app.database(), { periodDays: event.periodDays || 30, now: Date.now() });
    return { code: 0, data };
  } catch (error) {
    const code = [40150, 40350, 42250, 50350, 50351].includes(error?.code) ? error.code : 50350;
    console.warn('cockpit_read_failed', { code });
    return { code, message: code === 40150 || code === 40350
      ? '请使用已授权的内部管理员账号查看经营统计' : '经营统计暂时不可用，请稍后重试' };
  }
};

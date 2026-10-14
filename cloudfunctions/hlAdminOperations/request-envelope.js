'use strict';

const { plain, error } = require('./contracts');

// CloudBase/Weda may extend the transport envelope. Only these own data
// properties belong to our application; never inspect or forward other fields.
function businessRequest(event) {
  if (!plain(event)) throw Object.assign(error('管理参数无效'), { diagnosticCode: 'ENVELOPE_SHAPE' });
  const request = {};
  for (const key of ['action', 'args', 'requestId']) {
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value')) throw Object.assign(error('管理参数无效'), { diagnosticCode: 'ENVELOPE_ACCESSOR' });
    request[key] = descriptor.value;
  }
  return request;
}

module.exports = { businessRequest };

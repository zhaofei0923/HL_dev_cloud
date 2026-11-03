'use strict';

const { createImageContentSecurityService } = require('./image-content-security');

const MAX_CHUNK_CODEPOINTS = 2500;
const CHUNK_OVERLAP_CODEPOINTS = 128;
const MAX_TEXT_CODEPOINTS = 19000;
const MAX_CHUNKS = 8;
const UNSAFE_CONTENT_CODE = 40061;
const INVALID_CONTENT_CODE = 40062;
const UNAVAILABLE_CODE = 50361;

function defaultError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  error.code = code;
  return error;
}

function createContentSecurityService({ cloud, error = defaultError, logger, env = process.env } = {}) {
  function fail(message, status, code) {
    const failure = error(message, status, code);
    failure.status = status;
    failure.statusCode = status;
    failure.code = code;
    return failure;
  }

  function unavailable() {
    return fail('暂时无法提交，请稍后重试', 503, UNAVAILABLE_CODE);
  }

  function rejected() {
    return fail('内容含有违规信息，请修改后重试', 400, UNSAFE_CONTENT_CODE);
  }

  function invalid() {
    return fail('内容格式或长度不符合要求，请修改后重试', 400, INVALID_CONTENT_CODE);
  }

  function audit(status, source) {
    if (typeof logger !== 'function') return;
    const record = { status };
    const traceId = source && (source.traceId || source.trace_id);
    if (typeof traceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(traceId)) record.traceId = traceId;
    const rawCode = source && (source.errCode === undefined ? source.errcode : source.errCode);
    if (typeof rawCode === 'number' && Number.isSafeInteger(rawCode)) record.code = rawCode;
    try { logger(record); } catch (_error) { /* Diagnostics must not affect the gate. */ }
  }

  function text(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw invalid();
    // Bound memory before expanding supplementary Unicode characters.
    if (value.length > MAX_TEXT_CODEPOINTS * 2) throw invalid();
    return value.replace(/\r\n/g, '\n').trim();
  }

  function codeOf(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
    return null;
  }

  function responseCodes(value) {
    return ['errCode', 'errcode'].filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => codeOf(value[key]));
  }

  async function assertText({ openid, scene = 1, content, title, nickname } = {}) {
    const cleanContent = text(content);
    const cleanTitle = text(title);
    const cleanNickname = text(nickname);
    // Include optional context in the checked text even when the body is empty.
    const combined = [cleanTitle, cleanNickname, cleanContent].filter(Boolean).join('\n');
    if (!combined) return;
    if (typeof openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(openid)
      || !Number.isInteger(scene) || scene < 1 || scene > 4) throw unavailable();
    const characters = Array.from(combined);
    if (characters.length > MAX_TEXT_CODEPOINTS) throw invalid();
    const chunks = [];
    for (let start = 0; start < characters.length; start += MAX_CHUNK_CODEPOINTS - CHUNK_OVERLAP_CODEPOINTS) {
      chunks.push(characters.slice(start, start + MAX_CHUNK_CODEPOINTS).join(''));
      if (start + MAX_CHUNK_CODEPOINTS >= characters.length) break;
    }
    if (chunks.length > MAX_CHUNKS) throw invalid();
    for (const chunk of chunks) {
      let response;
      try {
        response = await cloud.openapi.security.msgSecCheck({ openid, version: 2, scene, content: chunk });
      } catch (failure) {
        const codes = failure && typeof failure === 'object' ? responseCodes(failure) : [];
        const blocked = codes.includes(87014);
        audit(blocked ? 'rejected' : 'unavailable', failure);
        throw blocked ? rejected() : unavailable();
      }
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        audit('unavailable');
        throw unavailable();
      }
      const codes = responseCodes(response);
      if (codes.includes(87014)) {
        audit('rejected', response);
        throw rejected();
      }
      if (codes.some(code => code !== 0)) {
        audit('unavailable', response);
        throw unavailable();
      }
      const suggest = response.result && typeof response.result === 'object' && !Array.isArray(response.result)
        ? response.result.suggest : undefined;
      if (suggest === 'risky' || suggest === 'review') {
        audit('rejected', response);
        throw rejected();
      }
      if (suggest !== 'pass') {
        audit('unavailable', response);
        throw unavailable();
      }
      audit('pass', response);
    }
  }

  return { assertText, ...createImageContentSecurityService({ cloud, fail, audit, env }) };
}

module.exports = { createContentSecurityService };

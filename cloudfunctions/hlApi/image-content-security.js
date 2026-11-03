'use strict';

const crypto = require('node:crypto');

// The synchronous WeChat image check accepts small, static JPEG/PNG images.
// Match the frontend preparation limits and reject unsupported bytes before the
// API call; a filename or caller-supplied MIME type is never an approval.
const MAX_IMAGE_BYTES = 1000000;
const MAX_IMAGE_WIDTH = 750;
const MAX_IMAGE_HEIGHT = 1334;
const MAX_IMAGES = 3;
const SYSTEM_IMAGES = new Set([
  '/assets/members/avatar-male-1.png', '/assets/members/avatar-male-2.png',
  '/assets/members/avatar-female-1.png', '/assets/members/avatar-female-2.png',
  '/assets/members/lifestyle-gallery.png', '/assets/members/lifestyle-cafe.png',
  '/assets/members/lifestyle-city.png', '/assets/members/lifestyle-travel.png',
  '/assets/members/lifestyle-reading.png', '/assets/members/lifestyle-sport.png'
]);

function imageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 || buffer.length > MAX_IMAGE_BYTES) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8, dimensions = null, hasData = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset);
      if (size > buffer.length - offset - 12) return null;
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (!dimensions) {
        if (type !== 'IHDR' || size !== 13) return null;
        dimensions = { width: buffer.readUInt32BE(offset + 8), height: buffer.readUInt32BE(offset + 12) };
      } else if (type === 'IHDR') return null;
      // APNG can hide unchecked later frames even though its signature is PNG.
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return null;
      if (type === 'IDAT') hasData = true;
      offset += size + 12;
      if (type === 'IEND') return size === 0 && hasData && offset === buffer.length
        ? { ...dimensions, contentType: 'image/png' } : null;
    }
    return null;
  }
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xda || marker === 0xd9 || marker === 0x00) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const size = buffer.readUInt16BE(offset);
    if (size < 2 || offset + size > buffer.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (size < 8 || buffer[offset + 2] !== 8) return null;
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5), contentType: 'image/jpeg' };
    }
    offset += size;
  }
  return null;
}

function responseCodes(response) {
  return ['errCode', 'errcode'].filter(key => Object.prototype.hasOwnProperty.call(response, key)).map(key => {
    const value = response[key];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value
      : typeof value === 'string' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  });
}

function createImageContentSecurityService({ cloud, fail, audit, env = process.env } = {}) {
  const unavailable = () => fail('暂时无法提交，请稍后重试', 503, 50361);
  const rejected = () => fail('内容含有违规信息，请修改后重试', 400, 40061);
  const invalid = () => fail('请重新选择或压缩图片后重试', 400, 40062);

  function currentEnvId() {
    const configured = env && (env.TCB_ENV || env.CLOUDBASE_ENV_ID);
    if (configured) return typeof configured === 'string' && /^[A-Za-z0-9_-]+$/.test(configured) ? configured : '';
    try {
      const context = cloud.getWXContext();
      return typeof context?.ENV === 'string' && /^[A-Za-z0-9_-]+$/.test(context.ENV) ? context.ENV : '';
    } catch (_error) { return ''; }
  }

  async function assertImages({ images, skipSystem = false } = {}) {
    if (images === undefined) return [];
    if (!Array.isArray(images) || images.length > MAX_IMAGES || images.some(value => typeof value !== 'string' || !value.trim())) throw invalid();
    const original = images.map(value => value.trim());
    const files = Array.from(new Set(original));
    const pending = files.filter(fileID => !(skipSystem === true && SYSTEM_IMAGES.has(fileID)));
    if (!pending.length) return original;
    const envId = currentEnvId();
    if (!envId) throw unavailable();
    for (const fileID of pending) {
      const match = /^cloud:\/\/([A-Za-z0-9_.-]+)\/((?:hl_uploads\/(?:profile|salon)\/[A-Za-z0-9_./-]+\.(?:jpe?g|png))|(?:hl_moderated\/images\/[a-f0-9]{64}\.(?:jpg|png)))$/i.exec(fileID);
      if (!match || !match[1].startsWith(`${envId}.`) || match[2].split('/').includes('..')) throw invalid();
    }
    const checked = [];
    for (const fileID of pending) {
      let downloaded;
      try { downloaded = await cloud.downloadFile({ fileID }); }
      catch (_error) { audit('unavailable'); throw unavailable(); }
      if (!downloaded || !Buffer.isBuffer(downloaded.fileContent)
        || (downloaded.statusCode !== undefined && Number(downloaded.statusCode) !== 200)) {
        audit('unavailable'); throw unavailable();
      }
      const format = imageFormat(downloaded.fileContent);
      if (!format || !format.width || !format.height || format.width > MAX_IMAGE_WIDTH || format.height > MAX_IMAGE_HEIGHT) throw invalid();
      let response;
      try {
        response = await cloud.openapi.security.imgSecCheck({ media: { contentType: format.contentType, value: downloaded.fileContent } });
      } catch (failure) {
        const codes = failure && typeof failure === 'object' ? responseCodes(failure) : [];
        const blocked = codes.includes(87014);
        audit(blocked ? 'rejected' : 'unavailable', failure);
        throw blocked ? rejected() : unavailable();
      }
      if (!response || typeof response !== 'object' || Array.isArray(response)) { audit('unavailable'); throw unavailable(); }
      const codes = responseCodes(response);
      if (codes.includes(87014)) { audit('rejected', response); throw rejected(); }
      const suggest = response.result && typeof response.result === 'object' ? response.result.suggest : undefined;
      if (suggest === 'risky' || suggest === 'review') { audit('rejected', response); throw rejected(); }
      // imgSecCheck is synchronous: explicit success is mandatory. Unlike the
      // text v2 endpoint, no suggest verdict is expected on a successful result.
      if (!codes.length || codes.some(code => code !== 0) || (suggest !== undefined && suggest !== 'pass')) {
        audit('unavailable', response); throw unavailable();
      }
      audit('pass', response);
      checked.push({ fileID, bytes: downloaded.fileContent, contentType: format.contentType });
    }
    // Never persist a caller-writable original after checking it. All images
    // must pass before creating server-owned, content-addressed copies. Storage
    // write rules must deny client writes to hl_moderated/images/; the client
    // uploader intentionally continues to use hl_uploads/ only.
    const output = new Map();
    for (const image of checked) {
      const digest = crypto.createHash('sha256').update(image.bytes).digest('hex');
      const cloudPath = `hl_moderated/images/${digest}.${image.contentType === 'image/png' ? 'png' : 'jpg'}`;
      let uploaded;
      try { uploaded = await cloud.uploadFile({ cloudPath, fileContent: image.bytes }); }
      catch (_error) { audit('unavailable'); throw unavailable(); }
      const safeFileID = uploaded && typeof uploaded.fileID === 'string' ? uploaded.fileID : '';
      const uploadedParts = /^cloud:\/\/([A-Za-z0-9_.-]+)\/(.+)$/.exec(safeFileID);
      if (!uploadedParts || !uploadedParts[1].startsWith(`${envId}.`) || uploadedParts[2] !== cloudPath) {
        audit('unavailable'); throw unavailable();
      }
      output.set(image.fileID, safeFileID);
    }
    return original.map(fileID => output.get(fileID) || fileID);
  }

  return { assertImages };
}

module.exports = { createImageContentSecurityService, MAX_IMAGE_BYTES, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT };

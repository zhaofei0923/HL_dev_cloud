const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

function message(id, senderId = 2) {
  return { id, conversationId: 7, senderId, receiverId: senderId === 1 ? 2 : 1,
    content: `消息${id}`, contentType: 'text', createdAt: `2026-10-07T00:${String(id % 60).padStart(2, '0')}:00.000Z`,
    sender: { id: senderId, nickname: '测试会话', avatarUrl: '' }, isMine: senderId === 1 };
}
function result(messages, hasMore = false) {
  return { conversation: { id: 7, title: '测试会话', participantIds: [1, 2], peer: { id: 2, nickname: '测试会话' } },
    messages, total: 81, page: 1, pageSize: 80, hasMore,
    beforeId: messages[0]?.id || 0, latestId: messages.at(-1)?.id || 0 };
}
function setup(role, responses = {}) {
  const reads = [], writes = [];
  const instance = runtime(`pages/${role}/chat.js`, { chatApi: {
    listMessages: (id, query) => { reads.push({ id, ...query }); return responses.read ? responses.read(query, reads.length) : Promise.resolve(result([message(81)])); },
    sendMessage: (id, content) => { writes.push({ id, content }); return responses.send ? responses.send(content) : Promise.resolve(message(82, 1)); },
    sendVoiceMessage: async () => message(82, 1)
  } });
  return { ...instance, reads, writes };
}

for (const role of ['user', 'matchmaker']) {
  test(`${role} chat opens the latest window and prepends older messages with an exclusive cursor`, async () => {
    const instance = setup(role, { read: query => Promise.resolve(query.beforeId
      ? result([message(1)]) : result(Array.from({ length: 80 }, (_, i) => message(i + 2)), true)) });
    await instance.page.onLoad({ id: '7' });
    assert.equal(instance.page.data.messages.at(-1).id, 81);
    assert.equal(instance.page.data.hasMoreHistory, true);
    assert.equal(instance.reads[0].page, undefined, 'default query must use the newest server window');
    await instance.page.loadOlder();
    assert.equal(instance.reads[1].beforeId, 2);
    assert.deepEqual(Array.from(instance.page.data.messages, row => row.id), Array.from({ length: 81 }, (_, i) => i + 1));
    assert.equal(instance.page.data.scrollIntoView, 'msg-2');
    assert.equal(instance.page.data.hasMoreHistory, false);
    await instance.page.loadOlder();
    assert.equal(instance.reads.length, 2);
  });

  test(`${role} chat appends a successful send without reloading history or erasing a new draft`, async () => {
    const sent = deferred();
    const instance = setup(role, { send: () => sent.promise });
    await instance.page.onLoad({ id: '7' });
    instance.page.setData({ inputValue: ' hello ' });
    const pending = instance.page.send();
    await flush();
    instance.page.setData({ inputValue: '新的草稿' });
    sent.resolve(message(82, 1));
    await pending;
    assert.equal(instance.page.data.messages.at(-1).id, 82);
    assert.equal(instance.page.data.inputValue, '新的草稿');
    assert.equal(instance.reads.length, 1);
    assert.equal(instance.writes[0].content, 'hello');
    assert.equal(instance.page.data.sending, false);
  });

  test(`${role} chat incrementally drains new batches and removes duplicate IDs`, async () => {
    const instance = setup(role, { read: query => Promise.resolve(!query.afterId
      ? result([message(81)]) : query.afterId === 81
        ? result([message(82), message(83)], true) : result([message(83), message(84)])) });
    await instance.page.onLoad({ id: '7' });
    await instance.page.refreshNewMessages();
    assert.deepEqual(instance.reads.slice(1).map(query => query.afterId), [81, 83]);
    assert.deepEqual(Array.from(instance.page.data.messages, row => row.id), [81, 82, 83, 84]);
    assert.equal(instance.page.data.refreshing, false);
  });

  test(`${role} chat does not skip incoming messages when its own send has a later ID`, async () => {
    const instance = setup(role, { send: async () => message(85, 1), read: query => Promise.resolve(query.afterId === undefined
      ? result([message(81)]) : result([message(82), message(83), message(84), message(85, 1)])) });
    await instance.page.onLoad({ id: '7' });
    instance.page.setData({ inputValue: '发送测试' });
    await instance.page.send();
    await instance.page.refreshNewMessages();
    assert.equal(instance.reads[1].afterId, 81);
    assert.deepEqual(Array.from(instance.page.data.messages, row => row.id), [81, 82, 83, 84, 85]);
  });

  test(`${role} chat rejects late history after account change and clears rows on permission denial`, async () => {
    const older = deferred();
    const instance = setup(role, { read: query => query.beforeId ? older.promise : Promise.resolve(result([message(81)], true)) });
    await instance.page.onLoad({ id: '7' });
    const pending = instance.page.loadOlder();
    await flush();
    instance.session.token = 'new-chat-session';
    instance.session.user = { id: 3, nickname: '新用户' };
    instance.page.synchronizeChatSession();
    older.resolve(result([message(1)]));
    await pending;
    assert.equal(instance.page.data.messages.length, 0);
    const denied = setup(role, { read: (query, number) => number === 1
      ? Promise.resolve(result([message(81)])) : Promise.reject(Object.assign(new Error('denied'), { code: 40301 })) });
    await denied.page.onLoad({ id: '7' });
    await denied.page.refreshNewMessages();
    assert.equal(denied.page.data.messages.length, 0);
    assert.equal(denied.page.data.conversation, null);
    assert.equal(denied.page.data.refreshing, false);
  });

  test(`${role} chat reloads on show when the account changes during an outstanding first load`, async () => {
    const oldRead = deferred();
    const instance = setup(role, { read: (query, number) => number === 1
      ? oldRead.promise : Promise.resolve(result([message(91)])) });
    const oldLoad = instance.page.onLoad({ id: '7' });
    await flush();
    instance.session.token = 'new-chat-session';
    instance.session.user = { id: 3, nickname: '新用户' };
    await instance.page.onShow();
    oldRead.resolve(result([message(81)]));
    await oldLoad;
    assert.deepEqual(Array.from(instance.page.data.messages, row => row.id), [91]);
    assert.equal(instance.reads.length, 2);
    assert.equal(instance.page.data.loading, false);
  });

  test(`${role} chat clears its draft and sending state when a send loses permission`, async () => {
    const instance = setup(role, { send: () => Promise.reject(Object.assign(new Error('denied'), { code: 40301 })) });
    await instance.page.onLoad({ id: '7' });
    instance.page.setData({ inputValue: '会话草稿' });
    await instance.page.send();
    assert.equal(instance.page.data.conversation, null);
    assert.equal(instance.page.data.messages.length, 0);
    assert.equal(instance.page.data.inputValue, '');
    assert.equal(instance.page.data.sending, false);
    assert.equal(instance.page.data.recording, false);
  });
}

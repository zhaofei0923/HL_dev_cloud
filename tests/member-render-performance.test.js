const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const free = { isPremiumMember: false, membershipTier: 'free' };
const vip = { isPremiumMember: true, membershipTier: 'vip', lifetime: true };
const giftEvent = { currentTarget: { dataset: { giftId: 'rose' } } };
const rows = count => Array.from({ length: count }, (_, index) => ({ id: `profile_${index + 2}`, userId: index + 2,
  nickname: `公开测试会员${index + 2}`, city: '上海', age: 30, height: 175, education: '本科', occupation: '工程师',
  selfIntro: '这是用于测量公开卡片传输量的内存夹具。', partnerRequirement: '真诚沟通，尊重彼此的生活。',
  viewerState: { isFavorite: false } }));
const result = list => ({ list, total: list.length, page: 1, pageSize: 50, hasMore: false });

function memberRuntime(list = rows(3), overrides = {}) {
  const reads = { vip: 0, showcase: [] };
  const r = runtime('pages/user/members.js', { source: true, memberApi: {
    vipOverview: () => { reads.vip++; return overrides.vipOverview ? overrides.vipOverview(reads.vip) : Promise.resolve(free); },
    showcase: query => {
      reads.showcase.push(structuredClone(query));
      return overrides.showcase ? overrides.showcase(query) : Promise.resolve(result(list));
    },
    interact: async payload => overrides.interact ? overrides.interact(payload) : { viewerState: { isFavorite: payload.active } },
    sendGift: async payload => overrides.sendGift ? overrides.sendGift(payload) : {},
    gifts: async () => [{ id: 'rose', name: '玫瑰' }]
  } });
  return { ...r, reads };
}

test('public recommendations render while the separate VIP read is pending and duplicate shows share both reads', async () => {
  const pendingVip = deferred();
  const r = memberRuntime(rows(3), { vipOverview: () => pendingVip.promise });
  const first = r.page.onShow();
  const second = r.page.onShow();
  await flush();
  assert.equal(r.reads.vip, 1);
  assert.equal(r.reads.showcase.length, 1, 'the public read must start before the VIP response');
  assert.equal(r.page.data.currentMember.id, 'profile_2');
  assert.equal(r.page.data.membershipKnown, false);
  pendingVip.resolve(free);
  await Promise.all([first, second]);
  assert.equal(r.page.data.membershipKnown, true);
  r.page.nextMember();
  r.page.onHide();
  await r.page.onShow();
  assert.equal(r.reads.vip, 1);
  assert.equal(r.reads.showcase.length, 1);
  assert.equal(r.page.data.currentMember.id, 'profile_3');
});

test('VIP categories and advanced filters wait for permission before requesting cards', async () => {
  for (const patch of [{ category: 'education' }, { category: 'recommend', ageMin: '28' }]) {
    for (const access of [free, vip]) {
      const pendingVip = deferred();
      const r = memberRuntime(rows(3), { vipOverview: () => pendingVip.promise });
      r.page.setData(patch);
      const showing = r.page.onShow();
      await flush();
      assert.equal(r.reads.showcase.length, 0);
      pendingVip.resolve(access);
      await showing;
      assert.equal(r.reads.showcase.length, 1);
      const query = r.reads.showcase[0];
      assert.equal(query.category, access.isPremiumMember ? patch.category : 'recommend');
      assert.equal(query.ageMin, access.isPremiumMember ? patch.ageMin : undefined);
    }
  }
});

test('a superseded VIP response cannot undo a newer forced permission check', async () => {
  const first = deferred(), second = deferred();
  const r = memberRuntime(rows(3), { vipOverview: read => read === 1 ? first.promise : second.promise });
  const oldRead = r.page.loadVip();
  await flush();
  const freshRead = r.page.loadVip(true);
  await flush();
  second.resolve(vip);
  assert.equal(await freshRead, true);
  first.resolve(free);
  assert.equal(await oldRead, false);
  assert.equal(r.page.data.isVip, true);
});

test('hidden or replaced sessions discard old VIP and public card responses', async () => {
  for (const transition of ['hide', 'account', 'unload']) {
    const pendingVip = deferred(), pendingCards = deferred();
    const r = memberRuntime(rows(3), { vipOverview: () => pendingVip.promise, showcase: () => pendingCards.promise });
    const showing = r.page.onShow();
    await flush();
    if (transition === 'account') {
      r.session.token = 'replacement-session'; r.session.user = { id: 44 };
    } else r.page[transition === 'hide' ? 'onHide' : 'onUnload']();
    const updates = r.calls.updates.length;
    pendingVip.resolve(vip); pendingCards.resolve(result(rows(3)));
    await showing;
    assert.equal(r.calls.updates.length, updates);
    assert.equal(r.page.data.currentMember, null);
  }
});

test('a returning page starts a fresh VIP check instead of accepting an older hidden-page response', async () => {
  const first = deferred(), second = deferred();
  const r = memberRuntime(rows(3), { vipOverview: read => read === 1 ? first.promise : second.promise });
  const oldShow = r.page.onShow(); await flush();
  r.page.onHide();
  const newShow = r.page.onShow(); await flush();
  second.resolve(free); await newShow;
  first.resolve(vip); await oldShow;
  assert.equal(r.reads.vip, 2);
  assert.equal(r.page.data.isVip, false);
});

test('an old protected-page show cannot request cards while the returning page still awaits VIP permission', async () => {
  const first = deferred(), second = deferred();
  const r = memberRuntime(rows(3), { vipOverview: read => read === 1 ? first.promise : second.promise });
  r.page.setData({ category: 'education', isVip: true, membershipKnown: true });
  const oldShow = r.page.onShow(); await flush();
  r.page.onHide();
  const newShow = r.page.onShow(); await flush();
  first.resolve(free); await oldShow;
  assert.equal(r.reads.showcase.length, 0, 'the returning page permission check is still pending');
  second.resolve(vip); await newShow;
  assert.equal(r.reads.showcase.length, 1);
  assert.equal(r.reads.showcase[0].category, 'education');
});

test('category and advanced search permission continuations cannot navigate or update a hidden or replaced page', async () => {
  for (const action of ['category', 'search']) for (const transition of ['hide', 'account']) {
    const pendingVip = deferred();
    const r = memberRuntime(rows(3), { vipOverview: () => pendingVip.promise });
    if (action === 'search') r.page.setData({ draftAgeMin: '28' });
    const pending = action === 'category'
      ? r.page.switchCategory({ currentTarget: { dataset: { category: 'education' } } }) : r.page.search();
    await flush();
    if (transition === 'hide') r.page.onHide();
    else { r.session.token = 'replacement-session'; r.session.user = { id: 44 }; }
    const updates = r.calls.updates.length;
    pendingVip.resolve(vip); await pending;
    assert.equal(r.calls.updates.length, updates);
    assert.equal(r.calls.navigation.length, 0);
    assert.equal(r.reads.showcase.length, 0);
  }
});

test('hiding a pending explicit refresh leaves warm return browsing available', async () => {
  const pendingCards = deferred(); let reads = 0;
  const r = memberRuntime(rows(3), { showcase: () => ++reads === 2 ? pendingCards.promise : Promise.resolve(result(rows(3))) });
  await r.page.onShow();
  const refreshing = r.page.load(true); await flush();
  assert.equal(r.page.data.loading, true);
  r.page.onHide(); await r.page.onShow();
  assert.equal(r.page.data.loading, false);
  assert.equal(r.page.isCardBusy(), false);
  pendingCards.resolve(result(rows(3))); await refreshing;
  assert.equal(r.page.data.loading, false);
  assert.equal(r.page.isCardBusy(), false);
});

test('a mutation succeeding after return triggers an owned fresh read and never leaves a false warm favorite state', async () => {
  const pending = deferred(); let favorite = false, writes = 0;
  const r = memberRuntime(rows(3), {
    showcase: async () => result(rows(3).map(row => ({ ...row, viewerState: { isFavorite: row.userId === 2 && favorite } }))),
    interact: async () => { writes++; await pending.promise; favorite = true; return { viewerState: { isFavorite: true } }; }
  });
  await r.page.onShow();
  const acting = r.page.toggleFavorite(); await flush();
  r.page.onHide(); await r.page.onShow();
  assert.equal(r.reads.showcase.length, 2, 'return must refresh an unresolved mutation rather than reuse its old snapshot');
  assert.equal(r.page.data.currentMember.isFavorite, false);
  pending.resolve(); await acting; await flush();
  assert.equal(writes, 1);
  assert.equal(r.reads.showcase.length, 3, 'the previous return read preceded the mutation success and cannot remain fresh');
  assert.equal(r.page.data.currentMember.isFavorite, true);
  assert.equal(r.page.data.list[0].isFavorite, true);
  assert.equal(r.page.isShowcaseFresh(), true);
  r.page.onHide(); await r.page.onShow();
  assert.equal(r.reads.showcase.length, 3);
  assert.equal(r.page.data.currentMember.isFavorite, true);
});

test('old-account mutation completion cannot invalidate or refresh the replacement account snapshot', async () => {
  const pending = deferred();
  const r = memberRuntime(rows(3), { interact: () => pending.promise });
  await r.page.onShow();
  const acting = r.page.toggleFavorite(); await flush();
  r.page.onHide(); r.session.token = 'replacement-session'; r.session.user = { id: 44 };
  await r.page.onShow();
  const reads = r.reads.showcase.length, updates = r.calls.updates.length;
  pending.resolve({ viewerState: { isFavorite: true } }); await acting; await flush();
  assert.equal(r.reads.showcase.length, reads);
  assert.equal(r.calls.updates.length, updates);
  assert.equal(r.page.isShowcaseFresh(), true);
});

test('a late mutation recovery waits for the returning protected page current VIP check', async () => {
  for (const access of [free, vip]) {
    const pendingMutation = deferred(), pendingVip = deferred();
    const r = memberRuntime(rows(3), { vipOverview: read => read === 1 ? Promise.resolve(vip) : pendingVip.promise,
      interact: () => pendingMutation.promise });
    r.page.setData({ category: 'education' }); await r.page.onShow();
    const acting = r.page.toggleFavorite(); await flush();
    r.page.onHide(); r.page._vipLoadedAt = 0;
    const returning = r.page.onShow(); await flush();
    const reads = r.reads.showcase.length;
    pendingMutation.resolve({ viewerState: { isFavorite: true } }); await acting; await flush();
    assert.equal(r.reads.showcase.length, reads, 'the returning VIP read is still pending for the protected category');
    pendingVip.resolve(access); await returning; await flush();
    assert.ok(r.reads.showcase.slice(reads).length > 0);
    assert.ok(r.reads.showcase.slice(reads).every(query => query.category === (access.isPremiumMember ? 'education' : 'recommend')));
  }
});

test('an older mutation cannot refresh over a newer visible mutation and leaves the next write requiring revalidation', async () => {
  const pending = deferred(); let writes = 0;
  const r = memberRuntime(rows(3), { interact: () => ++writes === 1 ? pending.promise
    : Promise.resolve({ viewerState: { isFavorite: true } }) });
  await r.page.onShow();
  const oldAction = r.page.toggleFavorite(); await flush();
  r.page.onHide(); await r.page.onShow();
  await r.page.toggleFavorite(); r.advance(700);
  assert.equal(r.page.data.currentMember.isFavorite, true);
  const reads = r.reads.showcase.length, updates = r.calls.updates.length;
  pending.resolve({ viewerState: { isFavorite: false } }); await oldAction; await flush();
  assert.equal(r.reads.showcase.length, reads);
  assert.equal(r.calls.updates.length, updates);
  assert.equal(r.page.data.currentMember.isFavorite, true);
  assert.equal(r.page.isShowcaseFresh(), false, 'a later action must revalidate the unresolved mutation ordering');
});

test('favorite, withdrawal and gift update fields without retransmitting the 50 or 200 card queue', async context => {
  for (const count of [50, 200]) {
    for (const action of ['favorite', 'withdrawal', 'gift']) {
      const list = rows(count);
      if (action === 'withdrawal') list[0].viewerState.isFavorite = true;
      const r = memberRuntime(list);
      await r.page.onShow();
      const active = action !== 'withdrawal';
      // This is the former full-list setData payload, using the same normalized cards.
      const oldList = r.page.data.list.map(item => item.userId === 2 ? { ...item, isFavorite: active } : item);
      const oldPayload = { list: oldList, currentIndex: 0, currentMember: oldList[0], positionText: `1/${count}`,
        ...(action === 'gift' ? { giftPanelOpen: false } : {}) };
      const beforeBytes = Buffer.byteLength(JSON.stringify(oldPayload));
      r.calls.updates.length = 0;
      if (action === 'gift') await r.page.sendGift(giftEvent);
      else await r.page.toggleFavorite();
      r.advance(700);
      assert.equal(r.page.data.currentMember.isFavorite, active);
      assert.equal(r.page.data.list[0].isFavorite, active);
      assert.equal(r.page.data.list.length, count);
      assert.equal(r.page.data.currentMember.id, 'profile_2');
      assert.ok(r.page.data.list.slice(1).every(item => item.isFavorite === false));
      assert.ok(r.calls.updates.every(update => !Object.prototype.hasOwnProperty.call(update, 'list')));
      const afterBytes = r.calls.updates.reduce((sum, update) => sum + Buffer.byteLength(JSON.stringify(update)), 0);
      assert.ok(afterBytes < beforeBytes / 50, 'all action updates together must be under 2% of the former queue payload');
      context.diagnostic(`${action}: ${count} cards; former queue ${beforeBytes} bytes; all current action updates ${afterBytes} bytes`);
    }
  }
});

test('field updates cover duplicate public representations and remain consistent after selecting the next card', async () => {
  const list = rows(3); list[1].userId = list[0].userId;
  const r = memberRuntime(list);
  await r.page.onShow(); await r.page.toggleFavorite(); r.advance(700);
  assert.equal(r.page.data.list[0].isFavorite, true);
  assert.equal(r.page.data.list[1].isFavorite, true);
  assert.equal(r.page.data.list[2].isFavorite, false);
  r.page.nextMember();
  assert.equal(r.page.data.currentMember.id, 'profile_3');
  assert.equal(r.page.data.currentMember.isFavorite, true);
});

test('returning after a cancelled success animation restores the confirmed action from the warm cache', async () => {
  for (const action of ['hide', 'gift']) {
    const r = memberRuntime(rows(3));
    await r.page.onShow();
    if (action === 'hide') await r.page.hideCurrent();
    else await r.page.sendGift(giftEvent);
    assert.equal(r.page.data.actionAnimating, true);
    r.page.onHide();
    await r.page.onShow();
    r.advance(700);
    assert.equal(r.reads.showcase.length, 1, 'the confirmed cache mutation requires no extra network read');
    if (action === 'hide') {
      assert.equal(r.page.data.list.length, 2);
      assert.equal(r.page.data.currentMember.id, 'profile_3');
    } else {
      assert.equal(r.page.data.list[0].isFavorite, true);
      assert.equal(r.page.data.currentMember.isFavorite, true);
    }
  }
});

test('late action responses and animation callbacks cannot patch a hidden or replacement page', async () => {
  for (const action of ['favorite', 'hide', 'gift']) {
    for (const transition of ['hide-and-return', 'account', 'unload']) {
      const pending = deferred();
      const r = memberRuntime(rows(3), { interact: () => pending.promise, sendGift: () => pending.promise });
      await r.page.onShow();
      const acting = action === 'gift' ? r.page.sendGift(giftEvent) : action === 'hide' ? r.page.hideCurrent() : r.page.toggleFavorite();
      await flush();
      if (transition === 'account') { r.session.token = 'replacement-session'; r.session.user = { id: 44 }; }
      else if (transition === 'unload') r.page.onUnload();
      else { r.page.onHide(); await r.page.onShow(); }
      const updates = r.calls.updates.length;
      pending.resolve({ viewerState: { isFavorite: true } }); await acting; r.advance(700);
      if (transition === 'hide-and-return') {
        await flush();
        assert.equal(r.reads.showcase.length, 3, 'the visible returning page reconciles a late mutation with a new owned read');
      } else assert.equal(r.calls.updates.length, updates);
      assert.equal(r.page.data.list[0].isFavorite, false);
      assert.equal(r.page.data.list.length, 3);
    }
  }
  for (const transition of ['hide', 'account']) {
    const r = memberRuntime(rows(3));
    await r.page.onShow(); await r.page.sendGift(giftEvent);
    if (transition === 'hide') r.page.onHide();
    else { r.session.token = 'replacement-session'; r.session.user = { id: 44 }; }
    const updates = r.calls.updates.length;
    r.advance(700);
    assert.equal(r.calls.updates.length, updates);
    assert.equal(r.page.data.list[0].isFavorite, false);
  }
});

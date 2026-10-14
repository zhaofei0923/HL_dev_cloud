'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCockpit, readSnapshot, COLLECTIONS, FIELDS, maskName } = require('../cloudfunctions/hlAdminCockpit/service');

function fixtureDb(tables) {
  const reads = [];
  function project(row, projection) {
    const result = {};
    for (const [field, included] of Object.entries(projection)) {
      if (!included) continue;
      const parts = field.split('.');
      const value = parts.reduce((current, key) => current !== null && typeof current === 'object' ? current[key] : undefined, row);
      if (value === undefined) continue;
      let target = result;
      for (const key of parts.slice(0, -1)) target = target[key] ||= {};
      target[parts[parts.length - 1]] = structuredClone(value);
    }
    return result;
  }
  const db = { command: { gt: value => ({ gt: value }) }, collection(name) {
    let cursor, projection, limit;
    return { where(query) { cursor = query._id.gt; return this; }, orderBy(key, direction) {
      assert.equal(key, '_id'); assert.equal(direction, 'asc'); return this;
    }, field(value) { projection = value; return this; }, limit(value) { limit = value; return this; }, async get() {
      assert.equal(limit, 100); assert.ok(projection._id);
      reads.push({ name, cursor, fields: Object.keys(projection) });
      return { data: structuredClone((tables[name] || []).filter(x => cursor === undefined || x._id > cursor)
        .sort((a,b) => a._id.localeCompare(b._id)).slice(0,limit).map(row => project(row, projection))) };
    } };
  } };
  return { db, reads };
}

test('cockpit reader reads every page with a stable key and projected fields', async () => {
  const tables = { sample: Array.from({length: 230},(_,i)=>({_id:`row_${String(i).padStart(4,'0')}`,n:i})) };
  const {db,reads}=fixtureDb(tables);
  const all=await readSnapshot(db,'sample',{_id:true,n:true});
  assert.equal(all.length,230); assert.equal(reads.length,3); assert.equal(reads[1].cursor,'row_0099');
});

function projectedPayment(patch = {}) {
  return { _id:'fixture_order', outTradeNo:'HLMfixture_order', userId:1, payerOpenid:'fixture_payer',
    merchantId:'merchant-fixture', appId:'wx1234567890abcdef', currency:'CNY', paymentProvider:'virtual',
    virtualPaymentEnv:0, confirmationSource:'wechat_push', status:'paid', transactionId:'fixture_transaction',
    paidAt:'2026-10-13T08:00:00Z', amountFen:6160, planCode:'vip_week', planTitle:'VIP周卡', productType:'vip',
    durationDays:7, ...patch };
}

for (const [name, marker] of [['demo data source',{dataSource:'demo'}], ['test origin',{origin:'test'}], ['test-mode flag',{testMode:true}]]) {
  test(`order field projection preserves ${name} before aggregating formal collections`, async () => {
    const {db,reads}=fixtureDb({hl_payment_orders:[projectedPayment(marker)]});
    const result=await buildCockpit(db,{now:Date.parse('2026-10-14T04:00:00Z'),periodDays:7});
    assert.equal(result.revenue.paidFen,0);
    assert.equal(result.revenue.paidTransactions,0);
    assert.equal(result.revenue.quality.excludedCounts.test_or_probe,1);
    assert.equal(result.revenue.quality.complete,true);
    const orderRead=reads.find(read=>read.name==='hl_payment_orders');
    for(const field of Object.keys(marker)) assert.ok(orderRead.fields.includes(field));
  });
}

test('a genuine production vip_week remains a paid collection after the same real projection',async()=>{
  const {db}=fixtureDb({hl_payment_orders:[projectedPayment()]});
  const result=await buildCockpit(db,{now:Date.parse('2026-10-14T04:00:00Z'),periodDays:7});
  assert.equal(result.revenue.paidFen,6160);
  assert.equal(result.revenue.paidTransactions,1);
  assert.equal(result.revenue.quality.complete,true);
});

test('cockpit reader fails instead of looping or returning a partial count for a broken cursor', async () => {
  const db={command:{gt:x=>x},collection:()=>({where(){return this;},orderBy(){return this;},field(){return this;},limit(){return this;},get:async()=>({data:[{_id:'same'},{_id:'same'}]})})};
  await assert.rejects(readSnapshot(db,'sample',{_id:true}),/分页状态异常/);
});

test('complete empty snapshots produce genuine zero totals with no business writes', async () => {
  const {db,reads}=fixtureDb({});
  const value=await buildCockpit(db,{now:Date.parse('2026-10-14T02:00:00Z')});
  assert.equal(value.members.total,0); assert.equal(value.revenue.paidFen,0); assert.equal(value.revenue.netFen,0);
  assert.equal(value.period.startAt,'2026-09-14T16:00:00.000Z');
  assert.equal(value.period.timeZone,'Asia/Shanghai'); assert.equal(reads.length,8);
});

test('aggregates reuse current VIP and certification projections and redact ranking identities', async () => {
  const {db}=fixtureDb({
    hl_users:[{_id:'u1',id:1,status:1,nickname:'王先生',openid:'private-openid'},{_id:'u2',id:2,status:1,nickname:'李女士'}],
    hl_profiles:[{_id:'p1',userId:1,createdAt:'2026-09-01T00:00:00Z',displayEnabled:true,city:'杭州'},
      {_id:'p2',userId:2,createdAt:'2026-10-13T00:00:00Z',displayEnabled:false}],
    hl_members:[{_id:'m1',id:1,userId:2,status:1,matchmakerId:10,memberType:'free',createdAt:'2026-10-13T00:00:00Z'}],
    hl_matchmakers:[{_id:'mm1',id:10,userId:1,status:1,certificationStatus:2}],
    hl_member_certifications:[{_id:'user_2',userId:2,current:{identity:{status:'approved',source:'identity_document',evidenceReference:'PRIVATE'}}}],
    hl_vip_entitlements:[{_id:'vip_user_2',userId:2,legacyLifetime:true,grants:[]}],
    hl_member_presence:[{_id:'presence_1',userId:1,lastSeenAt:'2026-10-13T00:00:00Z'}]
  });
  const value=await buildCockpit(db,{now:Date.parse('2026-10-14T02:00:00Z')});
  assert.equal(value.members.total,2); assert.equal(value.members.vip,1); assert.equal(value.members.verified,1);
  assert.equal(value.matchmakers.approved,1); assert.equal(value.matchmakers.ranking[0].name,'王**');
  assert.equal(value.matchmakers.ranking[0].memberCount,1);
  const serialized=JSON.stringify(value);
  for(const secret of ['PRIVATE','private-openid','王先生'])assert.equal(serialized.includes(secret),false);
});

function certificationDb(certifications, profiles = [{_id:'random_profile_document',userId:2,createdAt:'2026-10-10T00:00:00Z'}]) {
  return fixtureDb({hl_users:[{_id:'u2',id:2,status:1}],hl_profiles:profiles,hl_member_certifications:certifications}).db;
}
const identity = status => ({identity:{status,source:'identity_document'}});
const certNow = Date.parse('2026-10-14T04:00:00Z');

test('a revoked canonical certification cannot be replaced by an approved archive with the same userId',async()=>{
  const db=certificationDb([{_id:'user_2',userId:2,current:identity('revoked')},
    {_id:'zz_archive_2',userId:2,current:identity('approved')}]);
  const result=await buildCockpit(db,{now:certNow});
  assert.equal(result.members.verified,0);
  assert.equal(result.members.quality.unknownIdentityVerification,0);
  assert.equal(result.members.quality.ignoredNonCanonicalCertificationUsers,1);
  assert.ok(result.quality.warnings.some(warning=>warning.includes('非规范认证文档')));
});

test('an approved noncanonical certification alone is ignored and never becomes a verified member',async()=>{
  const db=certificationDb([{_id:'zz_archive_2',userId:2,current:identity('approved')}]);
  const result=await buildCockpit(db,{now:certNow});
  assert.equal(result.members.verified,0);
  assert.equal(result.members.quality.ignoredNonCanonicalCertificationUsers,1);
});

test('without a canonical certification the existing public-profile projection remains valid',async()=>{
  const db=certificationDb([{_id:'archive_2',userId:2,current:identity('revoked')}],
    [{_id:'random_profile_document',userId:2,createdAt:'2026-10-10T00:00:00Z',
      showcaseCertification:{policyVersion:1,...identity('approved')}}]);
  const result=await buildCockpit(db,{now:certNow});
  assert.equal(result.members.verified,1);
  assert.equal(result.members.quality.ignoredNonCanonicalCertificationUsers,1);
});

test('a canonical certification owned by a different user yields an unknown identity status',async()=>{
  const result=await buildCockpit(certificationDb([{_id:'user_2',userId:3,current:identity('approved')}]),{now:certNow});
  assert.equal(result.members.verified,null);
  assert.equal(result.members.quality.unknownIdentityVerification,1);
  assert.equal(result.members.quality.mismatchedCertificationOwnerUsers,1);
});

test('conflicting duplicate numeric profiles cannot arbitrarily determine fallback identity verification',async()=>{
  const db=certificationDb([], [{_id:'a_profile',userId:2,createdAt:'2026-10-10T00:00:00Z'},
    {_id:'z_profile',userId:2,createdAt:'2026-10-10T00:00:00Z',showcaseCertification:{policyVersion:1,...identity('approved')}}]);
  const result=await buildCockpit(db,{now:certNow});
  assert.equal(result.members.verified,null);
  assert.equal(result.members.quality.conflictingProfileCertificationUsers,1);
  assert.equal(result.members.quality.unknownIdentityVerification,1);
});

test('fallback profile matching uses the existing numeric query rather than an invented document key',async()=>{
  const db=certificationDb([], [{_id:'not_user_2',userId:2,createdAt:'2026-10-10T00:00:00Z',
    showcaseCertification:{policyVersion:1,...identity('approved')}},
    {_id:'z_string_user_id',userId:'2',createdAt:'2026-10-10T00:00:00Z'}]);
  const result=await buildCockpit(db,{now:certNow});
  assert.equal(result.members.verified,1);
  assert.equal(result.members.quality.conflictingProfileCertificationUsers,0);
});

test('aggregation validates period before database reads and masks Unicode names', async () => {
  const {db,reads}=fixtureDb({});
  await assert.rejects(buildCockpit(db,{periodDays:100}),error=>error.code===42250);
  assert.equal(reads.length,0); assert.equal(maskName('𠮷先生'),'𠮷**');
  for(const key of Object.keys(COLLECTIONS))assert.ok(FIELDS[key]);
});

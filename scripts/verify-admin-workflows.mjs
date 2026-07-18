import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const failures = [];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function assertRule(condition, message) {
  if (!condition) failures.push(message);
}

const cms = readJson('docs/cloudbase-cms-views.json');
const cloudbase = readJson('cloudbaserc.json');
const apiSource = readText('cloudfunctions/hlApi/index.js');
const configuredFunction = Array.isArray(cloudbase.functions)
  ? cloudbase.functions.find(item => item && item.name === cms.cloudFunction)
  : null;

assertRule(cms.envId === cloudbase.envId, 'CMS envId must match cloudbaserc.json.');
assertRule(Boolean(configuredFunction), 'CMS cloudFunction must exist in cloudbaserc.json.');
assertRule(Array.isArray(cms.views) && cms.views.length >= 6, 'CMS views must define the operating views.');

const viewsByCollection = new Map(cms.views.map(view => [view.collection, view]));
[
  'hl_matchmakers',
  'hl_salon_events',
  'hl_profiles',
  'hl_members',
  'hl_membership_plans',
  'hl_registrations',
  'hl_member_matchmaker_requests'
].forEach(collectionName => {
  assertRule(viewsByCollection.has(collectionName), `Missing CMS view for ${collectionName}.`);
});

[
  '_id',
  '_openid',
  'openid',
  'token',
  'refreshToken'
].forEach(fieldName => {
  assertRule(cms.globalHiddenFields.includes(fieldName), `Missing hidden field ${fieldName}.`);
});

assertRule(
  Array.isArray(cms.protectedCollections) && cms.protectedCollections.includes('hl_counters'),
  'hl_counters must stay protected from operator views.'
);
assertRule(
  cms.protectedCollections.includes('hl_payment_orders'),
  'hl_payment_orders must stay protected from manual operator edits.'
);

const requestAuditView = viewsByCollection.get('hl_member_matchmaker_requests');
assertRule(requestAuditView.manualCmsAllowed === false, 'Member-matchmaker requests must be read-only in CMS.');
assertRule(
  Array.isArray(requestAuditView.editableFields) && requestAuditView.editableFields.length === 0,
  'Member-matchmaker request audit view must not expose editable fields.'
);

const profileView = viewsByCollection.get('hl_profiles');
const memberServiceView = viewsByCollection.get('hl_members');
const membershipPlanView = viewsByCollection.get('hl_membership_plans');
assertRule(
  Array.isArray(profileView.editableFields) && profileView.editableFields.includes('displayEnabled'),
  'Profile view must expose hl_profiles.displayEnabled as the effective display switch.'
);
assertRule(
  Array.isArray(membershipPlanView.editableFields)
    && membershipPlanView.editableFields.includes('amountFen')
    && membershipPlanView.editableFields.includes('durationDays'),
  'Membership plan view must expose server amount and duration fields.'
);
assertRule(
  Array.isArray(memberServiceView.editableFields) && !memberServiceView.editableFields.includes('displayEnabled'),
  'Member service view must not expose hl_members.displayEnabled; display uses hl_profiles.displayEnabled.'
);
assertRule(
  Array.isArray(memberServiceView.warnings)
    && memberServiceView.warnings.some(message => message.includes('hl_profiles.displayEnabled')),
  'Member service view must warn that display uses hl_profiles.displayEnabled.'
);

[
  'invalid certification status',
  'invalid salon review status',
  '/admin/login',
  '/admin/dashboard',
  '/admin/matchmakers',
  '/admin/salons',
  '/admin/membership-plans',
  '/admin/payment-orders',
  '/matchmaker/member-requests'
].forEach(sourceToken => {
  assertRule(apiSource.includes(sourceToken), `hlApi is missing expected workflow token: ${sourceToken}`);
});

const preferredActions = cms.views.flatMap(view => Array.isArray(view.preferredActions) ? view.preferredActions : []);
const actionPaths = preferredActions.map(action => action.path);
[
  '/admin/matchmakers/{id}/certification',
  '/admin/salons/{id}/review',
  '/admin/membership-plans/{planCode}',
  '/matchmaker/member-requests/{id}/approve',
  '/matchmaker/member-requests/{id}/reject'
].forEach(actionPath => {
  assertRule(actionPaths.includes(actionPath), `Missing preferred action ${actionPath}.`);
});

if (failures.length) {
  console.error('CloudBase admin workflow verification failed:');
  failures.forEach(message => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log(`Verified ${cms.views.length} CloudBase CMS views against ${cms.cloudFunction}.`);
}

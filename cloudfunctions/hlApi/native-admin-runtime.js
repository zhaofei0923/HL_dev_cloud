'use strict';

// This entry is bundled with its own pinned Node SDK. It must never resolve to
// hlApi's existing wx-server-sdk/transitive Node SDK or initialize it eagerly.
const cloudbase = require('@cloudbase/node-sdk');
const { authorizeNativeAdmin, createNativeAdminService } = require('./native-admin-service');
const ENV_ID = 'cloud1-d2gza7q9c8d69c721';
let service;
const preparationService = createNativeAdminService();

function managementService() {
  if (!service) {
    const app = cloudbase.init({ env: ENV_ID });
    service = createNativeAdminService({
      db: app.database({ throwOnCode: true }),
      downloadFile: input => app.downloadFile(input),
      secrets: {
        encryptionKey: process.env.MEMBER_CERTIFICATION_ENCRYPTION_KEY,
        jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY
      }
    });
  }
  return service;
}

module.exports = {
  authorizeNativeAdmin,
  executeNativeAdmin(request, actor) {
    // A retry identifier needs no database or storage client. The same service
    // still validates the request envelope and the unforgeable server actor.
    if (request?.action === 'operations.prepare') return preparationService.execute(request, actor);
    return managementService().execute(request, actor);
  }
};

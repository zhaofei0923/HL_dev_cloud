const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chooseLocalImages,
  deleteCloudFiles
} = require('../miniprogram/utils/local-image');

function installWx({ paths = [], uploadFile, deleteFile }) {
  const calls = {
    chooseCount: 0,
    loading: [],
    hidden: 0
  };
  global.wx = {
    chooseImage(options) {
      calls.chooseCount += 1;
      options.success({ tempFilePaths: paths });
    },
    showLoading(options) {
      calls.loading.push(options);
    },
    hideLoading() {
      calls.hidden += 1;
    },
    cloud: {
      uploadFile,
      deleteFile
    }
  };
  return calls;
}

test('private image uploads are isolated by principal id and block the UI while uploading', async () => {
  const cloudPaths = [];
  const calls = installWx({
    paths: ['wxfile://tmp/one.jpg'],
    async uploadFile(options) {
      cloudPaths.push(options.cloudPath);
      return { fileID: `cloud://env/${options.cloudPath}` };
    },
    async deleteFile() {
      return { fileList: [] };
    }
  });

  const result = await chooseLocalImages(1, {
    cloudFolder: 'member-private',
    privateOwnerKey: 42
  });

  assert.equal(result.length, 1);
  assert.match(cloudPaths[0], /^hl_uploads\/member-private\/42\/\d{8}\//);
  assert.deepEqual(calls.loading, [{ title: '上传中', mask: true }]);
  assert.equal(calls.hidden, 1);
});

test('partial private image upload failure deletes every file already uploaded', async () => {
  const deleted = [];
  let uploadCount = 0;
  const calls = installWx({
    paths: ['wxfile://tmp/one.jpg', 'wxfile://tmp/two.jpg'],
    async uploadFile(options) {
      uploadCount += 1;
      if (uploadCount === 2) throw new Error('second upload failed');
      return { fileID: `cloud://env/${options.cloudPath}` };
    },
    async deleteFile(options) {
      deleted.push(...options.fileList);
      return { fileList: options.fileList.map(fileID => ({ fileID, status: 0 })) };
    }
  });

  await assert.rejects(
    chooseLocalImages(2, { cloudFolder: 'member-private', privateOwnerKey: 42 }),
    /second upload failed/
  );
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /\/member-private\/42\//);
  assert.equal(calls.hidden, 1);
});

test('private uploads reject a missing owner before opening the image picker', async () => {
  const calls = installWx({
    async uploadFile() {
      throw new Error('should not upload');
    },
    async deleteFile() {
      return { fileList: [] };
    }
  });

  await assert.rejects(
    chooseLocalImages(1, { cloudFolder: 'member-private' }),
    /invalid private image owner/
  );
  assert.equal(calls.chooseCount, 0);
});

test('cloud file deletion surfaces storage failures', async () => {
  installWx({
    async uploadFile() {
      throw new Error('should not upload');
    },
    async deleteFile(options) {
      return {
        fileList: options.fileList.map(fileID => ({ fileID, status: -1, errMsg: 'permission denied' }))
      };
    }
  });

  await assert.rejects(
    deleteCloudFiles(['cloud://env/hl_uploads/member-private/42/one.jpg']),
    /permission denied/
  );
});

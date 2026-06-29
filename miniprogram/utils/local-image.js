"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveImageUrls = exports.isImageChooseCancel = exports.chooseLocalImages = void 0;
function extensionFromPath(path) {
    const cleanPath = path.split('?')[0] || '';
    const match = cleanPath.match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : 'jpg';
}
function cloudPathFor(tempFilePath) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.random().toString(36).slice(2, 10);
    const ext = extensionFromPath(tempFilePath);
    return `hl_uploads/profile/${year}${month}${day}/${Date.now()}-${random}.${ext}`;
}
function isCloudFileID(path) {
    return /^cloud:\/\//.test(String(path || ''));
}
async function uploadImage(tempFilePath) {
    if (!wx.cloud)
        throw new Error('cloud is not available');
    const result = await wx.cloud.uploadFile({
        cloudPath: cloudPathFor(tempFilePath),
        filePath: tempFilePath
    });
    if (!result.fileID)
        throw new Error('uploadFile returned empty fileID');
    return result.fileID;
}
async function chooseImages(count, sizeType) {
    return new Promise((resolve, reject) => {
        wx.chooseImage({
            count,
            sizeType,
            sourceType: ['album'],
            success(res) {
                resolve((res.tempFilePaths || []).slice(0, count));
            },
            fail(err) {
                reject(err);
            }
        });
    });
}
function cropImage(tempFilePath, mode) {
    return new Promise((resolve, reject) => {
        wx.navigateTo({
            url: '/pages/common/image-cropper',
            success(res) {
                const channel = res.eventChannel;
                channel.once('crop:done', (result) => {
                    if (result && result.tempFilePath) {
                        resolve(result.tempFilePath);
                    }
                    else {
                        reject(new Error('crop failed'));
                    }
                });
                channel.once('crop:cancel', () => reject(new Error('crop cancel')));
                channel.emit('crop:init', {
                    sourcePath: tempFilePath,
                    mode
                });
            },
            fail: reject
        });
    });
}
async function cropImages(paths, mode) {
    if (!mode)
        return paths;
    const croppedPaths = [];
    for (let index = 0; index < paths.length; index += 1) {
        croppedPaths.push(await cropImage(paths[index], mode));
    }
    return croppedPaths;
}
async function uploadOrSave(tempFilePath) {
    const fileID = await uploadImage(tempFilePath);
    return {
        fileID,
        tempFilePath,
        displayUrl: tempFilePath
    };
}
async function chooseLocalImages(count = 1, options = {}) {
    const paths = await chooseImages(count, options.cropMode ? ['original'] : ['compressed']);
    const uploadPaths = await cropImages(paths, options.cropMode);
    if (!uploadPaths.length)
        return [];
    wx.showLoading({ title: '上传中' });
    try {
        return await Promise.all(uploadPaths.map(path => uploadOrSave(path)));
    }
    finally {
        wx.hideLoading();
    }
}
exports.chooseLocalImages = chooseLocalImages;
function errorText(err) {
    if (!err)
        return '';
    if (typeof err === 'string')
        return err;
    if (typeof err === 'object') {
        const value = err;
        return String(value.errMsg || value.message || '');
    }
    return String(err);
}
function isImageChooseCancel(err) {
    return /cancel/i.test(errorText(err));
}
exports.isImageChooseCancel = isImageChooseCancel;
async function resolveImageUrls(paths) {
    const safePaths = paths.filter(Boolean);
    const cloudPaths = safePaths.filter(isCloudFileID);
    if (!cloudPaths.length || !wx.cloud)
        return safePaths;
    try {
        const result = await wx.cloud.getTempFileURL({ fileList: cloudPaths });
        const urlMap = (result.fileList || []).reduce((map, item) => {
            if (item.fileID && item.tempFileURL && item.status === 0)
                map[item.fileID] = item.tempFileURL;
            return map;
        }, {});
        return safePaths.map(path => urlMap[path] || path);
    }
    catch (err) {
        return safePaths;
    }
}
exports.resolveImageUrls = resolveImageUrls;

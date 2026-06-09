"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveImageUrls = exports.chooseLocalImages = void 0;
function saveLocalImage(tempFilePath) {
    return new Promise(resolve => {
        wx.saveFile({
            tempFilePath,
            success(res) {
                resolve(res.savedFilePath);
            },
            fail() {
                resolve(tempFilePath);
            }
        });
    });
}
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
    return result.fileID;
}
async function chooseImages(count) {
    return new Promise((resolve, reject) => {
        wx.chooseImage({
            count,
            sizeType: ['compressed'],
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
async function uploadOrSave(tempFilePath) {
    try {
        const fileID = await uploadImage(tempFilePath);
        return {
            fileID,
            tempFilePath,
            displayUrl: tempFilePath
        };
    }
    catch (err) {
        const savedFilePath = await saveLocalImage(tempFilePath);
        return {
            fileID: savedFilePath,
            tempFilePath,
            displayUrl: savedFilePath
        };
    }
}
async function chooseLocalImages(count = 1) {
    const paths = await chooseImages(count);
    return Promise.all(paths.map(path => uploadOrSave(path)));
}
exports.chooseLocalImages = chooseLocalImages;
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

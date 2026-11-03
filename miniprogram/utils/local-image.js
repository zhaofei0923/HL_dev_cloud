"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveImageUrls = exports.isImageChooseCancel = exports.chooseLocalImages = exports.deleteCloudFiles = void 0;
const CLOUD_FOLDER_PATHS = {
    profile: 'profile',
    'member-private': 'member-private'
};
const PHOTO_MAX_WIDTH = 750;
const PHOTO_MAX_HEIGHT = 1334;
const PHOTO_TARGET_BYTES = 900000;
function imageInfo(src) {
    return new Promise((resolve, reject) => {
        wx.getImageInfo({ src, success: resolve, fail: reject });
    });
}
function imageFileSize(filePath) {
    return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({
        filePath, success: result => resolve(result.size), fail: reject
    }));
}
function validImageDimensions(info) {
    return Number.isInteger(info.width) && Number.isInteger(info.height) && info.width > 0 && info.height > 0;
}
function readyToUpload(info, size) {
    return validImageDimensions(info) && info.width <= PHOTO_MAX_WIDTH && info.height <= PHOTO_MAX_HEIGHT
        && /^(?:jpe?g|png)$/i.test(info.type) && Number.isFinite(size) && size > 0 && size <= PHOTO_TARGET_BYTES;
}
async function prepareImageForUpload(filePath) {
    try {
        const original = await imageInfo(filePath);
        if (!validImageDimensions(original))
            throw new Error('invalid image dimensions');
        const size = await imageFileSize(filePath);
        if (readyToUpload(original, size))
            return filePath;
        const scale = Math.min(1, PHOTO_MAX_WIDTH / original.width, PHOTO_MAX_HEIGHT / original.height);
        const compressedWidth = Math.max(1, Math.floor(original.width * scale));
        const compressedHeight = Math.max(1, Math.floor(original.height * scale));
        for (const quality of [85, 65, 45, 25]) {
            // The bundled typings predate the 2.26.0 image dimension options.
            const options = {
                src: filePath, quality, compressedWidth, compressedHeight
            };
            const path = await new Promise((resolve, reject) => {
                options.success = result => resolve(result.tempFilePath);
                options.fail = reject;
                wx.compressImage(options);
            });
            if (!path)
                throw new Error('empty compressed image');
            const prepared = await imageInfo(path);
            const preparedSize = await imageFileSize(path);
            if (readyToUpload(prepared, preparedSize))
                return path;
        }
    }
    catch (error) {
        console.warn('prepare image upload failed');
    }
    throw new Error('照片处理失败，请重新选择或缩小图片后重试');
}
function extensionFromPath(path) {
    const cleanPath = path.split('?')[0] || '';
    const match = cleanPath.match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : 'jpg';
}
function cloudFolderPath(folder) {
    return folder === 'member-private'
        ? CLOUD_FOLDER_PATHS['member-private']
        : CLOUD_FOLDER_PATHS.profile;
}
function privateOwnerPath(ownerKey) {
    const value = String(ownerKey === undefined || ownerKey === null ? '' : ownerKey).trim();
    if (!/^[1-9]\d*$/.test(value))
        throw new Error('invalid private image owner');
    return value;
}
function cloudPathFor(tempFilePath, options) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.random().toString(36).slice(2, 10);
    const ext = extensionFromPath(tempFilePath);
    const folder = cloudFolderPath(options.cloudFolder);
    const ownerPath = options.cloudFolder === 'member-private'
        ? `${privateOwnerPath(options.privateOwnerKey)}/`
        : '';
    return `hl_uploads/${folder}/${ownerPath}${year}${month}${day}/${Date.now()}-${random}.${ext}`;
}
function isCloudFileID(path) {
    return /^cloud:\/\//.test(String(path || ''));
}
async function uploadImage(tempFilePath, options) {
    if (!wx.cloud)
        throw new Error('cloud is not available');
    const result = await wx.cloud.uploadFile({
        cloudPath: cloudPathFor(tempFilePath, options),
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
function cropImage(tempFilePath) {
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
                    sourcePath: tempFilePath
                });
            },
            fail: reject
        });
    });
}
async function cropImages(paths, crop) {
    if (!crop)
        return paths;
    const croppedPaths = [];
    for (let index = 0; index < paths.length; index += 1) {
        croppedPaths.push(await cropImage(paths[index]));
    }
    return croppedPaths;
}
async function uploadOrSave(tempFilePath, options) {
    const preparedPath = await prepareImageForUpload(tempFilePath);
    const fileID = await uploadImage(preparedPath, options);
    return {
        fileID,
        tempFilePath: preparedPath,
        displayUrl: preparedPath
    };
}
async function deleteCloudFiles(paths) {
    const fileIDs = Array.from(new Set(paths.map(path => String(path || '')).filter(isCloudFileID)));
    if (!fileIDs.length || !wx.cloud)
        return;
    for (let index = 0; index < fileIDs.length; index += 50) {
        const result = await wx.cloud.deleteFile({ fileList: fileIDs.slice(index, index + 50) });
        const failures = (result.fileList || []).filter(item => Number(item.status) !== 0);
        if (failures.length) {
            throw new Error(failures.map(item => item.errMsg || `delete failed: ${item.fileID}`).join('; '));
        }
    }
}
exports.deleteCloudFiles = deleteCloudFiles;
async function chooseLocalImages(count = 1, options = {}) {
    if (options.cloudFolder === 'member-private')
        privateOwnerPath(options.privateOwnerKey);
    const paths = await chooseImages(count, options.crop ? ['original'] : ['compressed']);
    const uploadPaths = await cropImages(paths, options.crop);
    if (!uploadPaths.length)
        return [];
    wx.showLoading({ title: '上传中', mask: true });
    const uploaded = [];
    try {
        for (let index = 0; index < uploadPaths.length; index += 1) {
            uploaded.push(await uploadOrSave(uploadPaths[index], options));
        }
        return uploaded;
    }
    catch (err) {
        try {
            await deleteCloudFiles(uploaded.map(item => item.fileID));
        }
        catch (cleanupErr) {
            console.warn('cleanup partial image uploads failed', cleanupErr);
        }
        throw err;
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

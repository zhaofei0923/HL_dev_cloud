"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chat_1 = require("../../services/chat");
const chat_voice_1 = require("../../utils/chat-voice");
let audioContext = null;
let voicePressing = false;
function pad(value) {
    return value < 10 ? `0${value}` : String(value);
}
function formatTime(value) {
    if (!value)
        return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return '';
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function normalizeMessage(row) {
    return {
        ...row,
        anchorId: `msg-${row.id}`,
        idText: String(row.id),
        timeText: formatTime(row.createdAt),
        senderAvatar: (row.sender && row.sender.avatarUrl) || '/assets/members/avatar-female-1.png',
        voiceDurationText: (0, chat_voice_1.voiceDurationText)(row.voiceDuration)
    };
}
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
function stopAudio(page) {
    if (audioContext) {
        audioContext.stop();
        audioContext.destroy();
        audioContext = null;
    }
    if (page)
        page.setData({ playingVoiceId: '' });
}
Page({
    data: {
        id: '',
        conversation: null,
        messages: [],
        inputValue: '',
        scrollIntoView: '',
        voiceMode: false,
        recording: false,
        recordingTip: '按住说话',
        playingVoiceId: '',
        loading: false,
        sending: false
    },
    onLoad(options) {
        this.setData({ id: String(options.id || '') });
        this.load();
    },
    onUnload() {
        stopAudio(this);
        (0, chat_voice_1.cancelChatVoiceRecording)();
        if (this.data.id)
            chat_1.chatApi.markRead(this.data.id).catch(err => console.warn('mark user chat read failed', err));
    },
    async load() {
        if (!this.data.id)
            return;
        this.setData({ loading: true });
        try {
            const result = await chat_1.chatApi.listMessages(this.data.id, { page: 1, pageSize: 80 });
            const messages = await (0, chat_voice_1.resolveChatVoiceUrls)((result.messages || []).map(normalizeMessage));
            const last = messages[messages.length - 1];
            this.setData({
                conversation: result.conversation,
                messages,
                scrollIntoView: last ? last.anchorId : ''
            });
            if (result.conversation && result.conversation.title) {
                wx.setNavigationBarTitle({ title: result.conversation.title.slice(0, 12) });
            }
        }
        catch (err) {
            console.warn('load user chat failed', err);
            wx.showToast({ title: '会话暂不可用', icon: 'none' });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    onInput(e) {
        this.setData({ inputValue: e.detail.value });
    },
    toggleVoiceMode() {
        if (this.data.sending || this.data.recording)
            return;
        this.setData({ voiceMode: !this.data.voiceMode });
    },
    async send() {
        const content = String(this.data.inputValue || '').trim();
        if (!content) {
            wx.showToast({ title: '请输入消息', icon: 'none' });
            return;
        }
        if (this.data.sending)
            return;
        this.setData({ sending: true });
        try {
            await chat_1.chatApi.sendMessage(this.data.id, content);
            this.setData({ inputValue: '' });
            await this.load();
        }
        catch (err) {
            console.warn('send user chat message failed', err);
        }
        finally {
            this.setData({ sending: false });
        }
    },
    async startVoice() {
        if (this.data.sending || this.data.recording)
            return;
        voicePressing = true;
        try {
            await (0, chat_voice_1.startChatVoiceRecording)();
            if (!voicePressing) {
                (0, chat_voice_1.cancelChatVoiceRecording)();
                return;
            }
            this.setData({ recording: true, recordingTip: '松开发送' });
        }
        catch (err) {
            if (!/permission denied/.test(errorText(err))) {
                wx.showToast({ title: '录音启动失败', icon: 'none' });
            }
        }
    },
    async finishVoice() {
        voicePressing = false;
        if (!this.data.recording || this.data.sending)
            return;
        this.setData({ recording: false, recordingTip: '正在发送', sending: true });
        wx.showLoading({ title: '发送中' });
        try {
            const record = await (0, chat_voice_1.stopChatVoiceRecording)();
            const voiceFileID = await (0, chat_voice_1.uploadChatVoice)(record.tempFilePath);
            await chat_1.chatApi.sendVoiceMessage(this.data.id, {
                voiceFileID,
                voiceDuration: record.durationSeconds,
                voiceFormat: record.format,
                voiceFileSize: record.fileSize
            });
            await this.load();
        }
        catch (err) {
            const text = errorText(err);
            if (!/cancel/i.test(text)) {
                wx.showToast({ title: /too short|not recording/i.test(text) ? '录音时间太短' : '语音发送失败', icon: 'none' });
            }
        }
        finally {
            wx.hideLoading();
            this.setData({ sending: false, recordingTip: '按住说话' });
        }
    },
    cancelVoice() {
        voicePressing = false;
        if (!this.data.recording)
            return;
        (0, chat_voice_1.cancelChatVoiceRecording)();
        this.setData({ recording: false, recordingTip: '按住说话' });
    },
    playVoice(e) {
        const id = String(e.currentTarget.dataset.id || '');
        if (!id)
            return;
        if (this.data.playingVoiceId === id) {
            stopAudio(this);
            return;
        }
        const message = this.data.messages.find(item => item.idText === id);
        const src = message ? (message.voiceUrl || message.voiceFileID || '') : '';
        if (!src) {
            wx.showToast({ title: '语音暂不可播放', icon: 'none' });
            return;
        }
        stopAudio(this);
        const nextAudio = wx.createInnerAudioContext();
        audioContext = nextAudio;
        nextAudio.src = src;
        nextAudio.onEnded(() => stopAudio(this));
        nextAudio.onError(err => {
            console.warn('play user voice failed', err);
            stopAudio(this);
            wx.showToast({ title: '语音播放失败', icon: 'none' });
        });
        this.setData({ playingVoiceId: id });
        nextAudio.play();
    }
});

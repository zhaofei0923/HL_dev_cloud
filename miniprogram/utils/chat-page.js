"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChatPageDefinition = void 0;
const chat_1 = require("../services/chat");
const page_session_1 = require("./page-session");
const chat_voice_1 = require("./chat-voice");
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
function permissionDenied(err) {
    const code = err && typeof err === 'object' ? Number(err.code) : 0;
    return code === 401 || code === 403 || Math.floor(code / 100) === 401 || Math.floor(code / 100) === 403;
}
function mergeMessages(existing, incoming) {
    const byId = new Map();
    existing.concat(incoming).forEach(message => byId.set(Number(message.id), message));
    return Array.from(byId.values()).sort((a, b) => Number(a.id) - Number(b.id));
}
function defineChatPage(definition) { return definition; }
function createChatPageDefinition() {
    let audioContext = null;
    let voicePressing = false;
    function stopAudio(page) {
        if (audioContext) {
            audioContext.stop();
            audioContext.destroy();
            audioContext = null;
        }
        if (page)
            page.setData({ playingVoiceId: '' });
    }
    return defineChatPage({
        _chatScope: '',
        _chatGeneration: 0,
        _chatLoaded: false,
        _latestReadId: 0,
        _chatUnloaded: false,
        _loadPromise: null,
        _historyPromise: null,
        _newMessagesPromise: null,
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
            sending: false,
            historyLoading: false,
            hasMoreHistory: false,
            refreshing: false,
            errorNote: ''
        },
        onLoad(options) {
            this.setData({ id: String(options.id || '') });
            return this.load();
        },
        onShow() {
            this._chatUnloaded = false;
            this.synchronizeChatSession();
            if (this._loadPromise)
                return this._loadPromise;
            return this._chatLoaded ? this.refreshNewMessages() : this.load();
        },
        onHide() {
            voicePressing = false;
            stopAudio(this);
            (0, chat_voice_1.cancelChatVoiceRecording)();
            this.setData({ recording: false, recordingTip: '按住说话' });
        },
        onUnload() {
            this._chatUnloaded = true;
            this._chatGeneration += 1;
            this._loadPromise = null;
            this._historyPromise = null;
            this._newMessagesPromise = null;
            voicePressing = false;
            stopAudio(this);
            (0, chat_voice_1.cancelChatVoiceRecording)();
        },
        synchronizeChatSession() {
            const scope = (0, page_session_1.pageSessionScope)();
            if (scope !== this._chatScope) {
                voicePressing = false;
                stopAudio(this);
                (0, chat_voice_1.cancelChatVoiceRecording)();
                this._chatScope = scope;
                this._chatGeneration += 1;
                this._chatLoaded = false;
                this._latestReadId = 0;
                this._loadPromise = null;
                this._historyPromise = null;
                this._newMessagesPromise = null;
                this.setData({ conversation: null, messages: [], inputValue: '', scrollIntoView: '',
                    hasMoreHistory: false, historyLoading: false, loading: false, refreshing: false,
                    sending: false, recording: false, errorNote: '' });
            }
            if (!scope && !this._chatUnloaded)
                wx.redirectTo({ url: '/pages/index/index' });
            return scope;
        },
        chatRequestCurrent(scope, generation) {
            return !this._chatUnloaded && scope === (0, page_session_1.pageSessionScope)() && generation === this._chatGeneration;
        },
        chatReadError(err) {
            if (permissionDenied(err)) {
                voicePressing = false;
                (0, chat_voice_1.cancelChatVoiceRecording)();
                this._chatLoaded = false;
                this._latestReadId = 0;
                this._chatGeneration += 1;
                this._loadPromise = null;
                this._historyPromise = null;
                this._newMessagesPromise = null;
                stopAudio(this);
                this.setData({ conversation: null, messages: [], hasMoreHistory: false,
                    loading: false, historyLoading: false, refreshing: false, sending: false,
                    recording: false, recordingTip: '按住说话', inputValue: '',
                    errorNote: '会话权限已变化，请返回消息页重新进入。' });
            }
            else
                this.setData({ errorNote: '消息暂未更新，请点击刷新重试。' });
        },
        load(force = false) {
            const scope = this.synchronizeChatSession();
            if (!scope || !this.data.id || this._chatUnloaded)
                return Promise.resolve();
            if (!force && this._loadPromise)
                return this._loadPromise;
            const generation = ++this._chatGeneration;
            this._historyPromise = null;
            this._newMessagesPromise = null;
            this.setData({ loading: !this._chatLoaded, historyLoading: false, refreshing: false, errorNote: '' });
            const pending = Promise.resolve().then(async () => {
                try {
                    const result = await chat_1.chatApi.listMessages(this.data.id, { pageSize: 80 });
                    const messages = await (0, chat_voice_1.resolveChatVoiceUrls)((result.messages || []).map(normalizeMessage));
                    if (!this.chatRequestCurrent(scope, generation))
                        return;
                    const last = messages[messages.length - 1];
                    this._chatLoaded = true;
                    this._latestReadId = Number(result.latestId || last?.id || 0);
                    this.setData({ conversation: result.conversation, messages,
                        hasMoreHistory: result.hasMore === true, scrollIntoView: last ? last.anchorId : '' });
                    if (result.conversation && result.conversation.title) {
                        wx.setNavigationBarTitle({ title: result.conversation.title.slice(0, 12) });
                    }
                }
                catch (err) {
                    if (this.chatRequestCurrent(scope, generation))
                        this.chatReadError(err);
                }
                finally {
                    if (this.chatRequestCurrent(scope, generation))
                        this.setData({ loading: false });
                    if (this._loadPromise === pending)
                        this._loadPromise = null;
                }
            });
            this._loadPromise = pending;
            return pending;
        },
        loadOlder() {
            const scope = this.synchronizeChatSession();
            if (!scope || !this._chatLoaded || !this.data.hasMoreHistory || this._chatUnloaded)
                return Promise.resolve();
            if (this._historyPromise)
                return this._historyPromise;
            const first = this.data.messages[0];
            if (!first)
                return Promise.resolve();
            const generation = this._chatGeneration;
            this.setData({ historyLoading: true, errorNote: '' });
            const pending = Promise.resolve().then(async () => {
                try {
                    const result = await chat_1.chatApi.listMessages(this.data.id, { beforeId: Number(first.id), pageSize: 80 });
                    const incoming = await (0, chat_voice_1.resolveChatVoiceUrls)((result.messages || []).map(normalizeMessage));
                    if (!this.chatRequestCurrent(scope, generation))
                        return;
                    this.setData({ messages: mergeMessages(this.data.messages, incoming),
                        hasMoreHistory: result.hasMore === true, scrollIntoView: first.anchorId });
                }
                catch (err) {
                    if (this.chatRequestCurrent(scope, generation))
                        this.chatReadError(err);
                }
                finally {
                    if (this.chatRequestCurrent(scope, generation))
                        this.setData({ historyLoading: false });
                    if (this._historyPromise === pending)
                        this._historyPromise = null;
                }
            });
            this._historyPromise = pending;
            return pending;
        },
        refreshNewMessages() {
            const scope = this.synchronizeChatSession();
            if (!scope || this._chatUnloaded)
                return Promise.resolve();
            if (!this._chatLoaded)
                return this.load();
            if (this._newMessagesPromise)
                return this._newMessagesPromise;
            const generation = this._chatGeneration;
            this.setData({ refreshing: true, errorNote: '' });
            const pending = Promise.resolve().then(async () => {
                try {
                    let cursor = this._latestReadId;
                    let hasMore = true;
                    while (hasMore && this.chatRequestCurrent(scope, generation)) {
                        const result = await chat_1.chatApi.listMessages(this.data.id, { afterId: cursor, pageSize: 80 });
                        const incoming = await (0, chat_voice_1.resolveChatVoiceUrls)((result.messages || []).map(normalizeMessage));
                        if (!this.chatRequestCurrent(scope, generation))
                            return;
                        const last = incoming[incoming.length - 1];
                        const nextCursor = Number(last?.id || 0);
                        if (nextCursor > cursor)
                            this._latestReadId = nextCursor;
                        this.setData({ conversation: result.conversation,
                            ...(incoming.length ? { messages: mergeMessages(this.data.messages, incoming), scrollIntoView: last.anchorId } : {}) });
                        hasMore = result.hasMore === true && nextCursor > cursor;
                        cursor = nextCursor || cursor;
                    }
                }
                catch (err) {
                    if (this.chatRequestCurrent(scope, generation))
                        this.chatReadError(err);
                }
                finally {
                    if (this.chatRequestCurrent(scope, generation))
                        this.setData({ refreshing: false });
                    if (this._newMessagesPromise === pending)
                        this._newMessagesPromise = null;
                }
            });
            this._newMessagesPromise = pending;
            return pending;
        },
        onPullDownRefresh() {
            return this.refreshNewMessages().finally(() => wx.stopPullDownRefresh());
        },
        async appendSentMessage(message, scope, generation) {
            const incoming = await (0, chat_voice_1.resolveChatVoiceUrls)([normalizeMessage(message)]);
            if (!this.chatRequestCurrent(scope, generation))
                return;
            this.setData({ messages: mergeMessages(this.data.messages, incoming), scrollIntoView: incoming[0].anchorId });
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
            const scope = this.synchronizeChatSession();
            if (!scope || this._chatUnloaded)
                return;
            const generation = this._chatGeneration;
            if (!this._chatLoaded || this.data.loading)
                return;
            const originalInput = this.data.inputValue;
            const content = String(originalInput || '').trim();
            if (!content) {
                wx.showToast({ title: '请输入消息', icon: 'none' });
                return;
            }
            if (this.data.sending)
                return;
            this.setData({ sending: true });
            try {
                const message = await chat_1.chatApi.sendMessage(this.data.id, content);
                if (!this.chatRequestCurrent(scope, generation))
                    return;
                if (this.data.inputValue === originalInput)
                    this.setData({ inputValue: '' });
                await this.appendSentMessage(message, scope, generation);
            }
            catch (err) {
                if (this.chatRequestCurrent(scope, generation) && permissionDenied(err))
                    this.chatReadError(err);
            }
            finally {
                if (this.chatRequestCurrent(scope, generation))
                    this.setData({ sending: false });
            }
        },
        async startVoice() {
            const scope = this.synchronizeChatSession();
            const generation = this._chatGeneration;
            if (!scope || !this._chatLoaded || this.data.loading || this.data.sending || this.data.recording)
                return;
            voicePressing = true;
            try {
                await (0, chat_voice_1.startChatVoiceRecording)();
                if (!voicePressing || !this.chatRequestCurrent(scope, generation)) {
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
            const scope = this.synchronizeChatSession();
            const generation = this._chatGeneration;
            voicePressing = false;
            if (!scope || !this.data.recording || this.data.sending)
                return;
            this.setData({ recording: false, recordingTip: '正在发送', sending: true });
            wx.showLoading({ title: '发送中' });
            try {
                const record = await (0, chat_voice_1.stopChatVoiceRecording)();
                if (!this.chatRequestCurrent(scope, generation))
                    return;
                const voiceFileID = await (0, chat_voice_1.uploadChatVoice)(record.tempFilePath);
                if (!this.chatRequestCurrent(scope, generation))
                    return;
                const message = await chat_1.chatApi.sendVoiceMessage(this.data.id, {
                    voiceFileID,
                    voiceDuration: record.durationSeconds,
                    voiceFormat: record.format,
                    voiceFileSize: record.fileSize
                });
                await this.appendSentMessage(message, scope, generation);
            }
            catch (err) {
                const text = errorText(err);
                if (!/cancel/i.test(text)) {
                    wx.showToast({ title: /too short|not recording/i.test(text) ? '录音时间太短' : '语音发送失败', icon: 'none' });
                }
            }
            finally {
                wx.hideLoading();
                if (this.chatRequestCurrent(scope, generation))
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
}
exports.createChatPageDefinition = createChatPageDefinition;

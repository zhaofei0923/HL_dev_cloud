import { request } from './api'

export type ChatParticipant = {
  id: number
  nickname: string
  avatarUrl: string
}

export type ChatConversation = {
  id: number
  conversationType: 'member_matchmaker' | 'member_pair'
  participantIds: number[]
  peer: ChatParticipant | null
  title: string
  unreadCount: number
  hasUnread: boolean
  lastMessageContent: string
  lastMessageAt: string
  updatedAt: string
}

export type ChatConversationPage = {
  list: ChatConversation[]
  total: number
  page: number
  pageSize: number
}

export type ChatMessage = {
  id: number
  conversationId: number
  senderId: number
  receiverId: number
  contentType: 'text' | 'voice'
  content: string
  voiceFileID?: string
  voiceUrl?: string
  voiceDuration?: number
  voiceDurationText?: string
  voiceFormat?: string
  voiceFileSize?: number
  isMine: boolean
  sender: ChatParticipant
  createdAt: string
}

export type ChatMessagePage = {
  conversation: ChatConversation
  messages: ChatMessage[]
  total: number
  page: number
  pageSize: number
}

type ConversationQuery = {
  page?: number
  pageSize?: number
}

type ConversationTarget = {
  targetUserId?: number | string
  targetMemberId?: number | string
  memberId?: number | string
}

type VoiceMessageData = {
  voiceFileID: string
  voiceDuration: number
  voiceFormat?: string
  voiceFileSize?: number
}

export const chatApi = {
  listConversations(data: ConversationQuery = {}) {
    return request<ChatConversationPage>('/chat/conversations', { data })
  },

  getOrCreateConversation(data: ConversationTarget) {
    return request<ChatConversation>('/chat/conversations', { method: 'POST', data })
  },

  listMessages(id: number | string, data: ConversationQuery = {}) {
    return request<ChatMessagePage>(`/chat/conversations/${id}/messages`, { data })
  },

  sendMessage(id: number | string, content: string) {
    return request<ChatMessage>(`/chat/conversations/${id}/messages`, {
      method: 'POST',
      data: { content, contentType: 'text' }
    })
  },

  sendVoiceMessage(id: number | string, data: VoiceMessageData) {
    return request<ChatMessage>(`/chat/conversations/${id}/messages`, {
      method: 'POST',
      data: { ...data, contentType: 'voice' }
    })
  },

  markRead(id: number | string) {
    return request<ChatConversation>(`/chat/conversations/${id}/read`, { method: 'POST' })
  }
}

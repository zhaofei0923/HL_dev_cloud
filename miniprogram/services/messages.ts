import { request } from './api'
import { ChatParticipant } from './chat'

export type NotificationMessage = {
  id: number
  senderId?: number
  receiverId: number
  contentType: string
  messageType?: string
  content: string
  targetUserId?: number
  targetMemberId?: number | string
  conversationId?: number | null
  canChat?: boolean
  locked: boolean
  isRead: boolean
  hasUnread: boolean
  createdAt: string
  sender?: ChatParticipant | null
}

export type NotificationMessagePage = {
  list: NotificationMessage[]
  total: number
  page: number
  pageSize: number
  unreadCount: number
}

type MessageQuery = {
  page?: number
  pageSize?: number
}

export const messageApi = {
  list(data: MessageQuery = {}) {
    return request<NotificationMessagePage>('/messages', { data })
  },

  markRead(id: number | string) {
    return request<NotificationMessage>(`/messages/${id}/read`, { method: 'POST' })
  }
}

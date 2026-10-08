export type UserTabKey = 'members' | 'salon' | 'messages' | 'mine'

const USER_TAB_ROUTES: Record<string, UserTabKey> = {
  'pages/user/members': 'members',
  'pages/user/salon': 'salon',
  'pages/user/messages': 'messages',
  'pages/user/profile': 'mine'
}

export function userTabKeyForRoute(route: string): UserTabKey | null {
  return USER_TAB_ROUTES[route.replace(/^\//, '')] || null
}

export function syncUserTabBar(page: unknown, activeKey: UserTabKey): void {
  if (!page || typeof page !== 'object' || !('getTabBar' in page) || typeof page.getTabBar !== 'function') return
  const tabBar: unknown = page.getTabBar()
  if (!tabBar || typeof tabBar !== 'object' || !('setData' in tabBar) || typeof tabBar.setData !== 'function') return
  tabBar.setData({ active: activeKey })
}

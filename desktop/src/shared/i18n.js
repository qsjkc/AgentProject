export const DEFAULT_LANGUAGE = 'zh-CN'

export const SUPPORTED_LANGUAGES = [
  { value: 'zh-CN', labelKey: 'languageChinese' },
  { value: 'en', labelKey: 'languageEnglish' },
]

const messages = {
  'zh-CN': {
    appName: 'Detachym',
    language: '语言',
    languageChinese: '简体中文',
    languageEnglish: 'English',
    desktopAccess: '桌面端登录',
    desktopTitle: 'Detachym 桌面客户端',
    desktopIntro: '先配置服务器地址，再登录云端账户，之后即可使用聊天会话和知识库能力。',
    serverUrlPlaceholder: '服务器地址，例如 https://your-domain.com/api/v1',
    testConnection: '测试连接',
    testing: '测试中...',
    usernameOrEmail: '用户名或邮箱',
    password: '密码',
    signIn: '登录',
    signingIn: '登录中...',
    desktopClientLoginSucceeded: '桌面端登录成功。',
    unableToReachService: '无法连接到 Detachym 服务。',
    loginFailed: '登录失败。',
    serverConnectionVerified: '服务器连接已验证。',
    startingDesktopClient: '正在启动桌面客户端...',
    waitingResponse: '正在等待回复...',
    latestResponseReceived: '已收到最新回复。',
    messageDeliveryFailed: '消息发送失败。',
    unableToLoadSession: '无法加载会话。',
    documentUploadedIndexed: '文档已上传并完成索引。',
    uploadFailed: '上传失败。',
    documentDeleted: '文档已删除。',
    deleteFailed: '删除失败。',
    signedOut: '已退出登录。',
    updateServerUrlHint: '请更新服务器地址后重新登录。',
    desktopMainPanel: '桌面主面板',
    welcomeUser: '欢迎，{username}',
    serverLabel: '服务器：{server}',
    chat: '聊天',
    knowledgeBase: '知识库',
    changeServer: '修改服务器',
    signOut: '退出登录',
    sessions: '会话列表',
    currentSession: '当前会话',
    newSession: '新会话',
    enableKnowledgeBase: '启用知识库',
    noSessionYet: '还没有会话，发送第一条消息后会自动创建。',
    desktopPanelIntro: '桌面主面板会连接云端 API。你可以在这里继续提问，并按需启用私有知识库。',
    typeMessagePlaceholder: '输入发给云端助手的消息...',
    sendMessage: '发送消息',
    sending: '发送中...',
    manageDocuments: '管理文档',
    uploadDocument: '上传文档',
    noDocumentYet: '还没有上传文档。',
    delete: '删除',
    documentMeta: '{status} | {count} 个分块 | {size} KB',
    quickChat: '快捷聊天',
    desktopQuickChat: '桌面快捷聊天',
    startingQuickChat: '正在启动快捷聊天...',
    quickChatSetupText: '请先打开主面板，配置服务器地址，并登录云端账户后再使用快捷聊天。',
    openMainPanel: '打开主面板',
    quickChatEmpty: '点击桌宠后可以在这里快速提问，桌面端会使用你当前的云端账户和知识库设置。',
    quickChatPlaceholder: '输入发给 Detachym 的问题...',
    send: '发送',
    petCat: '猫咪',
    petDog: '小狗',
    petPig: '小猪',
    desktopPetAlt: '{pet} 桌宠',
    quickChatOpened: '快捷聊天已打开。',
    quickChatClosed: '快捷聊天已收起。',
    mainPanelOpened: '主面板已打开。',
    signInHint: '先登录云端账户后再使用桌宠互动。',
    dragSaved: '位置已更新。',
    quickChatDisabledHint: '当前已关闭单击快捷聊天。',
    interactionHint: '单击快捷聊天，双击主面板，拖动可移动位置。',
    petIdleMessages: [
      '今天也一起工作。',
      '单击我可以呼出快捷聊天。',
      '双击我可以打开主面板。',
      '拖动我到你喜欢的位置。',
    ],
    petHappyMessages: [
      '我在这里待命。',
      '有需要就点我一下。',
      '今天状态不错。',
    ],
    petExcitedMessages: [
      '收到，马上响应。',
      '这次互动我记住了。',
      '继续保持这个节奏。',
    ],
    petSadMessages: [
      '我还没连上你的账户。',
      '先登录之后我就能同步偏好了。',
      '现在只能先陪着你待机。',
    ],
  },
  en: {
    appName: 'Detachym',
    language: 'Language',
    languageChinese: 'Simplified Chinese',
    languageEnglish: 'English',
    desktopAccess: 'Desktop Access',
    desktopTitle: 'Detachym Desktop',
    desktopIntro: 'Configure the server address first, then sign in to use chat sessions and knowledge base tools.',
    serverUrlPlaceholder: 'Server URL, for example https://your-domain.com/api/v1',
    testConnection: 'Test Connection',
    testing: 'Testing...',
    usernameOrEmail: 'Username or email',
    password: 'Password',
    signIn: 'Sign In',
    signingIn: 'Signing in...',
    desktopClientLoginSucceeded: 'Desktop client login succeeded.',
    unableToReachService: 'Unable to reach the Detachym service.',
    loginFailed: 'Login failed.',
    serverConnectionVerified: 'Server connection verified.',
    startingDesktopClient: 'Starting the desktop client...',
    waitingResponse: 'Waiting for a response...',
    latestResponseReceived: 'Latest response received.',
    messageDeliveryFailed: 'Message delivery failed.',
    unableToLoadSession: 'Unable to load the session.',
    documentUploadedIndexed: 'Document uploaded and indexed.',
    uploadFailed: 'Upload failed.',
    documentDeleted: 'Document deleted.',
    deleteFailed: 'Delete failed.',
    signedOut: 'Signed out.',
    updateServerUrlHint: 'Update the server URL and sign in again.',
    desktopMainPanel: 'Desktop Main Panel',
    welcomeUser: 'Welcome, {username}',
    serverLabel: 'Server: {server}',
    chat: 'Chat',
    knowledgeBase: 'Knowledge Base',
    changeServer: 'Change Server',
    signOut: 'Sign Out',
    sessions: 'Sessions',
    currentSession: 'Current Session',
    newSession: 'New Session',
    enableKnowledgeBase: 'Enable knowledge base',
    noSessionYet: 'No session yet. Send the first message to create one.',
    desktopPanelIntro: 'The desktop panel connects to the cloud API. Ask questions here and optionally use your private knowledge base.',
    typeMessagePlaceholder: 'Type a message for the cloud assistant...',
    sendMessage: 'Send Message',
    sending: 'Sending...',
    manageDocuments: 'Manage Documents',
    uploadDocument: 'Upload Document',
    noDocumentYet: 'No document uploaded yet.',
    delete: 'Delete',
    documentMeta: '{status} | {count} chunks | {size} KB',
    quickChat: 'Quick Chat',
    desktopQuickChat: 'Desktop Quick Chat',
    startingQuickChat: 'Starting quick chat...',
    quickChatSetupText: 'Open the main panel first, configure the server URL, and sign in to your cloud account before using quick chat.',
    openMainPanel: 'Open Main Panel',
    quickChatEmpty: 'Ask a question here after clicking the pet. The desktop client will use your current cloud account and knowledge base settings.',
    quickChatPlaceholder: 'Type a question for Detachym...',
    send: 'Send',
    petCat: 'Cat',
    petDog: 'Dog',
    petPig: 'Pig',
    desktopPetAlt: '{pet} desktop pet',
    quickChatOpened: 'Quick chat is open.',
    quickChatClosed: 'Quick chat is hidden.',
    mainPanelOpened: 'Main panel is open.',
    signInHint: 'Sign in to your cloud account before using pet interactions.',
    dragSaved: 'Position updated.',
    quickChatDisabledHint: 'Single-click quick chat is currently disabled.',
    interactionHint: 'Single click for quick chat, double click for the main panel, drag to move.',
    petIdleMessages: [
      'Ready when you are.',
      'Single click opens quick chat.',
      'Double click opens the main panel.',
      'Drag me anywhere you like.',
    ],
    petHappyMessages: [
      'I am on standby.',
      'Tap me when you need me.',
      'This feels smooth.',
    ],
    petExcitedMessages: [
      'On it.',
      'That interaction landed.',
      'Keep going.',
    ],
    petSadMessages: [
      'I am not connected to your account yet.',
      'Sign in first and I can sync your preferences.',
      'I can only idle with you for now.',
    ],
  },
}

export function normalizeLanguage(value) {
  const normalizedValue = String(value || '').trim().toLowerCase()

  if (!normalizedValue) {
    return DEFAULT_LANGUAGE
  }

  if (normalizedValue.startsWith('zh')) {
    return 'zh-CN'
  }

  if (normalizedValue.startsWith('en')) {
    return 'en'
  }

  return DEFAULT_LANGUAGE
}

function interpolate(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
}

function resolveMessage(language, key) {
  const normalized = normalizeLanguage(language)
  return messages[normalized]?.[key] ?? messages[DEFAULT_LANGUAGE]?.[key] ?? key
}

export function t(language, key, params = {}) {
  const template = resolveMessage(language, key)
  if (typeof template !== 'string') {
    return key
  }
  return interpolate(template, params)
}

export function getMessagePool(language, key) {
  const value = resolveMessage(language, key)
  return Array.isArray(value) ? value : []
}

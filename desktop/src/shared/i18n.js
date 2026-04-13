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
    desktopTitle: 'Detachym 桌宠客户端',
    desktopIntro: '先配置服务地址，再登录云端账号，即可使用聊天、知识库和桌宠同步功能。',
    serverUrlPlaceholder: '服务地址，例如 https://detachym.top/api/v1',
    testConnection: '测试连接',
    testing: '连接测试中...',
    usernameOrEmail: '用户名或邮箱',
    password: '密码',
    signIn: '登录',
    signingIn: '登录中...',
    desktopClientLoginSucceeded: '桌面端登录成功。',
    unableToReachService: '无法连接到 Detachym 服务。',
    loginFailed: '登录失败。',
    serverConnectionVerified: '服务连接验证成功。',
    startingDesktopClient: '正在启动桌面客户端...',
    waitingResponse: '正在等待回复...',
    latestResponseReceived: '已收到最新回复。',
    messageDeliveryFailed: '消息发送失败。',
    unableToLoadSession: '无法加载当前会话。',
    documentUploadedIndexed: '文档已上传并完成索引。',
    uploadFailed: '上传失败。',
    documentDeleted: '文档已删除。',
    deleteFailed: '删除失败。',
    signedOut: '已退出登录。',
    updateServerUrlHint: '请修改服务地址后重新登录。',
    desktopMainPanel: '桌宠控制台',
    welcomeUser: '欢迎你，{username}',
    serverLabel: '服务地址：{server}',
    chat: '聊天',
    knowledgeBase: '知识库',
    changeServer: '修改服务地址',
    signOut: '退出登录',
    sessions: '会话列表',
    currentSession: '当前会话',
    newSession: '新会话',
    enableKnowledgeBase: '启用知识库',
    noSessionYet: '还没有会话，发送第一条消息后会自动创建。',
    desktopPanelIntro: '这里已连接到云端服务。你可以直接向 {pet} 提问，也可以按需启用私有知识库。',
    typeMessagePlaceholder: '输入想发送给 {pet} 的内容...',
    sendMessage: '发送消息',
    sending: '发送中...',
    manageDocuments: '管理文档',
    uploadDocument: '上传文档',
    noDocumentYet: '还没有上传任何文档。',
    delete: '删除',
    documentMeta: '{status} | {count} 个分块 | {size} KB',
    quickChat: '快捷聊天',
    desktopQuickChat: '{pet} 快捷聊天',
    startingQuickChat: '正在启动快捷聊天...',
    quickChatSetupText: '请先打开主面板，配置服务地址并登录云端账号后再使用快捷聊天。',
    openMainPanel: '打开主面板',
    quickChatEmpty: '点一下 {pet}，然后在这里快速提问，回复会带上当前桌宠的语气风格。',
    quickChatPlaceholder: '输入想发送给 {pet} 的内容...',
    send: '发送',
    dragWindowHint: '按住顶部可拖动窗口',
    enterToSendHint: '按 Enter 发送，Shift + Enter 换行',
    petCat: '猫咪',
    petDog: '小狗',
    petPig: '小猪',
    desktopPetAlt: '{pet} 桌宠',
    quickChatOpened: '快捷聊天已打开。',
    quickChatClosed: '快捷聊天已收起。',
    mainPanelOpened: '主面板已打开。',
    signInHint: '请先登录云端账号，再使用桌宠交互。',
    dragSaved: '桌宠位置已更新。',
    quickChatDisabledHint: '你已关闭单击打开快捷聊天。',
    interactionHint: '单击互动并切换快捷聊天，双击打开主面板，拖动可移动位置。',
    petSelection: '桌宠形象',
    petSelectionHint: '点击即可切换桌宠，气泡文案、快捷聊天语气和主面板形象会一起变化。',
    petPreferenceSaved: '桌宠偏好已同步。',
    petCatIdleMessages: [
      '我已经就位了，今天也要保持利落。',
      '把我放在顺手的位置，我会安静陪着你。',
      '点我试试，我会给你更干脆的反馈。',
    ],
    petDogIdleMessages: [
      '我在这里待命，有事就喊我。',
      '今天也一起把进度往前推。',
      '点我一下，我会立刻回应你。',
    ],
    petPigIdleMessages: [
      '别急，我们慢慢来。',
      '今天也适合用更放松的节奏工作。',
      '想聊天的时候点我一下就好。',
    ],
    petCatTapMessages: [
      '状态切到利落模式了，来吧。',
      '收到，我会用更干净的方式回答。',
      '这次我会更敏捷一点。',
    ],
    petDogTapMessages: [
      '我在，马上帮你接住这个问题。',
      '好，进入陪伴模式。',
      '收到指令，开始响应。',
    ],
    petPigTapMessages: [
      '我在，先把这件事慢慢讲清楚。',
      '别急，我会柔和一点陪你聊。',
      '好，换个更轻松的状态继续。',
    ],
    petCatPanelMessages: [
      '主面板已经替你打开了。',
      '更完整的设置都在主面板里。',
    ],
    petDogPanelMessages: [
      '主面板已经打开，我陪你继续。',
      '走，我们去主面板里处理。',
    ],
    petPigPanelMessages: [
      '主面板开好了，慢慢看。',
      '已经切到主面板，我们从容一点。',
    ],
    petSadMessages: [
      '我还没有连上你的账号。',
      '先登录之后，我才能同步偏好和聊天人格。',
      '现在我只能先陪你待机。',
    ],
  },
  en: {
    appName: 'Detachym',
    language: 'Language',
    languageChinese: 'Simplified Chinese',
    languageEnglish: 'English',
    desktopAccess: 'Desktop Access',
    desktopTitle: 'Detachym Desktop',
    desktopIntro: 'Set the server address first, then sign in to use chat, knowledge base tools, and pet sync.',
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
    desktopPanelIntro: 'This panel connects to the cloud API. Ask questions here and enable your private knowledge base when needed.',
    typeMessagePlaceholder: 'Type a message for {pet}...',
    sendMessage: 'Send Message',
    sending: 'Sending...',
    manageDocuments: 'Manage Documents',
    uploadDocument: 'Upload Document',
    noDocumentYet: 'No document uploaded yet.',
    delete: 'Delete',
    documentMeta: '{status} | {count} chunks | {size} KB',
    quickChat: 'Quick Chat',
    desktopQuickChat: '{pet} Quick Chat',
    startingQuickChat: 'Starting quick chat...',
    quickChatSetupText: 'Open the main panel first, configure the server URL, and sign in before using quick chat.',
    openMainPanel: 'Open Main Panel',
    quickChatEmpty: 'Click {pet} and ask here. Replies will follow the current pet persona.',
    quickChatPlaceholder: 'Type a message for {pet}...',
    send: 'Send',
    dragWindowHint: 'Drag the top bar to move this window',
    enterToSendHint: 'Press Enter to send, Shift + Enter for a new line',
    petCat: 'Cat',
    petDog: 'Dog',
    petPig: 'Pig',
    desktopPetAlt: '{pet} desktop pet',
    quickChatOpened: 'Quick chat is open.',
    quickChatClosed: 'Quick chat is hidden.',
    mainPanelOpened: 'Main panel is open.',
    signInHint: 'Sign in to your cloud account before using pet interactions.',
    dragSaved: 'Position updated.',
    quickChatDisabledHint: 'Single-click quick chat is disabled.',
    interactionHint: 'Single click interacts and toggles quick chat, double click opens the main panel, drag to move.',
    petSelection: 'Pet Persona',
    petSelectionHint: 'Click to switch the desktop pet. Bubble style and quick chat tone will update together.',
    petPreferenceSaved: 'Pet preference synced.',
    petCatIdleMessages: [
      'I am in position and ready.',
      'Keep me nearby and I will stay sharp.',
      'Tap me and I will respond cleanly.',
    ],
    petDogIdleMessages: [
      'I am here and ready to help.',
      'Let us keep the work moving.',
      'Tap me and I will jump in.',
    ],
    petPigIdleMessages: [
      'No rush, we can take this calmly.',
      'A softer rhythm is fine too.',
      'Tap me whenever you want to talk.',
    ],
    petCatTapMessages: [
      'Switching into a sharper mode.',
      'Got it. I will answer cleanly.',
      'That landed. Keep going.',
    ],
    petDogTapMessages: [
      'I am on it.',
      'Okay, companion mode activated.',
      'Got your signal. Responding now.',
    ],
    petPigTapMessages: [
      'I am here. Let us slow it down a little.',
      'Okay, softer mode now.',
      'We can handle this gently.',
    ],
    petCatPanelMessages: [
      'The main panel is open.',
      'The full controls are in the main panel.',
    ],
    petDogPanelMessages: [
      'Main panel opened. Let us keep going.',
      'We are in the main panel now.',
    ],
    petPigPanelMessages: [
      'Main panel opened. Take your time.',
      'We have moved into the main panel.',
    ],
    petSadMessages: [
      'I am not connected to your account yet.',
      'Sign in first so I can sync your preferences.',
      'For now I can only idle with you.',
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

export function getPetMessagePool(language, petType, variant) {
  const normalizedPetType = String(petType || 'cat').trim().toLowerCase()
  const capitalizedPetType = normalizedPetType.charAt(0).toUpperCase() + normalizedPetType.slice(1)
  return getMessagePool(language, `pet${capitalizedPetType}${variant}`)
}

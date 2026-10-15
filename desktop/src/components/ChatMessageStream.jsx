import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'

import { isChatScrollNearBottom, shouldFollowChatUpdate } from '../shared/chat-input'

export function ChatMessageStream({ messages, conversation, emptyMessage, language, busy, showStarters = false, onChooseStarter }) {
  const streamRef = useRef(null)
  const followingRef = useRef(true)
  const previousRef = useRef({ conversation: null, version: null })
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const lastMessage = messages[messages.length - 1]
  const version = JSON.stringify([messages.length, lastMessage?.role, lastMessage?.content])
  const starters = language === 'zh-CN' ? [
    { label: '理一理今天', prompt: '陪我理一理，今天最想完成的一件小事。' },
    { label: '想歇一会儿', prompt: '我有点累了，陪我歇一会儿吧。' },
    { label: '找一点小期待', prompt: '帮我想一件今天可以期待的小事。' },
  ] : [
    { label: 'One small step', prompt: 'Help me choose one small thing to do today.' },
    { label: 'A moment to rest', prompt: 'I feel a little tired. Keep me company for a moment.' },
    { label: 'Something to look forward to', prompt: 'Help me think of one small thing to look forward to today.' },
  ]

  const scrollToLatest = () => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
    followingRef.current = true
    setHasNewMessages(false)
  }

  useLayoutEffect(() => {
    const previous = previousRef.current
    if (version === previous.version && conversation === previous.conversation) return
    if (shouldFollowChatUpdate({
      following: followingRef.current,
      previousConversation: previous.conversation,
      conversation,
    })) {
      scrollToLatest()
    } else {
      setHasNewMessages(true)
    }
    previousRef.current = { conversation, version }
  }, [conversation, version])

  useLayoutEffect(() => {
    const stream = streamRef.current
    if (!stream || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      if (followingRef.current) stream.scrollTop = stream.scrollHeight
    })
    observer.observe(stream)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="main-chat-feed">
      <div
        className="chat-stream main-chat-stream"
        ref={streamRef}
        role="log"
        aria-label={language === 'zh-CN' ? '聊天记录' : 'Conversation messages'}
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={busy}
        tabIndex={0}
        onScroll={() => {
          followingRef.current = isChatScrollNearBottom(streamRef.current)
          if (followingRef.current) setHasNewMessages(false)
        }}
      >
        {messages.length === 0 && <div className="message assistant">{emptyMessage}</div>}
        {messages.length === 0 && showStarters && (
          <div className="main-chat-starters" role="group" aria-label={language === 'zh-CN' ? '从一句话开始' : 'Start with a little thought'} data-e2e="chat-starters">
            <p>{language === 'zh-CN' ? '不知道从哪句开始？选一句，再慢慢改。' : 'Not sure where to begin? Pick a thought and make it yours.'}</p>
            <div>{starters.map((starter, index) => (
              <button key={starter.label} type="button" disabled={busy} data-e2e={`chat-starter-${index}`} onClick={() => onChooseStarter?.(starter.prompt)}>{starter.label}</button>
            ))}</div>
            <small>{language === 'zh-CN' ? '只填入输入框，准备好了再发送。' : 'This fills your draft. Send it when you are ready.'}</small>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`message ${message.role}`}>
            {message.content}
          </div>
        ))}
      </div>
      {hasNewMessages && (
        <button type="button" className="main-new-messages" onClick={scrollToLatest}>
          <ArrowDown size={14} aria-hidden="true" />
          {language === 'zh-CN' ? '有新消息，回到底部' : 'New messages · jump to latest'}
        </button>
      )}
    </div>
  )
}

/**
 * OneBot 11 client for NapCat (QQ protocol side).
 *
 * Only plain HTTP: no websockets means no dependencies. NapCat exposes the
 * standard action names (`send_private_msg`, `get_recent_contact`, `get_msg`…).
 * If no protocol side is running, every call throws and the caller degrades
 * silently (QQ is an optional channel, never a hard dependency).
 */

export const EXTRACT_TEXT = (message) => {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message
    .filter((segment) => segment && segment.type === 'text' && segment.data)
    .map((segment) => String(segment.data.text ?? ''))
    .join('')
}

export const createQqClient = ({ baseUrl = 'http://127.0.0.1:3000', token = '', timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) => {
  const base = String(baseUrl).replace(/\/+$/, '')
  const call = async (action, params = {}) => {
    const res = await fetchImpl(`${base}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`qq ${action}: HTTP ${res.status}`)
    const json = await res.json()
    if (json?.status === 'failed' || (json?.retcode !== undefined && json.retcode !== 0)) {
      throw new Error(`qq ${action}: ${json?.message ?? json?.wording ?? 'failed'}`)
    }
    return json?.data ?? json
  }

  return {
    call,
    loginInfo: () => call('get_login_info'),
    sendPrivate: (userId, text) => call('send_private_msg', { user_id: Number(userId), message: String(text) }),
    sendGroup: (groupId, text) => call('send_group_msg', { group_id: Number(groupId), message: String(text) }),
    recentContacts: (count = 20) => call('get_recent_contact', { count }),
    getMsg: (messageId) => call('get_msg', { message_id: messageId }),
  }
}

/** Turn a `get_recent_contact` payload into [{userId, messageId, time, text}]. */
export const parseRecentContacts = (data) => {
  const list = Array.isArray(data) ? data : data?.contacts ?? data?.list ?? []
  return list
    .map((item) => {
      const userId = item?.peerUin ?? item?.user_id ?? item?.uin
      const last = item?.lastestMsg ?? item?.lastest_msg ?? item?.lastMsg ?? item?.last_msg ?? null
      const messageId = last?.msgId ?? last?.message_id ?? last?.msgSeq ?? null
      const text = EXTRACT_TEXT(last?.elements ?? last?.message ?? last?.content ?? '')
      return {
        userId: userId !== undefined && userId !== null ? String(userId) : null,
        messageId: messageId !== undefined && messageId !== null ? String(messageId) : null,
        time: Number(last?.msgTime ?? last?.time ?? item?.lastTime ?? 0) || 0,
        text,
      }
    })
    .filter((entry) => entry.userId)
}

/** Build the echo-friendly text a brain reply should carry. */
export const formatQqReply = ({ line, label }) => {
  const text = String(line ?? '').trim()
  if (text.length === 0) return ''
  const suffix = label ? `（心情：${label}）` : ''
  return `${text}${suffix}`.slice(0, 300)
}

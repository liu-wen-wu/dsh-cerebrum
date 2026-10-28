/**
 * Client bundle for dsh-cerebrum: a brain-status dock chip above the composer,
 * with an expandable dashboard. Pure hand-written bundle (no build step):
 * window.__ModuleLoader__.load() + require("react"), exactly the protocol used
 * by bundled DSH client plugins.
 *
 * The dashboard is a floating panel: drag it by the title bar, or pin it into
 * a fixed strip. Data comes from the host's read-only loopback API (lib/api.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-cerebrum',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var useState = react.useState
    var useEffect = react.useEffect
    var useRef = react.useRef
    var createElement = react.createElement

    var PORTS = Array.from({ length: 10 }, function (_, i) { return 18734 + i })
    var activePort = 0
    var POLL_MS = 5000

    // Probe the standard port first; if another app owns it, walk the range.
    // Optional shared secret: set `config.api.token` and `localStorage['cerebrum.token']`.
    var get = function (path) {
      var token = null
      try {
        token = localStorage.getItem('cerebrum.token')
      } catch (err) {}
      var init = token ? { headers: { 'x-cerebrum-token': token } } : undefined
      var attempt = function (index) {
        return fetch('http://127.0.0.1:' + PORTS[index] + path, init)
          .then(function (r) {
            if (!r.ok) return null
            activePort = index
            return r.json()
          })
          .catch(function () {
            if (index + 1 < PORTS.length) return attempt(index + 1)
            return null
          })
      }
      return attempt(activePort)
    }

    var BAR_BLOCKS = 6
    var bar = function (label, value) {
      var v = Math.max(0, Math.min(1, Number(value) || 0))
      var filled = Math.round(v * BAR_BLOCKS)
      return createElement(
        'span',
        { style: { marginLeft: '8px', whiteSpace: 'nowrap' } },
        createElement('span', { style: { color: '#7d8ea3' } }, label + ' '),
        createElement('span', { style: { color: '#5ec8f2', letterSpacing: '1px' } },
          '█'.repeat(filled) + '░'.repeat(BAR_BLOCKS - filled) + ' ' + (v * 100).toFixed(0) + '%'),
      )
    }

    var row = function (label, children, hint) {
      return createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', padding: '3px 0' } },
        createElement('span', { style: { color: '#7d8ea3', flexShrink: 0, cursor: hint ? 'help' : 'default' }, title: hint || '' }, label),
        createElement('span', { style: { textAlign: 'right', minWidth: 0 } }, children))
    }

    var PAD_HINT = 'PAD 三维情绪：P 愉悦（效价）· A 唤醒（激活度）· D 支配（可控感）。都由评价产生，也影响记忆与判断。'
    var DA_HINT = 'DA 多巴胺（奖赏/动机）· 5-HT 血清素（稳定/耐心）。成功、夸奖会抬 DA；冲突、挫败会抬 NE。'
    var NE_HINT = 'NE 去甲肾上腺素（警觉/压力）· ACh 乙酰胆碱（学习率/注意）。数值是相对基线 0..1 的激活水平。'

    function BrainChip(props) {
      var sessionId = props.sessionId
      var [state, setState] = useState(null)
      var [open, setOpen] = useState(false)
      var [pinned, setPinned] = useState(false)
      var [pos, setPos] = useState(function () {
        try {
          var raw = localStorage.getItem('cerebrum.pos')
          return raw ? JSON.parse(raw) : null
        } catch (err) {
          return null
        }
      })
      var [uiEnabled, setUiEnabled] = useState(true)
      var [hidden, setHidden] = useState(function () {
        try {
          return localStorage.getItem('cerebrum.hidden') === '1'
        } catch (err) {
          return false
        }
      })
      var [miniPos, setMiniPos] = useState(function () {
        try {
          var raw = localStorage.getItem('cerebrum.miniPos')
          return raw ? JSON.parse(raw) : null
        } catch (err) {
          return null
        }
      })
      var panelRef = useRef(null)
      var dragRef = useRef(null)
      var petRef = useRef({ key: '', at: 0 })
      var uiRef = useRef({ enabled: true, drivePet: true })

      useEffect(function () {
        var alive = true
        // The host decides whether users opted out of the whole chip.
        get('/ui').then(function (data) {
          if (data) {
            uiRef.current = { enabled: data.enabled !== false, drivePet: data.drivePet !== false }
            if (!alive) return
            if (data.enabled === false) setUiEnabled(false)
          }
        })

        /**
         * Built-in pet bridge: no setup required. When a dsh-pet instance is
         * detected on this origin, emotion changes are pushed to it as a
         * locked "performance" (bubble line), then the lock is released.
         */
        var drivePet = function (hints) {
          if (uiRef.current.drivePet === false) return
          var key = (hints.emotionKey || '') + '|' + (hints.line || '')
          var now = Date.now()
          if (petRef.current.key === key) return
          if (now - petRef.current.at < 20000) return
          if ((hints.intensity || 0) < 0.25) return
          petRef.current.key = key
          petRef.current.at = now
          fetch('/dsh-pet-7340/state')
            .then(function (r) { return r.ok ? r.json() : null })
            .then(function (st) {
              // /state.pets lists live web-side instances only; when the pet is
              // configured desktop-only the id still resolves from config ("main").
              var id = (st && st.pets && Object.keys(st.pets)[0]) || 'main'
              var attempt = function (surface) {
                var q = '?pet=' + encodeURIComponent(id) + '&surface=' + surface
                return fetch('/dsh-pet-7340/lock' + q, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ttl: 8000, surface: surface }),
                })
                  .then(function (r) { return r.json() })
                  .then(function (lock) {
                    if (!lock || lock.ok === false || !lock.lockId) {
                      if (surface === 'web') return attempt('desktop')
                      return
                    }
                    var lq = q + '&lock=' + encodeURIComponent(lock.lockId)
                    return fetch('/dsh-pet-7340/broadcast' + lq, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text: hints.line, duration: 6000 }),
                    })
                      .catch(function () {})
                      .then(function () {
                        return fetch('/dsh-pet-7340/lock/release' + q, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ lockId: lock.lockId }),
                        }).catch(function () {})
                      })
                  })
              }
              return attempt('web')
            })
            .catch(function () {})
        }

        var lastState = null
        var loadWeights = function () {
          try {
            return JSON.parse(localStorage.getItem('cerebrum.petWeights') || '{}')
          } catch (err) {
            return {}
          }
        }
        var autonomy = { lastActAt: 0, lastAsset: null, actedAt: 0, turnSum: -1, weights: loadWeights() }
        var saveWeights = function () {
          try {
            localStorage.setItem('cerebrum.petWeights', JSON.stringify(autonomy.weights))
          } catch (err) {}
        }
        var learnAsset = function (id, success) {
          var w = Number(autonomy.weights[id] ?? 0.5)
          autonomy.weights[id] = Math.max(0.05, Math.min(1, w + (success ? 0.12 : -0.08)))
          saveWeights()
        }
        var weightedPick = function (assets) {
          var total = 0
          for (var i = 0; i < assets.length; i++) total += Math.max(0.05, Number(autonomy.weights[assets[i].id] ?? assets[i].weight ?? 0.5))
          var roll = Math.random() * total
          for (var j = 0; j < assets.length; j++) {
            roll -= Math.max(0.05, Number(autonomy.weights[assets[j].id] ?? assets[j].weight ?? 0.5))
            if (roll <= 0) return assets[j]
          }
          return assets[assets.length - 1]
        }

        /**
         * Autonomy: high internal urgency (strong emotion + user silence + DA)
         * lets the pet act on its own — play a registered expression, then learn
         * from whether the user reacted within two minutes.
         */
        var maybeAutonomy = function (hints, state) {
          try {
            var stored = localStorage.getItem('cerebrum.autonomy')
            if (stored === '0') uiRef.current.autonomy = false
            else if (stored === '1') uiRef.current.autonomy = true
          } catch (err) {}
          if (uiRef.current.autonomy === false || !state) return
          var now = Date.now()
          var st = autonomy
          if (state.turnMemory) {
            var sum = (state.turnMemory.read || []).length + (state.turnMemory.wrote || []).length
            if (st.lastAsset && sum !== st.turnSum) {
              learnAsset(st.lastAsset, true)
              st.lastAsset = null
            } else if (st.lastAsset && now - st.actedAt > 120e3) {
              learnAsset(st.lastAsset, false)
              st.lastAsset = null
            }
          }
          if (now - st.lastActAt < 90e3) return
          var intensity = Number(hints.intensity) || 0
          var lastAt = state.segmentation && state.segmentation.lastAt ? state.segmentation.lastAt : now
          var silence = Math.min(1, (now - lastAt) / (5 * 60e3))
          var da = state.neuromods && state.neuromods.da ? state.neuromods.da : 0.5
          var urgency = 0.45 * intensity + 0.25 * silence + 0.2 * (da - 0.5) * 2 + 0.1 * Math.random()
          if (urgency < 0.55) return
          st.lastActAt = now
          fetch('/pet-assets?emotion=' + encodeURIComponent(hints.emotionKey || 'calm'))
            .then(function (r) { return r.ok ? r.json() : null })
            .then(function (data) {
              var assets = (data && data.assets) || []
              if (assets.length === 0) return
              var asset = weightedPick(assets)
              return fetch('/dsh-pet-7340/state').then(function (r) { return r.ok ? r.json() : null }).then(function (pst) {
                var id = (pst && pst.pets && Object.keys(pst.pets)[0]) || 'main'
                var surface = 'desktop'
                var q = '?pet=' + encodeURIComponent(id) + '&surface=' + surface
                return fetch('/dsh-pet-7340/lock' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 9000, surface: surface }) })
                  .then(function (r) { return r.json() })
                  .then(function (lock) {
                    if (!lock || !lock.lockId) return
                    var lq = q + '&lock=' + encodeURIComponent(lock.lockId)
                    st.lastAsset = asset.id
                    st.actedAt = Date.now()
                    st.turnSum = state.turnMemory ? (state.turnMemory.read || []).length + (state.turnMemory.wrote || []).length : -1
                    return fetch('/dsh-pet-7340/anim' + lq, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ url: asset.publicUrl, facing: Math.random() < 0.5 ? 'left' : 'right' }),
                    })
                      .catch(function () {})
                      .then(function () {
                        return fetch('/dsh-pet-7340/lock/release' + q, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ lockId: lock.lockId }),
                        }).catch(function () {})
                      })
                  })
              })
            })
            .catch(function () {})
        }

        // ---- dsh-pet right-click menu: a "cerebrum" group -----------------
        var MENU_LABELS = ['🧠 打开面板', '🪄 自主模式', '💗 摸摸头', '🍙 喂食', '✨ 夸夸', '📊 播报状态', '🙈 隐藏芯片']
        var menuState = { registered: false, lastPoll: 0, lastRegisterAt: 0 }
        var registerMenu = function (force) {
          // The host owns the pet menu (survives page staleness); opt in here only
          // when the host-side menu is disabled.
          if (uiRef.current.petMenuClient !== true) return
          if (uiRef.current.petMenu === false) return
          var now = Date.now()
          // Re-register periodically: dsh-pet keeps menu items in process memory and
          // a helper restart would silently drop them.
          if (!force && menuState.registered && now - menuState.lastRegisterAt < 5 * 60e3) return
          menuState.registered = true
          menuState.lastRegisterAt = now
          fetch('/dsh-pet-7340/menu/item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner: 'cerebrum', labels: MENU_LABELS, target: 'both' }),
          }).catch(function () {})
        }
        var interactWith = function (kind) {
          fetch('http://127.0.0.1:' + PORTS[activePort] + '/interact?kind=' + encodeURIComponent(kind)).catch(function () {})
        }
        var sayInBubble = function (state, text) {
          fetch('/dsh-pet-7340/state')
            .then(function (r) { return r.ok ? r.json() : null })
            .then(function (pst) {
              var id = (pst && pst.pets && Object.keys(pst.pets)[0]) || 'main'
              var q = '?pet=' + encodeURIComponent(id) + '&surface=desktop'
              return fetch('/dsh-pet-7340/lock' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 8000, surface: 'desktop' }) })
                .then(function (r) { return r.json() })
                .then(function (lock) {
                  if (!lock || !lock.lockId) return
                  return fetch('/dsh-pet-7340/broadcast' + q + '&lock=' + encodeURIComponent(lock.lockId), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: String(text).slice(0, 120), duration: 6000 }),
                  })
                    .catch(function () {})
                    .then(function () {
                      return fetch('/dsh-pet-7340/lock/release' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lockId: lock.lockId }) }).catch(function () {})
                    })
                })
            })
            .catch(function () {})
        }
        var handleMenu = function (events, state) {
          if (!events) return
          if (events['🧠 打开面板']) setOpen(true)
          if (events['🙈 隐藏芯片']) hideChip()
          if (events['🪄 自主模式']) {
            var off = (uiRef.current.autonomy !== false)
            uiRef.current.autonomy = !off
            try {
              localStorage.setItem('cerebrum.autonomy', off ? '0' : '1')
            } catch (err) {}
            sayInBubble(state, off ? '自主模式：关（我乖乖待着）' : '自主模式：开（我会自己找事做）')
          }
          if (events['💗 摸摸头']) interactWith('pet')
          if (events['🍙 喂食']) interactWith('feed')
          if (events['✨ 夸夸']) interactWith('praise')
          if (events['📊 播报状态']) {
            var summary = state
              ? `情绪 ${state.affect.emotion.label} · 记忆 ${state.memory.episodes} 条 · 技能 ${state.skillCount ?? 0} · 好感 ${state.affinity ? state.affinity.level : '—'}`
              : '大脑状态暂时读不到'
            sayInBubble(state, summary)
          }
        }
        var pollMenu = function (state) {
          if (!menuState.registered) return
          var now = Date.now()
          if (now - menuState.lastPoll < 6000) return
          menuState.lastPoll = now
          fetch('/dsh-pet-7340/menu/events?owner=cerebrum&wait=0')
            .then(function (r) { return r.ok ? r.json() : null })
            .then(function (events) { if (events) handleMenu(events, state) })
            .catch(function () {})
        }

        var tick = function () {
          var qs = sessionId ? '?session=' + encodeURIComponent(sessionId) : ''
          get('/state' + qs).then(function (data) {
            if (alive && data) setState(data)
            if (alive && data) lastState = data
          })
          get('/render-hints' + qs).then(function (hints) {
            if (!alive || !hints) return
            drivePet(hints)
            maybeAutonomy(hints, lastState)
            registerMenu()
            pollMenu(lastState)
          })
        }
        tick()
        var timer = setInterval(tick, POLL_MS)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

      var hideChip = function () {
        setHidden(true)
        try {
          localStorage.setItem('cerebrum.hidden', '1')
        } catch (err) {}
      }

      var restoreChip = function () {
        setHidden(false)
        try {
          localStorage.removeItem('cerebrum.hidden')
        } catch (err) {}
      }

      var startMiniDrag = function (event) {
        var rect = event.currentTarget.getBoundingClientRect()
        var start = { mx: event.clientX, my: event.clientY, x: rect.left, y: rect.top, moved: 0 }
        var latest = null
        var move = function (ev) {
          var dx = ev.clientX - start.mx
          var dy = ev.clientY - start.my
          start.moved = Math.max(start.moved, Math.abs(dx) + Math.abs(dy))
          latest = {
            x: Math.max(4, Math.min(window.innerWidth - 30, start.x + dx)),
            y: Math.max(4, Math.min(window.innerHeight - 30, start.y + dy)),
          }
          setMiniPos(latest)
        }
        var up = function () {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          if (latest) {
            try {
              localStorage.setItem('cerebrum.miniPos', JSON.stringify(latest))
            } catch (err) {}
          }
          if (start.moved < 4) restoreChip()
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        event.preventDefault()
      }

      if (!uiEnabled) return null
      if (hidden) {
        var miniStyle = {
          position: 'fixed',
          zIndex: 1001,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '24px',
          height: '24px',
          borderRadius: '999px',
          background: 'rgba(16,26,40,.85)',
          border: '1px solid #1f2c3f',
          cursor: 'grab',
          fontSize: '13px',
          userSelect: 'none',
          opacity: 0.75,
          boxShadow: '0 2px 10px rgba(0,0,0,.35)',
        }
        if (miniPos) {
          miniStyle.left = miniPos.x + 'px'
          miniStyle.top = miniPos.y + 'px'
        } else {
          miniStyle.right = '16px'
          miniStyle.bottom = '96px'
        }
        return createElement('span', {
          style: miniStyle,
          title: '拖动可移动；单击恢复大脑芯片（config.ui.enabled=false 可彻底关闭）',
          onMouseDown: startMiniDrag,
        }, '🧠')
      }

      var chipStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 12px',
        borderRadius: '999px',
        border: '1px solid #1f2c3f',
        background: '#101a28',
        color: '#dbe4ee',
        fontSize: '12px',
        cursor: 'pointer',
        userSelect: 'none',
      }

      if (!state) {
        return createElement('div', { style: chipStyle, title: 'cerebrum 未连接（宿主未启动或端口被占用）' }, '🧠 未连接')
      }

      var affect = state.affect || {}
      var memory = state.memory || {}
      var chip = createElement(
        'div',
        { style: chipStyle, onClick: function () { setOpen(!open) }, title: '点击展开大脑仪表盘' },
        createElement('span', null, '🧠'),
        createElement('span', null, affect.emotion ? affect.emotion.label : '平静'),
        createElement('span', { style: { color: '#7d8ea3' } }, '记 ' + (memory.episodes || 0)),
        createElement('span', { style: { color: '#5ec8f2' } }, '♥ ' + ((state.affinity && state.affinity.level) || '初见')),
      )

      if (!open) return chip

      var startDrag = function (event) {
        if (pinned) return
        if (event.target && event.target.getAttribute && event.target.getAttribute('data-no-drag') === '1') return
        var rect = panelRef.current ? panelRef.current.getBoundingClientRect() : { left: 0, top: 0 }
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
        var latest = null
        var move = function (ev) {
          latest = { x: Math.max(8, ev.clientX - dragRef.current.dx), y: Math.max(8, ev.clientY - dragRef.current.dy) }
          setPos(latest)
        }
        var up = function () {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          if (latest) {
            try {
              localStorage.setItem('cerebrum.pos', JSON.stringify(latest))
            } catch (err) {}
          }
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        event.preventDefault()
      }

      var floating = {
        position: 'fixed',
        bottom: '96px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        width: 'min(430px, calc(100vw - 32px))',
        maxHeight: '60vh',
        overflowY: 'auto',
      }
      if (pos) {
        floating = {
          position: 'fixed',
          left: pos.x + 'px',
          top: pos.y + 'px',
          zIndex: 1000,
          width: 'min(430px, calc(100vw - 32px))',
          maxHeight: '60vh',
          overflowY: 'auto',
        }
      }
      var pinnedStyle = {
        position: 'static',
        width: '100%',
        maxHeight: '45vh',
        overflowY: 'auto',
      }
      var panelStyle = Object.assign({}, pinned ? pinnedStyle : floating, {
        padding: '0',
        borderRadius: '12px',
        border: '1px solid #1f2c3f',
        background: '#0d1420',
        color: '#dbe4ee',
        fontSize: '12px',
        lineHeight: '1.7',
        boxShadow: '0 8px 32px rgba(0,0,0,.5)',
      })

      var traits = state.personality ? state.personality.traits : {}
      var neuro = state.neuromods || {}
      var headerStyle = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid #1f2c3f',
        cursor: pinned ? 'default' : 'move',
        background: '#101a28',
        borderRadius: '12px 12px 0 0',
        userSelect: 'none',
      }
      var btnStyle = { cursor: 'pointer', color: '#7d8ea3', padding: '0 4px', fontSize: '13px', border: 'none', background: 'none' }

      var body = createElement('div', { style: { padding: '10px 14px 12px' } },
        row('人格', createElement('span', null, state.personality ? state.personality.label : '—')),
        row('五因素', createElement('span', null,
          'O' + traits.openness + ' C' + traits.conscientiousness + ' E' + traits.extraversion + ' A' + traits.agreeableness + ' N' + traits.neuroticism)),
        row('情绪', createElement('span', null, (affect.emotion ? affect.emotion.label : '—') + '（' + ((affect.emotion && affect.emotion.intensity) || 0).toFixed(2) + '）')),
        row('PAD', createElement('span', null,
          bar('P', (affect.valence + 1) / 2),
          bar('A', affect.arousal),
          bar('D', (affect.dominance + 1) / 2)), PAD_HINT),
        row('DA/5-HT', createElement('span', null,
          bar('DA', neuro.da),
          bar('5HT', neuro.ser)), DA_HINT),
        row('NE/ACh', createElement('span', null,
          bar('NE', neuro.ne),
          bar('ACh', neuro.ach)), NE_HINT),
        row('记忆', createElement('span', null,
          (memory.episodes || 0) + ' 情景 · ' + (memory.concepts || 0) + ' 概念 · ' + (memory.permastore || 0) + ' 永久候选')),
        row('技能/意图', createElement('span', null,
          (state.skillCount || 0) + ' 条 · 待办 ' + ((state.intentions && state.intentions.active) || 0))),
        row('好感', createElement('span', null, ((state.affinity && state.affinity.level) || '初见') + '（正性 ' + Math.round(((state.affinity && state.affinity.positiveShare) || 0.5) * 100) + '%）')),
        row('工作记忆', createElement('span', null, (state.workingMemory || []).map(function (s) { return s.summary }).join(' ｜ ').slice(0, 80) || '—')),
        createElement('div', { style: { color: '#7d8ea3', marginTop: '8px', fontSize: '11px' } },
          '数据来自本机 127.0.0.1 只读 API；修改请用 cerebrum_* 工具。'),
      )

      var header = createElement('div', { style: headerStyle, onMouseDown: startDrag },
        createElement('span', { style: { fontWeight: 700 } }, '🧠 大脑仪表盘'),
        createElement('span', null,
          createElement('button', { type: 'button', style: btnStyle, title: pinned ? '取消固定（恢复浮动）' : '固定到输入栏上方', 'data-no-drag': '1', onClick: function () { setPinned(!pinned) } }, pinned ? '📌 已固定' : '📌 固定'),
          createElement('button', { type: 'button', style: btnStyle, title: '隐藏大脑芯片（点小 🧠 恢复）', 'data-no-drag': '1', onClick: hideChip }, '🙈'),
          createElement('button', { type: 'button', style: btnStyle, title: '收起', 'data-no-drag': '1', onClick: function () { setOpen(false) } }, '✕'),
        ))

      var panel = createElement('div', { ref: panelRef, style: panelStyle }, header, body)
      return createElement('div', { style: pinned ? { width: '100%' } : { position: 'relative' } }, chip, panel)
    }

    var inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'cerebrum',
          order: 20,
          inject: function (sessionId) {
            return { sessionId: sessionId }
          },
        }, BrainChip)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

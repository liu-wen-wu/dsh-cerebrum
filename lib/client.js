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

    var PORTS = [18734, 18735, 18736, 18737]
    var activePort = 0
    var POLL_MS = 5000

    // Probe the standard port first; if another app owns it, walk the range.
    var get = function (path) {
      var attempt = function (index) {
        return fetch('http://127.0.0.1:' + PORTS[index] + path)
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
      var [pos, setPos] = useState(null)
      var panelRef = useRef(null)
      var dragRef = useRef(null)

      useEffect(function () {
        var alive = true
        var tick = function () {
          get('/state' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : '')).then(function (data) {
            if (alive && data) setState(data)
          })
        }
        tick()
        var timer = setInterval(tick, POLL_MS)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

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
        var move = function (ev) {
          setPos({ x: Math.max(8, ev.clientX - dragRef.current.dx), y: Math.max(8, ev.clientY - dragRef.current.dy) })
        }
        var up = function () {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
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
          'O' + traits.openness + ' C' + traits.conscientiousness + ' E' + traits.extraversion + ' A' + traits.agreeableness + ' N' + traits.neuroticism),
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

/**
 * Client bundle for dsh-cerebrum: a brain-status dock chip above the composer,
 * with an expandable dashboard. Pure hand-written bundle (no build step):
 * window.__ModuleLoader__.load() + require("react"), exactly the protocol used
 * by bundled DSH client plugins.
 *
 * Data comes from the host's read-only loopback API (lib/api.js). All mutations
 * stay on the model side — the UI only renders what the brain reports.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cerebrum',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var useState = react.useState
    var useEffect = react.useEffect
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

    var bar = function (value) {
      var v = Math.max(0, Math.min(1, value))
      return createElement(
        'span',
        { style: { color: '#7d8ea3', letterSpacing: '1px' } },
        '█'.repeat(Math.round(v * 8)) + '░'.repeat(8 - Math.round(v * 8)) + ' ' + (v * 100).toFixed(0) + '%',
      )
    }

    var row = function (label, children) {
      return createElement('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '3px 0' } },
        createElement('span', { style: { color: '#7d8ea3' } }, label), children)
    }

    function BrainChip(props) {
      var sessionId = props.sessionId
      var [state, setState] = useState(null)
      var [open, setOpen] = useState(false)

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

      var traits = state.personality ? state.personality.traits : {}
      var neuro = state.neuromods || {}
      var panelStyle = {
        position: 'absolute',
        bottom: '40px',
        left: '0',
        zIndex: 1000,
        width: '420px',
        maxHeight: '480px',
        overflowY: 'auto',
        padding: '14px 16px',
        borderRadius: '12px',
        border: '1px solid #1f2c3f',
        background: '#0d1420',
        color: '#dbe4ee',
        fontSize: '12px',
        lineHeight: '1.7',
        boxShadow: '0 8px 32px rgba(0,0,0,.5)',
      }
      var panel = createElement('div', { style: panelStyle },
        createElement('div', { style: { fontWeight: 700, marginBottom: '6px' } }, '🧠 大脑仪表盘'),
        row('人格', createElement('span', null, state.personality ? state.personality.label : '—')),
        row('五因素', createElement('span', null,
          'O' + traits.openness + ' C' + traits.conscientiousness + ' E' + traits.extraversion + ' A' + traits.agreeableness + ' N' + traits.neuroticism)),
        row('情绪', createElement('span', null, (affect.emotion ? affect.emotion.label : '—') + '（' + ((affect.emotion && affect.emotion.intensity) || 0).toFixed(2) + '）')),
        row('效价/唤醒/支配', createElement('span', null, bar((affect.valence + 1) / 2) + ' ' + bar(affect.arousal) + ' ' + bar((affect.dominance + 1) / 2))),
        row('调质 DA/5-HT', createElement('span', null, bar(neuro.da || 0) + ' ' + bar(neuro.ser || 0))),
        row('调质 NE/ACh', createElement('span', null, bar(neuro.ne || 0) + ' ' + bar(neuro.ach || 0))),
        row('记忆', createElement('span', null,
          (memory.episodes || 0) + ' 情景 · ' + (memory.concepts || 0) + ' 概念 · ' + (memory.permastore || 0) + ' 永久候选')),
        row('技能/意图', createElement('span', null,
          (state.skillCount || 0) + ' 条 · 待办 ' + ((state.intentions && state.intentions.active) || 0))),
        row('好感', createElement('span', null, ((state.affinity && state.affinity.level) || '初见') + '（正性 ' + Math.round(((state.affinity && state.affinity.positiveShare) || 0.5) * 100) + '%）')),
        row('工作记忆', createElement('span', null, (state.workingMemory || []).map(function (s) { return s.summary }).join(' ｜ ').slice(0, 80) || '—')),
        createElement('div', { style: { color: '#7d8ea3', marginTop: '8px', fontSize: '11px' } },
          '数据来自本机 127.0.0.1 只读 API；修改请用 cerebrum_* 工具。'),
      )
      return createElement('div', { style: { position: 'relative' } }, chip, panel)
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

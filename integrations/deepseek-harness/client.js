// Client half: no UI of its own, plus one row in Settings → General.
//
// 1. It acts on the notch island's "open this conversation" requests.
// 2. It owns the switch that shows or hides the notch indicator.
window.__ModuleLoader__.load({
  id: '@local/dsh-sessions',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ENDPOINT = 'http://127.0.0.1:47821';

    const log = (message) => {
      try {
        fetch(ENDPOINT + '/log?m=' + encodeURIComponent('[plugin] ' + message), { cache: 'no-store' });
      } catch {}
    };

    function IslandRow() {
      const [on, setOn] = React.useState(true);
      const [failed, setFailed] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        fetch(ENDPOINT + '/state', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (alive && d) setOn(d.islandEnabled !== false); })
          .catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
      }, []);

      const toggle = async () => {
        const next = !on;
        setOn(next);
        try {
          const r = await fetch(ENDPOINT + '/island?enabled=' + (next ? '1' : '0'), { method: 'POST' });
          if (!r.ok) throw new Error(String(r.status));
        } catch {
          setOn(!next);
          setFailed(true);
        }
      };

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '16px', padding: '12px 0',
        },
      }, [
        h('div', { key: 'text' }, [
          h('div', { key: 'title', style: { fontSize: '14px' } }, '刘海提示'),
          h('div', { key: 'desc', style: { fontSize: '12px', opacity: .6, marginTop: '2px', lineHeight: '18px' } },
            failed
              ? '连接后台失败：Fire Ring 可能没在运行。'
              : '在屏幕顶部刘海两侧显示「完成 / 在跑」；关掉后不再占用刘海。'),
        ]),
        h('button', {
          key: 'switch',
          type: 'button',
          onClick: toggle,
          'aria-pressed': on,
          style: {
            flex: '0 0 auto', minWidth: '64px', padding: '5px 12px', borderRadius: '999px',
            border: '1px solid ' + (on ? 'transparent' : 'rgba(127,127,127,.35)'),
            background: on ? '#8b7cff' : 'transparent',
            color: on ? '#ffffff' : 'inherit',
            font: 'inherit', fontSize: '12px', cursor: 'pointer',
            transition: 'background .18s ease, color .18s ease',
          },
        }, on ? '已开启' : '已关闭'),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let busy = false;
        let workspaceMissingLogged = false;

        const workspace = () => {
          try { return ctx.get('uiWorkspace'); } catch { return undefined; }
        };

        const first = workspace();
        log('applied; uiWorkspace=' + (first ? 'yes' : 'no') +
            '; openSession=' + (first && typeof first.openSession === 'function' ? 'yes' : 'no'));

        const open = (sessionId) => {
          const target = workspace();
          if (!target) {
            if (!workspaceMissingLogged) { workspaceMissingLogged = true; log('uiWorkspace missing'); }
            return false;
          }
          if (typeof target.openSession !== 'function') return false;
          const candidates = sessionId.startsWith('session-') ? [sessionId] : ['session-' + sessionId, sessionId];
          for (const candidate of candidates) {
            try {
              target.openSession(candidate);
              log('openSession ok for ' + candidate);
              return true;
            } catch {}
          }
          log('openSession failed for ' + sessionId);
          return false;
        };

        // uiSession.sessionStatus is a Map: sessionId -> { running, pendingInteraction, completionUnread }.
        // 这是 DeepSeek Harness 界面上的实时状态，比它写到硬盘的缓存早一两秒。
        const readStatus = () => {
          const running = [];
          const pending = [];
          try {
            const ui = ctx.get('uiSession');
            const snapshot = ui && ui.sessionStatus && ui.sessionStatus.getSnapshot();
            if (!snapshot || typeof snapshot.forEach !== 'function') return null;
            snapshot.forEach((status, sessionId) => {
              const id = String(sessionId).replace(/^session-/, '');
              if (status && status.running) running.push(id);
              if (status && status.pendingInteraction) pending.push(id);
            });
          } catch {
            return null;
          }
          return { running: running.sort(), pending: pending.sort() };
        };

        // 一有变化就告诉 Fire Ring；没变化时每 5 秒说一声「插件还在」。
        let lastKey = '';
        let lastSent = 0;
        let lastPending = new Set();
        let sending = false;
        const report = async () => {
          if (sending) return;
          const status = readStatus();
          if (!status) return;
          const key = JSON.stringify(status);
          if (key === lastKey && Date.now() - lastSent < 5000) return;
          sending = true;
          try {
            await fetch(ENDPOINT + '/dsh-live', { method: 'POST', body: JSON.stringify({ v: 2, ...status }) });
            lastKey = key;
            lastSent = Date.now();
            const pending = new Set(status.pending);
            for (const id of pending) if (!lastPending.has(id)) log('waiting for input: ' + id.slice(0, 8));
            for (const id of lastPending) if (!pending.has(id)) log('input received: ' + id.slice(0, 8));
            lastPending = pending;
          } catch {
          } finally {
            sending = false;
          }
        };

        try {
          const store = ctx.get('uiSession')?.sessionStatus;
          if (store && typeof store.subscribe === 'function') {
            const off = store.subscribe(() => { report(); });
            if (typeof off === 'function') ctx.effect(() => off);
          }
        } catch {}
        const fast = setInterval(report, 250);
        ctx.effect(() => () => clearInterval(fast));

        const poll = async () => {
          if (busy) return;
          busy = true;
          try {
            const response = await fetch(ENDPOINT + '/state', { cache: 'no-store' });
            if (!response.ok) return;
            const data = await response.json();
            if (!data || !data.pendingOpen) return;
            if (open(data.pendingOpen)) {
              await fetch(ENDPOINT + '/opened', { method: 'GET', cache: 'no-store' }).catch(() => {});
            }
          } catch {
          } finally {
            busy = false;
          }
        };

        const timer = setInterval(poll, 1000);
        poll();
        ctx.effect(() => () => clearInterval(timer));

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            { name: 'settings.general.item', id: 'dsh-island-toggle', order: 24 },
            IslandRow,
          ),
        );
      },
    };
  },
});

window.__ModuleLoader__.load({
  id: 'dsh-vscode-bridge-he',
  factory(require) {
    const React = require('react');

    const RETRY_MS = 500;
    const MAX_SEEN = 200;
    // How often an open page re-probes for the extension. Cheap: the Host caches a
    // filesystem scan for a few seconds, and this only asks one local endpoint.
    const RECHECK_MS = 30_000;
    // Where the install hint points. Kept in sync with the README's Install section.
    const INSTALL_DOC_URL = 'https://github.com/heyitaowml-ctrl/dsh-vscode-bridge#install';

    /**
     * Invisible composer participant: it owns the SSE subscription for the
     * current session and inserts incoming VSCode references at the live caret
     * through the composer's InputActions. Returning null keeps the DSH UI
     * unchanged.
     *
     * This is registered under `conversation.input.left` rather than
     * `conversation.composer.dock`: the dock is rendered only when the
     * composer variant is active, so a brand-new session (hero variant) would
     * not subscribe until its first message and the Host could only queue the
     * reference. The left tool slot renders in both variants and receives the
     * same `sessionId`, `inputActions`, and `useInput` props.
     */
    function VSCodeBridgeSlot(props) {
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      // The dock slot guarantees useInput; subscribing to the draft lets the
      // insertion add a separator only when the current draft needs one.
      const draft = props.useInput((snapshot) => snapshot.draft);

      // How many references the VS Code extension has ever sent to this Host
      // instance. `null` means the SSE handshake has not answered yet.
      const [attachments, setAttachments] = React.useState(null);
      // Whether this machine has ever had the extension, as persisted by the Host
      // (installed by the button, or having delivered at least one reference).
      // `null` = not answered yet. This, not `attachments`, decides the hint:
      // `attachments` resets on every Host restart, which made the pill reappear
      // on every launch even with a working extension.
      const [extensionKnown, setExtensionKnown] = React.useState(null);
      const [dismissed, setDismissed] = React.useState(false);
      // idle → installing → done | failed. `failed` keeps the manual link visible.
      const [install, setInstall] = React.useState({ phase: 'idle', message: '' });

      const installExtension = React.useCallback(async () => {
        setInstall({ phase: 'installing', message: '' });
        try {
          const response = await fetch('/dsh-vscode/install-extension', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const body = await response.json().catch(() => ({}));
          if (response.ok && body.ok === true) {
            setInstall({ phase: 'done', message: '' });
            // The Host has just persisted this too; reflect it locally so the
            // pill does not wait for the next handshake to disappear.
            setExtensionKnown(true);
            return;
          }
          setInstall({
            phase: 'failed',
            message: String(body?.message ?? body?.code ?? `HTTP ${response.status}`),
          });
        } catch (error) {
          setInstall({ phase: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
      }, []);

      // Re-probe the extension folder without reloading the page. Needed because a
      // user can delete the extension in VS Code at any time; without this the pill
      // would only come back on the next page load.
      const recheck = React.useCallback(async () => {
        try {
          const response = await fetch('/dsh-vscode/health?refresh=1', {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) return;
          const body = await response.json().catch(() => ({}));
          if (body?.extensionKnown === true) {
            setExtensionKnown(true);
            setInstall({ phase: 'idle', message: '' });
          } else if (body?.extensionKnown === false) {
            setExtensionKnown(false);
          }
        } catch {
          // A failed recheck just leaves the pill as it was.
        }
      }, []);

      // A page on http:// cannot navigate to file://, so "show me the VSIX" has to
      // be done by the Host. The fallback is the path itself, which the user can
      // paste anywhere.
      const revealVsix = React.useCallback(async () => {
        try {
          const response = await fetch('/dsh-vscode/reveal-vsix', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const body = await response.json().catch(() => ({}));
          if (response.ok && body?.ok === true) return;
          setInstall({
            phase: 'failed',
            message: `打不开目录，VSIX 在这里：${String(body?.path ?? body?.message ?? body?.code ?? response.status)}`,
          });
        } catch (error) {
          setInstall({ phase: 'failed', message: `打不开目录：${error instanceof Error ? error.message : String(error)}` });
        }
      }, []);

      // A user can uninstall the extension while this page is already open, and
      // the handshake happens only on connect — so poll, and re-check whenever the
      // tab regains focus. Without this the pill could never come back until a
      // full page reload, which is exactly what made the state look stuck.
      React.useEffect(() => {
        const timer = setInterval(() => { void recheck(); }, RECHECK_MS);
        const onFocus = () => { void recheck(); };
        const onVisibility = () => { if (document.visibilityState === 'visible') void recheck(); };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [recheck]);

      const queueRef = React.useRef([]);
      const seenRef = React.useRef(new Set());
      const timerRef = React.useRef(null);
      const mountedRef = React.useRef(true);
      const flushRef = React.useRef(() => {});

      flushRef.current = () => {
        if (!mountedRef.current) return;
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (inputActions === undefined || inputActions === null
          || typeof inputActions.captureInsertion !== 'function'
          || typeof inputActions.insertText !== 'function') {
          return;
        }
        while (queueRef.current.length > 0) {
          const text = queueRef.current[0];
          let inserted = false;
          try {
            const span = inputActions.captureInsertion();
            const separator = typeof draft === 'string' && draft !== '' && !/\s$/u.test(draft) ? ' ' : '';
            inserted = inputActions.insertText(`${separator}${text} `, span) === true;
          } catch (error) {
            console.warn('[dsh-vscode-bridge] failed to insert reference', error);
          }
          if (!inserted) break;
          queueRef.current.shift();
        }
        if (queueRef.current.length > 0 && timerRef.current === null) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            flushRef.current();
          }, RETRY_MS);
        }
      };

      React.useEffect(() => {
        mountedRef.current = true;
        flushRef.current();
        return () => {
          mountedRef.current = false;
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      }, [inputActions]);

      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null || sessionId === '') return undefined;
        let closed = false;
        let source;
        let onAttachment;
        let onHello;

        const connect = async () => {
          let bridge = typeof window === 'undefined' ? undefined : window.__DSH_VSCODE_BRIDGE__;
          if (bridge === undefined || bridge === null || !bridge.token || !bridge.channel) {
            try {
              const response = await fetch('/dsh-vscode/config', {
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { accept: 'application/json' },
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              bridge = await response.json();
              if (typeof window !== 'undefined' && bridge !== null && bridge.token && bridge.channel) {
                window.__DSH_VSCODE_BRIDGE__ = bridge;
              }
            } catch (error) {
              console.warn('[dsh-vscode-bridge] cannot load bridge config; reload DSH after installing the plugin', error);
              return;
            }
          }
          if (closed || bridge === undefined || bridge === null || !bridge.token || !bridge.channel) return;

          let url;
          try {
            url = new URL('/dsh-vscode/events', window.location.origin);
          } catch (error) {
            console.warn('[dsh-vscode-bridge] cannot build bridge URL', error);
            return;
          }
          url.searchParams.set('sessionId', sessionId);
          url.searchParams.set('channel', bridge.channel);
          url.searchParams.set('token', bridge.token);

          source = new EventSource(url.toString());
          onAttachment = (event) => {
            try {
              const item = JSON.parse(event.data);
              if (item === null || typeof item !== 'object' || typeof item.text !== 'string') return;
              const id = String(item.id ?? '');
              if (id !== '') {
                if (seenRef.current.has(id)) return;
                seenRef.current.add(id);
                if (seenRef.current.size > MAX_SEEN) {
                  const oldest = seenRef.current.values().next().value;
                  if (oldest !== undefined) seenRef.current.delete(oldest);
                }
              }
              queueRef.current.push(item.text);
              setAttachments((current) => (current === null ? 1 : current + 1));
              flushRef.current();
            } catch (error) {
              console.warn('[dsh-vscode-bridge] invalid attachment event', error);
            }
          };
          onHello = (event) => {
            try {
              const hello = JSON.parse(event.data);
              console.info('[dsh-vscode-bridge] connected', hello);
              const reported = Number(hello?.attachments ?? 0);
              setAttachments((current) => {
                const known = Number.isFinite(reported) && reported > 0 ? reported : 0;
                if (current === null) return known;
                return Math.max(current, known);
              });
              setExtensionKnown(hello?.extensionKnown === true);
            } catch {
              // A malformed hello is not worth surfacing.
            }
          };

          source.addEventListener('attachment', onAttachment);
          source.addEventListener('hello', onHello);
          source.addEventListener('error', () => {
            // EventSource retries automatically; keep the queue intact.
          });
        };

        void connect();

        return () => {
          closed = true;
          if (source !== undefined) {
            if (onAttachment !== undefined) source.removeEventListener('attachment', onAttachment);
            if (onHello !== undefined) source.removeEventListener('hello', onHello);
            source.close();
          }
        };
      }, [sessionId]);

      // Hidden once the Host says the machine has the extension (persisted across
      // restarts), or as soon as a reference arrives in this session.
      if (dismissed) return null;
      if (attachments === null || extensionKnown === null) return null;
      if (extensionKnown === true) return null;
      if (attachments > 0) return null;

      const phase = install.phase;
      const label = phase === 'installing'
        ? '正在安装 VS Code 扩展…'
        : phase === 'done'
          ? '已安装，请重载 VS Code 窗口'
          : phase === 'failed'
            ? `安装失败：${install.message}`
            : '⚠ VS Code 扩展未安装';

      // Red for "you need to do something", green once it is installed. Fixed
      // colours rather than theme tokens: this pill has to read as a warning in
      // both light and dark themes, and the tokens differ between them.
      const alert = '#e5484d';
      const good = '#2f9e44';
      const tone = phase === 'done' ? good : alert;
      const tint = phase === 'done' ? 'rgba(47,158,68,0.12)' : 'rgba(229,72,77,0.12)';

      const hint = phase === 'done'
        ? '扩展已装好。在 VS Code 里执行 Developer: Reload Window 后，右键菜单就会出现 DSH 命令。'
        : '本机还没装过 VS Code 扩展。点「一键安装」把随包附带的 VSIX 装进 VS Code，或手动安装。';

      const buttonStyle = {
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        padding: '0 4px',
        textDecoration: 'underline',
      };

      // Compact pill with a fixed alert/good colour so it reads as a warning in
      // both themes; the text inherits nothing because red on red would vanish.
      return React.createElement(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            minHeight: 22,
            padding: '0 2px 0 8px',
            marginRight: 4,
            fontSize: 11,
            lineHeight: '22px',
            borderRadius: 999,
            border: `1px solid ${tone}`,
            background: tint,
            color: tone,
            whiteSpace: 'nowrap',
            maxWidth: 520,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
          title: hint,
        },
        React.createElement('span', { style: { paddingRight: 2 } }, label),
        phase === 'idle' && React.createElement(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            title: '把随包附带的 VSIX 安装到本机 VS Code',
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              void installExtension();
            },
          },
          '一键安装',
        ),
        (phase === 'idle' || phase === 'failed') && React.createElement(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            title: '重新检查扩展是否还在（不刷新页面）',
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              void recheck();
            },
          },
          '重新检测',
        ),
        (phase === 'idle' || phase === 'failed') && React.createElement(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            title: '在资源管理器里打开本机随包附带的 VSIX，手动安装用',
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              void revealVsix();
            },
          },
          '手动',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            title: '不再提示',
            'aria-label': 'dismiss the VS Code extension hint',
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(true);
            },
            style: {
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: '18px',
              padding: '0 4px',
            },
          },
          '×',
        ),
      );
    }

    /**
     * Settings → VS Code 桥接. A permanent place to look at the bridge and to
     * rescan on demand — the composer pill disappears once the extension is
     * present, so without a page like this there is no way to ask "is it still
     * there?" after the pill has gone.
     */
    function VSCodeBridgeSettings() {
      const [status, setStatus] = React.useState({ phase: 'loading', state: null, version: null, path: null, message: '' });

      const load = React.useCallback(async () => {
        setStatus((prev) => ({ ...prev, phase: 'loading', message: '' }));
        try {
          const response = await fetch('/dsh-vscode/health?refresh=1', {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const body = await response.json().catch(() => ({}));
          setStatus({
            phase: 'ready',
            state: body?.extensionState ?? 'unknown',
            version: body?.extensionVersion ?? null,
            path: body?.extensionPath ?? null,
            message: '',
          });
        } catch (error) {
          setStatus({
            phase: 'ready',
            state: 'unknown',
            version: null,
            path: null,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }, []);

      const install = React.useCallback(async () => {
        setStatus((prev) => ({ ...prev, phase: 'installing', message: '' }));
        try {
          const response = await fetch('/dsh-vscode/install-extension', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const body = await response.json().catch(() => ({}));
          if (response.ok && body?.ok === true) {
            setStatus({ phase: 'ready', state: 'installed', version: null, path: null, message: '已安装。请在 VS Code 里执行 Developer: Reload Window 使命令生效。' });
            return;
          }
          setStatus({
            phase: 'ready',
            state: null,
            version: null,
            path: null,
            message: `安装失败：${String(body?.message ?? body?.code ?? `HTTP ${response.status}`)}`,
          });
        } catch (error) {
          setStatus({ phase: 'ready', state: null, version: null, path: null, message: `安装失败：${error instanceof Error ? error.message : String(error)}` });
        }
      }, []);

      React.useEffect(() => { void load(); }, [load]);

      // Same Host-side reveal as the pill, so the settings page can also open the
      // bundled VSIX in the file manager.
      const reveal = React.useCallback(async () => {
        try {
          const response = await fetch('/dsh-vscode/reveal-vsix', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const body = await response.json().catch(() => ({}));
          if (response.ok && body?.ok === true) {
            setStatus((prev) => ({ ...prev, message: `已打开：${String(body.path ?? '')}` }));
            return;
          }
          setStatus((prev) => ({ ...prev, message: `打不开目录，VSIX 在这里：${String(body?.path ?? body?.message ?? body?.code ?? response.status)}` }));
        } catch (error) {
          setStatus((prev) => ({ ...prev, message: `打不开目录：${error instanceof Error ? error.message : String(error)}` }));
        }
      }, []);

      const tone = status.state === 'installed'
        ? '#2f9e44'
        : status.state === 'absent' ? '#e5484d' : '#8a8f98';
      const stateLabel = status.phase === 'loading'
        ? '正在扫描…'
        : status.phase === 'installing'
          ? '正在安装…'
          : status.state === 'installed'
            ? '已安装'
            : status.state === 'absent' ? '未检测到' : '无法识别 Editor 目录';

      const button = {
        font: 'inherit',
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      };

      const row = (label, value) => React.createElement(
        'div',
        { style: { display: 'flex', gap: 12, fontSize: 12, lineHeight: '22px' } },
        React.createElement('span', { style: { minWidth: 64, opacity: 0.6 } }, label),
        React.createElement('span', { style: { wordBreak: 'break-all' } }, value),
      );

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 0' } },
        row('状态', React.createElement('span', { style: { color: tone, fontWeight: 600 } }, stateLabel)),
        status.version === null ? null : row('版本', status.version),
        status.path === null ? null : row('路径', status.path),
        status.message === '' ? null : row('结果', status.message),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
          React.createElement('button', { type: 'button', style: button, onClick: () => { void load(); } }, '立即扫描'),
          React.createElement('button', { type: 'button', style: button, onClick: () => { void install(); } }, '一键安装 / 重装'),
          React.createElement('button', { type: 'button', style: button, onClick: () => { void reveal(); } }, '打开 VSIX 目录'),
          React.createElement(
            'a',
            { href: INSTALL_DOC_URL, target: '_blank', rel: 'noreferrer noopener', style: { ...button, textDecoration: 'none', display: 'inline-block', opacity: 0.75 } },
            '安装说明（GitHub）',
          ),
        ),
        React.createElement(
          'div',
          { style: { fontSize: 11, opacity: 0.6, marginTop: 2, lineHeight: '18px' } },
          'DSH 每次加载页面都会自动扫描一次，打开这个页面时也会扫描。扩展装在 VS Code、Insiders、VSCodium、Cursor、Windsurf 的扩展目录下都能识别；其它编辑器可用环境变量 DSH_VSCODE_EXTENSION_DIRS 指定。',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'vscode-bridge',
          order: 90,
        }, VSCodeBridgeSlot));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'vscode-bridge',
          order: 60,
          label: 'VS Code 桥接',
        }, VSCodeBridgeSettings));
      },
    };
  },
});

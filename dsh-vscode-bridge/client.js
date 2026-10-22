window.__ModuleLoader__.load({
  id: '@local/dsh-vscode-bridge',
  factory(require) {
    const React = require('react');

    const RETRY_MS = 500;
    const MAX_SEEN = 200;

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
              flushRef.current();
            } catch (error) {
              console.warn('[dsh-vscode-bridge] invalid attachment event', error);
            }
          };
          onHello = (event) => {
            try {
              const hello = JSON.parse(event.data);
              console.info('[dsh-vscode-bridge] connected', hello);
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

      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'vscode-bridge',
          order: 90,
        }, VSCodeBridgeSlot));
      },
    };
  },
});

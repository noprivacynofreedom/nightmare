import { useCallback, useEffect, useRef, useState } from 'react';
import type { SwarmRoomState, UserProfile, WorkspaceView, ZipEntryItem } from '../types';

export type SwarmConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

function getInitialRoomId(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('room');
  if (fromUrl && /^[a-zA-Z0-9_-]{2,48}$/.test(fromUrl)) {
    return fromUrl.toLowerCase();
  }
  return 'atlas-alpha';
}

function getSessionId(): string {
  const key = 'atlas_swarm_session_id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

export function useSwarm(options: {
  profile: UserProfile | null;
  activeView: WorkspaceView;
  activeChallengeId: string | null;
  onRemoteFocus?: (challengeId: string, fromHandle: string) => void;
}) {
  const { profile, activeView, activeChallengeId, onRemoteFocus } = options;
  const [roomId, setRoomId] = useState<string>(getInitialRoomId);
  const [status, setStatus] = useState<SwarmConnectionStatus>('disconnected');
  const [roomState, setRoomState] = useState<SwarmRoomState>({
    roomId: getInitialRoomId(),
    peers: [],
    claims: {},
    sharedNotes: {},
    archiveManifest: null,
    feed: [],
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string>(getSessionId());
  const onRemoteFocusRef = useRef(onRemoteFocus);
  onRemoteFocusRef.current = onRemoteFocus;

  const latestPresenceRef = useRef({
    activeView,
    activeChallengeId,
    handle: profile?.handle || 'guest',
    role: profile?.role || 'player',
    uid: profile?.uid || sessionIdRef.current,
  });

  latestPresenceRef.current = {
    activeView,
    activeChallengeId,
    handle: profile?.handle || 'guest',
    role: profile?.role || 'player',
    uid: profile?.uid || sessionIdRef.current,
  };

  const sendFrame = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  useEffect(() => {
    if (!profile) {
      setStatus('disconnected');
      return;
    }

    let cancelled = false;
    let backoffMs = 1000;

    const connect = () => {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws/swarm`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        backoffMs = 1000;
        setStatus('connected');
        const p = latestPresenceRef.current;
        ws.send(
          JSON.stringify({
            type: 'room:join',
            roomId,
            sessionId: sessionIdRef.current,
            uid: p.uid,
            handle: p.handle,
            role: p.role,
            activeView: p.activeView,
            activeChallengeId: p.activeChallengeId,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.type === 'room:state' && msg.state) {
            setRoomState(msg.state as SwarmRoomState);
          } else if (
            msg.type === 'swarm:focus' &&
            typeof msg.challengeId === 'string' &&
            onRemoteFocusRef.current
          ) {
            onRemoteFocusRef.current(msg.challengeId, String(msg.fromHandle || 'peer'));
          }
        } catch {
          // Ignore invalid payloads
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setStatus('reconnecting');
        reconnectTimerRef.current = window.setTimeout(() => {
          backoffMs = Math.min(backoffMs * 1.5, 6000);
          connect();
        }, backoffMs);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [profile?.uid, roomId]);

  // Broadcast presence updates whenever view, selected challenge, or role/handle changes
  useEffect(() => {
    if (!profile) return;
    sendFrame({
      type: 'presence:update',
      activeView,
      activeChallengeId,
      handle: profile.handle,
      role: profile.role,
    });
  }, [activeView, activeChallengeId, profile?.handle, profile?.role, sendFrame]);

  const joinRoom = useCallback((nextRoom: string) => {
    const cleaned = nextRoom.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48);
    if (cleaned.length < 2) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', cleaned);
    window.history.replaceState({}, '', url.toString());
    setRoomId(cleaned);
  }, []);

  const toggleClaim = useCallback(
    (challengeId: string) => {
      sendFrame({ type: 'claim:toggle', challengeId });
    },
    [sendFrame]
  );

  const syncSharedNote = useCallback(
    (challengeId: string, content: string) => {
      sendFrame({ type: 'note:sync', challengeId, content });
    },
    [sendFrame]
  );

  const shareArchiveManifest = useCallback(
    (fileName: string, entries: ZipEntryItem[]) => {
      sendFrame({
        type: 'archive:share',
        manifest: {
          fileName,
          fileCount: entries.filter((e) => !e.dir).length,
          paths: entries
            .filter((e) => !e.dir)
            .slice(0, 120)
            .map((e) => e.path),
        },
      });
    },
    [sendFrame]
  );

  const announceFlag = useCallback(
    (challengeId: string, challengeTitle: string) => {
      sendFrame({ type: 'flag:announce', challengeId, challengeTitle });
    },
    [sendFrame]
  );

  const broadcastFocus = useCallback(
    (challengeId: string) => {
      sendFrame({ type: 'focus:broadcast', challengeId });
    },
    [sendFrame]
  );

  const sendMessage = useCallback(
    (rawText: string, challengeId?: string): string | null => {
      const text = rawText.trim();
      if (!text) return null;

      // Support /swarm slash commands for multi-session workflows
      if (text.startsWith('/swarm')) {
        const parts = text.split(/\s+/);
        const cmd = (parts[1] || '').toLowerCase();
        const arg = parts.slice(2).join(' ').trim();

        if (cmd === 'room' && arg) {
          joinRoom(arg);
          return `Switched Swarm room to "${arg}".`;
        }
        if (cmd === 'claim' && arg) {
          toggleClaim(arg);
          return `Toggled Swarm claim on "${arg}".`;
        }
        if (cmd === 'focus' && arg) {
          broadcastFocus(arg);
          return `Broadcast focus directive for "${arg}".`;
        }
        if (cmd === 'help' || !cmd) {
          return 'Commands: /swarm room <name>, /swarm claim <challenge-id>, /swarm focus <challenge-id>, or type any message to broadcast.';
        }
      }

      sendFrame({
        type: 'feed:post',
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text,
        challengeId,
      });
      return null;
    },
    [sendFrame, joinRoom, toggleClaim, broadcastFocus]
  );

  return {
    sessionId: sessionIdRef.current,
    roomId,
    status,
    roomState,
    joinRoom,
    toggleClaim,
    syncSharedNote,
    shareArchiveManifest,
    announceFlag,
    broadcastFocus,
    sendMessage,
  };
}

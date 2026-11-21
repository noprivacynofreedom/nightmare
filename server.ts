import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type UserRole = 'player' | 'organizer' | 'admin';

interface SwarmPeer {
  sessionId: string;
  uid: string;
  handle: string;
  role: UserRole;
  activeView: string;
  activeChallengeId: string | null;
  joinedAt: number;
}

interface SwarmClaim {
  challengeId: string;
  sessionId: string;
  handle: string;
  claimedAt: number;
}

interface SwarmSharedNote {
  challengeId: string;
  content: string;
  updatedBy: string;
  updatedAt: number;
}

interface SwarmArchiveManifest {
  fileName: string;
  fileCount: number;
  sharedBy: string;
  paths: string[];
  sharedAt: number;
}

interface SwarmFeedItem {
  id: string;
  type: 'join' | 'leave' | 'message' | 'claim' | 'flag' | 'archive' | 'focus';
  handle: string;
  role: UserRole;
  text: string;
  challengeId?: string;
  timestamp: number;
}

interface SwarmRoom {
  roomId: string;
  sockets: Map<string, WebSocket>;
  peers: Map<string, SwarmPeer>;
  claims: Map<string, SwarmClaim>;
  sharedNotes: Map<string, SwarmSharedNote>;
  archiveManifest: SwarmArchiveManifest | null;
  feed: SwarmFeedItem[];
}

const rooms = new Map<string, SwarmRoom>();

function sanitizeRoomId(raw: unknown): string {
  if (typeof raw !== 'string') return 'atlas-alpha';
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48);
  return cleaned.length >= 2 ? cleaned : 'atlas-alpha';
}

function getOrCreateRoom(roomId: string): SwarmRoom {
  const safeId = sanitizeRoomId(roomId);
  let room = rooms.get(safeId);
  if (!room) {
    room = {
      roomId: safeId,
      sockets: new Map(),
      peers: new Map(),
      claims: new Map(),
      sharedNotes: new Map(),
      archiveManifest: null,
      feed: [],
    };
    rooms.set(safeId, room);
  }
  return room;
}

function serializeRoom(room: SwarmRoom) {
  return {
    roomId: room.roomId,
    peers: Array.from(room.peers.values()),
    claims: Object.fromEntries(room.claims.entries()),
    sharedNotes: Object.fromEntries(room.sharedNotes.entries()),
    archiveManifest: room.archiveManifest,
    feed: room.feed.slice(-100),
  };
}

function pushFeed(room: SwarmRoom, item: SwarmFeedItem) {
  if (room.feed.some((existing) => existing.id === item.id)) {
    return;
  }
  room.feed.push(item);
  if (room.feed.length > 100) {
    room.feed = room.feed.slice(-100);
  }
}

function broadcast(room: SwarmRoom, payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  for (const sock of room.sockets.values()) {
    if (sock.readyState === WebSocket.OPEN) {
      sock.send(raw);
    }
  }
}

function makeEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Health & room summary endpoint
  app.get('/api/swarm/rooms', (_req, res) => {
    const summary = Array.from(rooms.values())
      .filter((r) => r.peers.size > 0)
      .map((r) => ({
        roomId: r.roomId,
        peerCount: r.peers.size,
        claimCount: r.claims.size,
        hasArchive: Boolean(r.archiveManifest),
      }));
    res.json({ rooms: summary });
  });

  const server = http.createServer(app);

  // Real-time WebSocket Server for /swarm multi-session coordination
  const wss = new WebSocketServer({ server, path: '/ws/swarm' });

  wss.on('connection', (ws) => {
    let currentRoom: SwarmRoom | null = null;
    let currentSessionId: string | null = null;

    const leaveCurrentRoom = () => {
      if (!currentRoom || !currentSessionId) return;
      const peer = currentRoom.peers.get(currentSessionId);
      currentRoom.sockets.delete(currentSessionId);
      currentRoom.peers.delete(currentSessionId);

      // Release claims held by departing session
      for (const [challengeId, claim] of currentRoom.claims.entries()) {
        if (claim.sessionId === currentSessionId) {
          currentRoom.claims.delete(challengeId);
        }
      }

      if (peer) {
        const leaveEvent: SwarmFeedItem = {
          id: makeEventId(),
          type: 'leave',
          handle: peer.handle,
          role: peer.role,
          text: `${peer.handle} disconnected from Swarm room ${currentRoom.roomId}.`,
          timestamp: Date.now(),
        };
        pushFeed(currentRoom, leaveEvent);
        broadcast(currentRoom, {
          type: 'room:state',
          state: serializeRoom(currentRoom),
        });
      }

      if (currentRoom.peers.size === 0 && currentRoom.feed.length === 0) {
        rooms.delete(currentRoom.roomId);
      }

      currentRoom = null;
      currentSessionId = null;
    };

    ws.on('message', (rawData) => {
      try {
        const msg = JSON.parse(String(rawData));
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'room:join') {
          leaveCurrentRoom();
          const roomId = sanitizeRoomId(msg.roomId);
          const sessionId =
            typeof msg.sessionId === 'string' && msg.sessionId.length > 0
              ? msg.sessionId.slice(0, 64)
              : makeEventId();
          const handle =
            typeof msg.handle === 'string' && msg.handle.trim().length > 0
              ? msg.handle.trim().slice(0, 32)
              : 'operator';
          const role: UserRole =
            msg.role === 'admin' || msg.role === 'organizer' ? msg.role : 'player';

          const room = getOrCreateRoom(roomId);
          currentRoom = room;
          currentSessionId = sessionId;

          const peer: SwarmPeer = {
            sessionId,
            uid: typeof msg.uid === 'string' ? msg.uid.slice(0, 128) : sessionId,
            handle,
            role,
            activeView: typeof msg.activeView === 'string' ? msg.activeView : 'curriculum',
            activeChallengeId:
              typeof msg.activeChallengeId === 'string' ? msg.activeChallengeId : null,
            joinedAt: Date.now(),
          };

          room.sockets.set(sessionId, ws);
          room.peers.set(sessionId, peer);

          pushFeed(room, {
            id: makeEventId(),
            type: 'join',
            handle: peer.handle,
            role: peer.role,
            text: `${peer.handle} joined Swarm room ${room.roomId}.`,
            timestamp: Date.now(),
          });

          broadcast(room, {
            type: 'room:state',
            state: serializeRoom(room),
          });
          return;
        }

        if (!currentRoom || !currentSessionId) return;
        const peer = currentRoom.peers.get(currentSessionId);
        if (!peer) return;

        if (msg.type === 'presence:update') {
          if (typeof msg.activeView === 'string') peer.activeView = msg.activeView;
          if (msg.activeChallengeId === null || typeof msg.activeChallengeId === 'string') {
            peer.activeChallengeId = msg.activeChallengeId;
          }
          if (typeof msg.handle === 'string' && msg.handle.trim()) {
            peer.handle = msg.handle.trim().slice(0, 32);
          }
          if (msg.role === 'admin' || msg.role === 'organizer' || msg.role === 'player') {
            peer.role = msg.role;
          }
          broadcast(currentRoom, {
            type: 'room:state',
            state: serializeRoom(currentRoom),
          });
          return;
        }

        if (msg.type === 'claim:toggle' && typeof msg.challengeId === 'string') {
          const cid = msg.challengeId.slice(0, 128);
          const existingClaim = currentRoom.claims.get(cid);
          if (existingClaim && existingClaim.sessionId === currentSessionId) {
            currentRoom.claims.delete(cid);
            pushFeed(currentRoom, {
              id: makeEventId(),
              type: 'claim',
              handle: peer.handle,
              role: peer.role,
              challengeId: cid,
              text: `${peer.handle} released claim on ${cid}.`,
              timestamp: Date.now(),
            });
          } else {
            currentRoom.claims.set(cid, {
              challengeId: cid,
              sessionId: currentSessionId,
              handle: peer.handle,
              claimedAt: Date.now(),
            });
            pushFeed(currentRoom, {
              id: makeEventId(),
              type: 'claim',
              handle: peer.handle,
              role: peer.role,
              challengeId: cid,
              text: `${peer.handle} claimed target ${cid}.`,
              timestamp: Date.now(),
            });
          }
          broadcast(currentRoom, {
            type: 'room:state',
            state: serializeRoom(currentRoom),
          });
          return;
        }

        if (
          msg.type === 'note:sync' &&
          typeof msg.challengeId === 'string' &&
          typeof msg.content === 'string'
        ) {
          const cid = msg.challengeId.slice(0, 128);
          currentRoom.sharedNotes.set(cid, {
            challengeId: cid,
            content: msg.content.slice(0, 4000),
            updatedBy: peer.handle,
            updatedAt: Date.now(),
          });
          broadcast(currentRoom, {
            type: 'room:state',
            state: serializeRoom(currentRoom),
          });
          return;
        }

        if (msg.type === 'archive:share' && msg.manifest && typeof msg.manifest === 'object') {
          const paths = Array.isArray(msg.manifest.paths)
            ? msg.manifest.paths
                .filter((p: unknown): p is string => typeof p === 'string')
                .slice(0, 150)
            : [];
          currentRoom.archiveManifest = {
            fileName:
              typeof msg.manifest.fileName === 'string'
                ? msg.manifest.fileName.slice(0, 120)
                : 'Nightmare.zip',
            fileCount:
              typeof msg.manifest.fileCount === 'number' ? msg.manifest.fileCount : paths.length,
            sharedBy: peer.handle,
            paths,
            sharedAt: Date.now(),
          };
          pushFeed(currentRoom, {
            id: makeEventId(),
            type: 'archive',
            handle: peer.handle,
            role: peer.role,
            text: `${peer.handle} synced archive manifest "${currentRoom.archiveManifest.fileName}" (${currentRoom.archiveManifest.fileCount} entries) to Swarm.`,
            timestamp: Date.now(),
          });
          broadcast(currentRoom, {
            type: 'room:state',
            state: serializeRoom(currentRoom),
          });
          return;
        }

        if (msg.type === 'flag:announce' && typeof msg.challengeId === 'string') {
          const title =
            typeof msg.challengeTitle === 'string' ? msg.challengeTitle.slice(0, 120) : msg.challengeId;
          pushFeed(currentRoom, {
            id: makeEventId(),
            type: 'flag',
            handle: peer.handle,
            role: peer.role,
            challengeId: msg.challengeId.slice(0, 128),
            text: `${peer.handle} verified flag for ${title}.`,
            timestamp: Date.now(),
          });
          broadcast(currentRoom, {
            type: 'room:state',
            state: serializeRoom(currentRoom),
          });
          return;
        }

        if (msg.type === 'focus:broadcast' && typeof msg.challengeId === 'string') {
          const cid = msg.challengeId.slice(0, 128);
          pushFeed(currentRoom, {
            id: makeEventId(),
            type: 'focus',
            handle: peer.handle,
            role: peer.role,
            challengeId: cid,
            text: `${peer.handle} directed Swarm focus to target ${cid}.`,
            timestamp: Date.now(),
          });
          broadcast(currentRoom, {
            type: 'swarm:focus',
            challengeId: cid,
            fromHandle: peer.handle,
          });
          broadcast(currentRoom, {
            type: 'room:state',
            state: serializeRoom(currentRoom),
          });
          return;
        }

        if (msg.type === 'feed:post' && typeof msg.text === 'string') {
          const cleanText = msg.text.trim().slice(0, 600);
          if (!cleanText) return;
          const eventId = typeof msg.id === 'string' ? msg.id.slice(0, 64) : makeEventId();
          pushFeed(currentRoom, {
            id: eventId,
            type: 'message',
            handle: peer.handle,
            role: peer.role,
            challengeId:
              typeof msg.challengeId === 'string' ? msg.challengeId.slice(0, 128) : undefined,
            text: cleanText,
            timestamp: Date.now(),
          });
          broadcast(currentRoom, {
            type: 'room:state',
            state: serializeRoom(currentRoom),
          });
        }
      } catch {
        // Ignore malformed socket frames
      }
    });

    ws.on('close', leaveCurrentRoom);
    ws.on('error', leaveCurrentRoom);
  });

  // Vite dev middleware or production static assets
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Atlas CTF server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();

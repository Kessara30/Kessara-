import http from 'http';
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  } catch {
    socket.destroy();
  }
});

interface PlayerInfo {
  id: string;
  nickname: string;
  team: 'blue' | 'red' | 'solo';
  role: 'tv' | 'player';
  ws?: WebSocket;
}

// In-memory server-authoritative shared state
let sharedGameState = {
  mode: 'team-battle' as 'solo' | 'team-battle',
  stage: 1 as 1 | 2 | 3 | 4 | 5,
  roundId: 1,
  timer: 30,
  isTimerRunning: false,
  category: 'all',
  activePairs: [] as Array<{ id: string; verb: string; noun: string; thaiMeaning: string }>,

  // Matches
  soloMatchedIds: [] as string[],
  blueMatchedIds: [] as string[],
  redMatchedIds: [] as string[],
  blueMatchedDetails: [] as Array<{ pairId: string; verb: string; noun: string; thaiMeaning: string; pointsEarned: number; timeRemaining: number }>,
  redMatchedDetails: [] as Array<{ pairId: string; verb: string; noun: string; thaiMeaning: string; pointsEarned: number; timeRemaining: number }>,

  // Team scores
  blueScore: 0,
  redScore: 0,
  blueTime: null as number | null,
  redTime: null as number | null,

  // Cards
  soloCard: null as any,
  blueCard: null as any,
  redCard: null as any,

  // Approvals
  blueApproved: false,
  redApproved: false,
  soloApproved: false,
  approvedSentence: '',

  // Connected players
  players: [] as Array<{ id: string; nickname: string; team: 'blue' | 'red' | 'solo'; role: 'tv' | 'player' }>,

  // Dual Ready states before starting
  blueReady: false,
  redReady: false,
  countdown: null as number | null,
};

let timerInterval: NodeJS.Timeout | null = null;
let countdownTimeout: NodeJS.Timeout | null = null;

function broadcastState() {
  const payload = JSON.stringify({ type: 'STATE_UPDATE', state: sharedGameState });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function stopCountdown() {
  if (countdownTimeout) {
    clearTimeout(countdownTimeout);
    countdownTimeout = null;
  }
  sharedGameState.countdown = null;
}

function startCountdown() {
  stopCountdown();
  sharedGameState.countdown = 3;
  broadcastState();

  countdownTimeout = setTimeout(() => {
    sharedGameState.countdown = 2;
    broadcastState();

    countdownTimeout = setTimeout(() => {
      sharedGameState.countdown = 1;
      broadcastState();

      countdownTimeout = setTimeout(() => {
        sharedGameState.countdown = null;
        startTimer();
      }, 1000);
    }, 1000);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  sharedGameState.isTimerRunning = false;
}

function startTimer() {
  stopCountdown();
  stopTimer();
  sharedGameState.isTimerRunning = true;
  timerInterval = setInterval(() => {
    if (sharedGameState.timer > 0) {
      sharedGameState.timer -= 1;
      broadcastState();
    } else {
      stopTimer();
      broadcastState();
    }
  }, 1000);
}

// REST fallback endpoints
app.get('/api/game/state', (_req: Request, res: Response) => {
  res.json(sharedGameState);
});

app.post('/api/game/action', (req: Request, res: Response) => {
  handleAction(req.body);
  res.json({ success: true, state: sharedGameState });
});

function handleAction(data: any) {
  if (!data || !data.action) return;

  switch (data.action) {
    case 'SET_MODE':
      sharedGameState.mode = data.mode;
      broadcastState();
      break;

    case 'INIT_ROUND':
      stopCountdown();
      stopTimer();
      sharedGameState.stage = 1;
      sharedGameState.roundId += 1;
      sharedGameState.timer = 30;
      sharedGameState.blueReady = false;
      sharedGameState.redReady = false;
      sharedGameState.countdown = null;
      sharedGameState.activePairs = data.pairs || [];
      sharedGameState.category = data.category || 'all';
      sharedGameState.soloMatchedIds = [];
      sharedGameState.blueMatchedIds = [];
      sharedGameState.redMatchedIds = [];
      sharedGameState.blueMatchedDetails = [];
      sharedGameState.redMatchedDetails = [];
      sharedGameState.blueTime = null;
      sharedGameState.redTime = null;
      sharedGameState.soloCard = null;
      sharedGameState.blueCard = null;
      sharedGameState.redCard = null;
      sharedGameState.blueApproved = false;
      sharedGameState.redApproved = false;
      sharedGameState.soloApproved = false;
      sharedGameState.approvedSentence = '';
      broadcastState();
      break;

    case 'SET_READY': {
      if (data.team === 'blue') {
        sharedGameState.blueReady = data.ready !== false;
      } else if (data.team === 'red') {
        sharedGameState.redReady = data.ready !== false;
      }
      broadcastState();

      // When BOTH teams are ready, trigger dramatic countdown!
      if (
        sharedGameState.blueReady &&
        sharedGameState.redReady &&
        !sharedGameState.isTimerRunning &&
        sharedGameState.countdown === null
      ) {
        startCountdown();
      }
      break;
    }

    case 'START_TIMER':
      stopCountdown();
      startTimer();
      broadcastState();
      break;

    case 'MATCH_PAIR': {
      // Faster answers yield higher score!
      const timeRemaining = Math.max(sharedGameState.timer, 0);
      const pointsEarned = 50 + (timeRemaining * 5); // 50 base + 5 per second left

      // Find pair details if available
      const pair = sharedGameState.activePairs.find((p) => p.id === data.pairId) || {
        id: data.pairId,
        verb: data.verb || 'VERB',
        noun: data.noun || 'noun',
        thaiMeaning: data.thaiMeaning || '',
      };

      const matchDetail = {
        pairId: data.pairId,
        verb: pair.verb,
        noun: pair.noun,
        thaiMeaning: pair.thaiMeaning,
        pointsEarned,
        timeRemaining,
      };

      if (data.team === 'blue') {
        if (!sharedGameState.blueMatchedIds.includes(data.pairId)) {
          sharedGameState.blueMatchedIds.push(data.pairId);
          sharedGameState.blueMatchedDetails.push(matchDetail);
          sharedGameState.blueScore += pointsEarned;

          if (sharedGameState.blueMatchedIds.length === 6 && sharedGameState.blueTime === null) {
            sharedGameState.blueTime = timeRemaining;
            sharedGameState.blueScore += 100 + (timeRemaining * 10); // Completion speed bonus
          }
        }
      } else if (data.team === 'red') {
        if (!sharedGameState.redMatchedIds.includes(data.pairId)) {
          sharedGameState.redMatchedIds.push(data.pairId);
          sharedGameState.redMatchedDetails.push(matchDetail);
          sharedGameState.redScore += pointsEarned;

          if (sharedGameState.redMatchedIds.length === 6 && sharedGameState.redTime === null) {
            sharedGameState.redTime = timeRemaining;
            sharedGameState.redScore += 100 + (timeRemaining * 10); // Completion speed bonus
          }
        }
      } else {
        if (!sharedGameState.soloMatchedIds.includes(data.pairId)) {
          sharedGameState.soloMatchedIds.push(data.pairId);
        }
      }
      broadcastState();
      break;
    }

    case 'SET_STAGE':
      sharedGameState.stage = data.stage;
      if (data.stage !== 1) {
        stopTimer();
      }
      broadcastState();
      break;

    case 'SET_CARDS':
      if (data.soloCard) sharedGameState.soloCard = data.soloCard;
      if (data.blueCard) sharedGameState.blueCard = data.blueCard;
      if (data.redCard) sharedGameState.redCard = data.redCard;
      broadcastState();
      break;

    case 'APPROVE_SENTENCE':
      if (data.team === 'blue') {
        sharedGameState.blueApproved = true;
        sharedGameState.blueScore += 100;
      } else if (data.team === 'red') {
        sharedGameState.redApproved = true;
        sharedGameState.redScore += 100;
      } else {
        sharedGameState.soloApproved = true;
        sharedGameState.approvedSentence = data.sentence || '';
      }
      broadcastState();
      break;

    case 'NEXT_ROUND':
      stopCountdown();
      stopTimer();
      sharedGameState.stage = 1;
      sharedGameState.roundId += 1;
      sharedGameState.timer = 30;
      sharedGameState.blueReady = false;
      sharedGameState.redReady = false;
      sharedGameState.countdown = null;
      sharedGameState.soloMatchedIds = [];
      sharedGameState.blueMatchedIds = [];
      sharedGameState.redMatchedIds = [];
      sharedGameState.blueMatchedDetails = [];
      sharedGameState.redMatchedDetails = [];
      sharedGameState.soloCard = null;
      sharedGameState.blueCard = null;
      sharedGameState.redCard = null;
      sharedGameState.blueApproved = false;
      sharedGameState.redApproved = false;
      sharedGameState.soloApproved = false;
      sharedGameState.approvedSentence = '';
      broadcastState();
      break;

    default:
      break;
  }
}

// WebSocket connection handling
wss.on('connection', (ws: WebSocket) => {
  let registeredPlayerId: string | null = null;

  // Send initial state immediately
  ws.send(JSON.stringify({ type: 'STATE_UPDATE', state: sharedGameState }));

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'REGISTER_PLAYER') {
        const playerId: string = data.id || `p_${Date.now()}`;
        registeredPlayerId = playerId;
        const newPlayer = {
          id: playerId,
          nickname: String(data.nickname || 'Student'),
          team: (data.team === 'red' ? 'red' : data.team === 'solo' ? 'solo' : 'blue') as 'blue' | 'red' | 'solo',
          role: (data.role === 'tv' ? 'tv' : 'player') as 'tv' | 'player',
        };

        // Remove old if exists
        sharedGameState.players = sharedGameState.players.filter((p) => p.id !== registeredPlayerId);
        sharedGameState.players.push(newPlayer);
        broadcastState();
      } else if (data.type === 'ACTION') {
        handleAction(data.payload);
      }
    } catch {
      // Handle parsing gracefully
    }
  });

  ws.on('close', () => {
    if (registeredPlayerId) {
      sharedGameState.players = sharedGameState.players.filter((p) => p.id !== registeredPlayerId);
      broadcastState();
    }
  });
});

async function start() {
  const PORT = parseInt(process.env.PORT || '3000', 10);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

start();

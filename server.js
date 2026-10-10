const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PDFDocument = require('pdfkit');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); 

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

let questions = [
  { text: 'What is the capital of the Philippines?', choices: ['Cebu', 'Davao', 'Manila', 'Baguio'], correct: 2, timeLimit: 15 },
  { text: 'What is 5 x 6?', choices: ['11', '30', '25', '60'], correct: 1, timeLimit: 10 }
];

let players = {};
let persistentScores = {};
let teacherSocketId = null;
const TEACHER_PASSKEY = 'froyoo0120';

// Room Code Generation
let ROOM_CODE = Math.random().toString(36).substring(2, 6).toUpperCase();

let currentQuestion = -1;
let quizStarted = false;
let answered = {};
let revealAnswer = false;

// Server-side Timer State
let timerInterval = null;
let timeLeft = 0;
let isPaused = false;
let isTransitioning = false; // Prevents answering during the auto-next delay

function saveResultsToPDF(teacherSocket) {
  const leaderboard = Object.values(players).sort((a, b) => b.score - a.score);
  const doc = new PDFDocument({ margin: 50 });
  let buffers = [];
  
  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => {
    const pdfData = Buffer.concat(buffers);
    if (teacherSocket) {
      teacherSocket.emit('teacher:pdf-ready', pdfData);
    }
  });

  doc.fontSize(24).font('Helvetica-Bold').text('Quiz Results', { align: 'center' });
  doc.moveDown();
  doc.fontSize(14).font('Helvetica').text(`Date: ${new Date().toLocaleString()}`, { align: 'center' });
  doc.moveDown(2);

  leaderboard.forEach((p, i) => {
    doc.fontSize(16).text(`${i + 1}. ${p.name}`, { continued: true });
    doc.text(` — ${p.score} points`, { align: 'right' });
    doc.moveDown(0.5);
  });
  doc.end();
}

function getLeaderboard() {
  return Object.values(players).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function getPublicQuestion() {
  if (currentQuestion < 0 || currentQuestion >= questions.length) return null;
  const q = questions[currentQuestion];
  return { text: q.text, choices: q.choices, timeLimit: q.timeLimit };
}

function broadcast() {
  io.emit('update', {
    players: getLeaderboard(),
    question: getPublicQuestion(),
    quizStarted,
    currentQuestion,
    totalQuestions: questions.length,
    revealAnswer,
    correctAnswer: revealAnswer && currentQuestion >= 0 ? questions[currentQuestion].correct : null,
    timeLeft,
    isPaused,
    roomCode: ROOM_CODE
  });
}

function advanceToNextQuestion() {
  if (currentQuestion + 1 >= questions.length) {
    revealAnswer = true;
    broadcast();
    if (teacherSocketId) {
      const ts = io.sockets.sockets.get(teacherSocketId);
      if (ts) saveResultsToPDF(ts);
    }
    return;
  }
  startQuestion(currentQuestion + 1);
  io.emit('new-question');
}

function startQuestion(index) {
  if (index < 0 || index >= questions.length) return;
  currentQuestion = index;
  quizStarted = true;
  answered = {};
  revealAnswer = false;
  isTransitioning = false;
  
  clearInterval(timerInterval);
  timeLeft = questions[index].timeLimit;
  isPaused = false;
  
  broadcast();

  // Server-managed tick timer
  timerInterval = setInterval(() => {
    if (!isPaused && !revealAnswer && !isTransitioning) {
      timeLeft--;
      io.emit('timer-tick', { timeLeft, isPaused });
      
      if (timeLeft <= 0) {
        // Time's up! Auto-reveal and continue after a delay
        revealAnswer = true;
        isTransitioning = true;
        broadcast();
        
        setTimeout(() => {
          advanceToNextQuestion();
        }, 4000); // 4-second delay before moving to the next question
      }
    }
  }, 1000);
}

io.on('connection', (socket) => {
  // Send current room code immediately so teacher panel can display it
  socket.emit('room-info', { roomCode: ROOM_CODE });

  socket.on('teacher:claim', (passkey) => {
    if (String(passkey || '').trim() !== TEACHER_PASSKEY) {
      socket.emit('teacher:denied', 'Wrong teacher passkey.');
      return;
    }
    teacherSocketId = socket.id;
    socket.emit('teacher:granted', { roomCode: ROOM_CODE });
  });

  socket.on('teacher:load-questions', (newQuestions) => {
    if (socket.id !== teacherSocketId) return;
    if (Array.isArray(newQuestions) && newQuestions.length > 0) {
      questions = newQuestions; 
      currentQuestion = -1;
      quizStarted = false;
      answered = {};
      revealAnswer = false;
      clearInterval(timerInterval);
      
      Object.keys(players).forEach(id => players[id].score = 0);
      io.emit('new-question');
      broadcast();
      socket.emit('teacher:questions-loaded');
    }
  });

  socket.on('teacher:save', () => {
    if (socket.id !== teacherSocketId) return;
    saveResultsToPDF(socket); 
  });

  socket.on('join', (data) => {
    const cleanName = String(data.name || '').trim().slice(0, 20);
    const code = String(data.code || '').trim().toUpperCase();

    if (code !== ROOM_CODE) {
      socket.emit('error-message', 'Invalid Room Code!');
      return;
    }
    if (!cleanName) {
      socket.emit('error-message', 'Invalid name.');
      return;
    }
    
    if (persistentScores[cleanName] === undefined) {
      persistentScores[cleanName] = 0;
    }
    
    players[socket.id] = { name: cleanName, score: persistentScores[cleanName] };
    socket.emit('joined', { name: cleanName });
    broadcast();
  });

  socket.on('teacher:start', () => {
    if (socket.id !== teacherSocketId) return;
    startQuestion(0);
    io.emit('new-question');
  });

  socket.on('teacher:next', () => {
    if (socket.id !== teacherSocketId) return;
    clearInterval(timerInterval);
    advanceToNextQuestion();
  });

  socket.on('teacher:reveal', () => {
    if (socket.id !== teacherSocketId) return;
    revealAnswer = true;
    broadcast();
  });

  socket.on('teacher:toggle-pause', () => {
    if (socket.id !== teacherSocketId) return;
    isPaused = !isPaused;
    io.emit('timer-tick', { timeLeft, isPaused });
    broadcast();
  });

  socket.on('teacher:reset', () => {
    if (socket.id !== teacherSocketId) return;
    clearInterval(timerInterval);
    ROOM_CODE = Math.random().toString(36).substring(2, 6).toUpperCase(); // Gen new room code on reset
    currentQuestion = -1;
    quizStarted = false;
    answered = {};
    revealAnswer = false;
    isTransitioning = false;
    Object.keys(players).forEach(id => players[id].score = 0);
    persistentScores = {};
    io.emit('new-question');
    broadcast();
  });

  socket.on('answer', index => {
    if (!quizStarted || currentQuestion < 0 || revealAnswer || isTransitioning || isPaused) return;
    if (!players[socket.id]) return;
    if (answered[socket.id]) return;

    const q = questions[currentQuestion];
    const isCorrect = Number(index) === q.correct;

    answered[socket.id] = { index: Number(index), isCorrect };

    // Flat scoring based solely on correctness
    if (isCorrect) {
      players[socket.id].score += 1; 
      persistentScores[players[socket.id].name] = players[socket.id].score; 
    }

    broadcast();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    delete answered[socket.id];
    if (teacherSocketId === socket.id) teacherSocketId = null;
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
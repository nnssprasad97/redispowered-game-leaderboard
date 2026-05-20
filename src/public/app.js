// API and SSE Connection Configs
const API_BASE = '';
let eventSource = null;
let activeSession = null;
let activeRoundTimer = null;

// On Load
document.addEventListener('DOMContentLoaded', () => {
  checkApiHealth();
  initSession();
  fetchLeaderboard();
  connectSSE();
  
  // Refresh leaderboard every 10 seconds as a fallback
  setInterval(fetchLeaderboard, 10000);
  setInterval(checkApiHealth, 5000);
});

// Switch between Player and Admin tabs
window.switchTab = function(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active-content'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  
  document.getElementById(tabId).classList.add('active-content');
  event.currentTarget.classList.add('active');
};

// Check Health of the Backend API
async function checkApiHealth() {
  const statusBadge = document.getElementById('api-status');
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (res.ok) {
      statusBadge.className = 'status-badge online';
      statusBadge.innerHTML = '<span class="dot"></span> API: Online';
    } else {
      throw new Error();
    }
  } catch (err) {
    statusBadge.className = 'status-badge offline';
    statusBadge.innerHTML = '<span class="dot"></span> API: Offline';
  }
}

// Initialize session from localStorage
function initSession() {
  const storedSession = localStorage.getItem('redis_game_session');
  if (storedSession) {
    try {
      activeSession = JSON.parse(storedSession);
      showActiveSession(activeSession);
    } catch (e) {
      localStorage.removeItem('redis_game_session');
    }
  }
}

// Show active session UI
function showActiveSession(session) {
  document.getElementById('session-badge').className = 'badge badge-active';
  document.getElementById('session-badge').innerText = 'Session Active';
  
  document.getElementById('display-userId').innerText = session.userId;
  document.getElementById('display-sessionId').innerText = session.sessionId.substring(0, 8) + '...';
  document.getElementById('display-ip').innerText = session.ipAddress;
  document.getElementById('display-device').innerText = session.deviceType;
  
  document.getElementById('session-login-form').classList.add('hidden');
  document.getElementById('session-active-info').classList.remove('hidden');
  
  // Also populate user ID in other fields
  document.getElementById('scorePlayerId').value = session.userId;
  document.getElementById('inspectPlayerId').value = session.userId;
  
  // Enable answering if round is active
  checkQuizFormState();
}

// Logout session
window.logoutSession = async function() {
  if (activeSession) {
    try {
      // Invalidate on backend
      await fetch(`${API_BASE}/api/admin/sessions/${activeSession.sessionId}`, {
        method: 'DELETE'
      });
    } catch (error) {
      console.error('Error logging out from server:', error);
    }
  }
  
  activeSession = null;
  localStorage.removeItem('redis_game_session');
  
  document.getElementById('session-badge').className = 'badge expired';
  document.getElementById('session-badge').innerText = 'No Active Session';
  
  document.getElementById('session-login-form').classList.remove('hidden');
  document.getElementById('session-active-info').classList.add('hidden');
  
  checkQuizFormState();
};

// Create Player Session
window.handleCreateSession = async function() {
  const userId = document.getElementById('userId').value.trim();
  const deviceType = document.getElementById('deviceType').value;
  const ipAddress = document.getElementById('ipAddress').value.trim();
  
  if (!userId) {
    alert('Please enter a username');
    return;
  }
  
  try {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, deviceType, ipAddress })
    });
    
    if (res.ok) {
      const data = await res.json();
      activeSession = {
        sessionId: data.sessionId,
        userId,
        deviceType,
        ipAddress
      };
      
      localStorage.setItem('redis_game_session', JSON.stringify(activeSession));
      showActiveSession(activeSession);
      addTickerEvent({
        type: 'session',
        message: `Session initialized for <strong>${userId}</strong>. Old sessions invalidated atomically.`
      });
    } else {
      const data = await res.json();
      alert(`Error creating session: ${data.error || 'Unknown error'}`);
    }
  } catch (error) {
    alert('Failed to connect to API server.');
  }
};

// Fetch Leaderboard
window.fetchLeaderboard = async function() {
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard/top/10`);
    if (res.ok) {
      const data = await res.json();
      const tbody = document.getElementById('leaderboard-body');
      
      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="loading">No scores recorded yet.</td></tr>';
        return;
      }
      
      tbody.innerHTML = '';
      data.forEach(player => {
        let rankClass = '';
        let rankIcon = '';
        if (player.rank === 1) {
          rankClass = 'rank-gold';
          rankIcon = '<i class="fa-solid fa-medal"></i> ';
        } else if (player.rank === 2) {
          rankClass = 'rank-silver';
          rankIcon = '<i class="fa-solid fa-medal"></i> ';
        } else if (player.rank === 3) {
          rankClass = 'rank-bronze';
          rankIcon = '<i class="fa-solid fa-medal"></i> ';
        }
        
        tbody.innerHTML += `
          <tr>
            <td class="rank-col ${rankClass}">${rankIcon}${player.rank}</td>
            <td><strong>${player.playerId}</strong></td>
            <td class="score-col">${player.score} pts</td>
          </tr>
        `;
      });
    }
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
  }
};

// Inspect Specific Player Rank
window.inspectPlayerRank = async function() {
  const playerId = document.getElementById('inspectPlayerId').value.trim();
  const inspectResult = document.getElementById('inspect-result');
  
  if (!playerId) {
    alert('Enter a Player ID to inspect');
    return;
  }
  
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard/player/${playerId}`);
    if (res.ok) {
      const data = await res.json();
      
      document.getElementById('inspect-rank').innerText = `#${data.rank}`;
      document.getElementById('inspect-score').innerText = `${data.score} pts`;
      document.getElementById('inspect-percentile').innerText = `${data.percentile}%`;
      
      const aboveList = document.getElementById('nearby-above');
      const belowList = document.getElementById('nearby-below');
      
      aboveList.innerHTML = data.nearbyPlayers.above.length 
        ? data.nearbyPlayers.above.map(p => `<li><span>#${p.rank} ${p.playerId}</span><strong>${p.score}</strong></li>`).join('')
        : '<li class="helper-text text-center">None (Top Player)</li>';
        
      belowList.innerHTML = data.nearbyPlayers.below.length 
        ? data.nearbyPlayers.below.map(p => `<li><span>#${p.rank} ${p.playerId}</span><strong>${p.score}</strong></li>`).join('')
        : '<li class="helper-text text-center">None (Bottom Player)</li>';
        
      inspectResult.classList.remove('hidden');
    } else {
      const data = await res.json();
      alert(data.error || 'Player not found on leaderboard.');
      inspectResult.classList.add('hidden');
    }
  } catch (error) {
    alert('Error connecting to API.');
  }
};

// Seed Quiz Round
window.seedTestRound = async function() {
  const gameId = document.getElementById('gameId').value.trim();
  const roundId = document.getElementById('roundId').value.trim();
  
  try {
    const res = await fetch(`${API_BASE}/api/admin/rounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId,
        roundId,
        durationSeconds: 60,
        correctAnswer: 'Redis',
        points: 15
      })
    });
    
    if (res.ok) {
      const data = await res.json();
      startRoundCountdown(data.endTime);
      addTickerEvent({
        type: 'round',
        message: `Quiz round seeded! <strong>${gameId}:${roundId}</strong> is active for 60 seconds.`
      });
    } else {
      alert('Failed to seed round');
    }
  } catch (error) {
    alert('API connection failed');
  }
};

// Start Round Countdown timer
function startRoundCountdown(endTimeMs) {
  if (activeRoundTimer) {
    clearInterval(activeRoundTimer);
  }
  
  const badge = document.getElementById('quiz-badge');
  badge.className = 'badge badge-success';
  
  checkQuizFormState(true);
  
  activeRoundTimer = setInterval(() => {
    const timeLeft = Math.max(0, Math.round((endTimeMs - Date.now()) / 1000));
    if (timeLeft > 0) {
      badge.innerText = `Active: ${timeLeft}s left`;
    } else {
      badge.className = 'badge badge-expired';
      badge.innerText = 'Round Expired';
      checkQuizFormState(false);
      clearInterval(activeRoundTimer);
    }
  }, 1000);
}

// Enable/Disable Quiz input based on session and round state
function checkQuizFormState(isRoundActive = false) {
  const ansInput = document.getElementById('quizAnswer');
  const submitBtn = document.getElementById('quiz-submit-btn');
  
  if (activeSession && isRoundActive) {
    ansInput.removeAttribute('disabled');
    submitBtn.removeAttribute('disabled');
  } else {
    ansInput.setAttribute('disabled', 'true');
    submitBtn.setAttribute('disabled', 'true');
  }
}

// Submit Quiz Answer
window.handleQuizSubmit = async function(event) {
  event.preventDefault();
  
  if (!activeSession) {
    alert('Please create a session first.');
    return;
  }
  
  const gameId = document.getElementById('gameId').value.trim();
  const roundId = document.getElementById('roundId').value.trim();
  const answer = document.getElementById('quizAnswer').value.trim();
  const resultBanner = document.getElementById('quiz-result-banner');
  
  resultBanner.className = 'result-banner hidden';
  
  try {
    const res = await fetch(`${API_BASE}/api/game/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId,
        roundId,
        playerId: activeSession.userId,
        answer
      })
    });
    
    const data = await res.json();
    
    if (res.ok && data.status === 'SUCCESS') {
      resultBanner.className = 'result-banner success';
      resultBanner.innerHTML = `<i class="fa-solid fa-circle-check"></i> Answer recorded! New score: <strong>${data.newScore} pts</strong>`;
      // Clear answer field
      document.getElementById('quizAnswer').value = '';
    } else {
      resultBanner.className = 'result-banner error';
      if (data.code === 'DUPLICATE_SUBMISSION') {
        resultBanner.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Already submitted an answer for this round.`;
      } else if (data.code === 'ROUND_EXPIRED') {
        resultBanner.innerHTML = `<i class="fa-solid fa-clock"></i> Submission failed: Round has ended.`;
      } else {
        resultBanner.innerHTML = `<i class="fa-solid fa-circle-exmark"></i> Submission error: ${data.code || 'Unknown'}`;
      }
    }
    resultBanner.classList.remove('hidden');
  } catch (error) {
    resultBanner.className = 'result-banner error';
    resultBanner.innerText = 'Failed to send answer to API.';
    resultBanner.classList.remove('hidden');
  }
};

// Manual Score Increment
window.handleManualScoreUpdate = async function() {
  const playerId = document.getElementById('scorePlayerId').value.trim();
  const points = parseInt(document.getElementById('scorePoints').value, 10);
  
  if (!playerId || isNaN(points)) {
    alert('Invalid Player ID or Points');
    return;
  }
  
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, points })
    });
    
    if (res.ok) {
      const data = await res.json();
      addTickerEvent({
        type: 'score',
        message: `Admin manually added <strong>${points} pts</strong> to <strong>${playerId}</strong>. Total: <strong>${data.newScore} pts</strong>.`
      });
    } else {
      alert('Failed to update score.');
    }
  } catch (e) {
    alert('API connection error.');
  }
};

// Admin Console: Query active sessions for a user ID
window.queryAdminSessions = async function() {
  const userId = document.getElementById('adminUserId').value.trim();
  
  if (!userId) {
    alert('Please enter a user ID');
    return;
  }
  
  try {
    const res = await fetch(`${API_BASE}/api/admin/sessions/user/${userId}`);
    if (res.ok) {
      const data = await res.json();
      
      document.getElementById('admin-session-count').innerText = data.length;
      const tbody = document.getElementById('admin-sessions-body');
      tbody.innerHTML = '';
      
      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center helper-text">No active sessions for this user.</td></tr>';
      } else {
        data.forEach(s => {
          tbody.innerHTML += `
            <tr>
              <td class="code-span">${s.sessionId.substring(0, 8)}...</td>
              <td>${s.deviceType}</td>
              <td>${s.ipAddress}</td>
              <td>${new Date(s.lastActive).toLocaleTimeString()}</td>
              <td>
                <button class="btn btn-outline btn-sm pink-text" onclick="invalidateSessionByAdmin('${s.sessionId}')">
                  <i class="fa-solid fa-trash-can"></i> Invalidate
                </button>
              </td>
            </tr>
          `;
        });
      }
      
      document.getElementById('admin-sessions-container').classList.remove('hidden');
    } else {
      alert('Failed to fetch user sessions.');
    }
  } catch (error) {
    alert('Connection error.');
  }
};

// Admin: Invalidate specific session ID
window.invalidateSessionByAdmin = async function(sessionId) {
  if (!confirm('Are you sure you want to terminate this session?')) return;
  
  try {
    const res = await fetch(`${API_BASE}/api/admin/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    
    if (res.status === 204) {
      // If we invalidated our own active session, clear local UI
      if (activeSession && activeSession.sessionId === sessionId) {
        logoutSession();
      }
      // Re-query admin table
      queryAdminSessions();
      addTickerEvent({
        type: 'admin',
        message: `Session <span class="code-span">${sessionId.substring(0, 8)}...</span> was terminated by admin.`
      });
    } else {
      alert('Failed to delete session.');
    }
  } catch (error) {
    alert('API request failed.');
  }
};

// Setup SSE Connections
function connectSSE() {
  const statusBadge = document.getElementById('sse-status');
  
  if (eventSource) {
    eventSource.close();
  }
  
  eventSource = new EventSource(`${API_BASE}/api/events`);
  
  eventSource.onopen = () => {
    statusBadge.className = 'status-badge online';
    statusBadge.innerHTML = '<span class="dot"></span> SSE Stream: Connected';
    console.log('SSE connection established');
  };
  
  eventSource.onerror = (err) => {
    statusBadge.className = 'status-badge offline';
    statusBadge.innerHTML = '<span class="dot"></span> SSE Stream: Disconnected';
    console.error('SSE connection error, retrying...');
    setTimeout(connectSSE, 5000); // retry
  };
  
  // Real-time Leaderboard Update Broadcast
  eventSource.addEventListener('leaderboard_updated', (e) => {
    try {
      const data = JSON.parse(e.data);
      console.log('Leaderboard Update Event:', data);
      
      // Refresh leaderboard data
      fetchLeaderboard();
      
      // If inspecting the updated player, refresh details
      const inspectedPlayer = document.getElementById('inspectPlayerId').value.trim();
      if (inspectedPlayer === data.playerId) {
        inspectPlayerRank();
      }
      
      addTickerEvent({
        type: 'score-up',
        message: `Player <strong>${data.playerId}</strong> score updated to <strong>${data.newScore} pts</strong>!`
      });
    } catch (err) {
      console.error(err);
    }
  });
  
  // Real-time Quiz Submission Event (Ticker)
  eventSource.addEventListener('answer_submitted', (e) => {
    try {
      const data = JSON.parse(e.data);
      const isCorrectText = data.isCorrect 
        ? '<span class="green-text"><i class="fa-solid fa-circle-check"></i> CORRECT</span>'
        : '<span class="pink-text"><i class="fa-solid fa-circle-xmark"></i> INCORRECT</span>';
      
      addTickerEvent({
        type: data.isCorrect ? 'correct' : 'incorrect',
        message: `Player <strong>${data.playerId}</strong> submitted answer for <strong>${data.gameId}:${data.roundId}</strong>: ${isCorrectText}`
      });
    } catch (err) {
      console.error(err);
    }
  });
}

// Add event item to live ticker feed
function addTickerEvent({ type, message }) {
  const feed = document.getElementById('ticker-feed');
  const placeholder = feed.querySelector('.ticker-placeholder');
  
  if (placeholder) {
    placeholder.remove();
  }
  
  const item = document.createElement('div');
  item.className = `ticker-item ${type}`;
  
  const time = new Date().toLocaleTimeString();
  item.innerHTML = `
    <span>${message}</span>
    <span class="ticker-time">${time}</span>
  `;
  
  feed.insertBefore(item, feed.firstChild);
  
  // Limit to last 30 events in UI
  while (feed.childNodes.length > 30) {
    feed.removeChild(feed.lastChild);
  }
}

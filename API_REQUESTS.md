# API Reference & Sample Requests

This document outlines the API endpoints, their request formats, and example response payloads for the Redis Trivia Arena.

By default, the server runs on port `3000` (locally or via Docker). If you are using port `3001` or another configuration, adjust the URLs accordingly.

---

## 🟢 1. System Health

### GET `/health`
Returns the status of the API server and its connection to the Redis database.

*   **Request**:
    ```bash
    curl -X GET http://localhost:3000/health
    ```
*   **Response (200 OK)**:
    ```json
    {
      "status": "OK",
      "redis": "CONNECTED"
    }
    ```

---

## 🔑 2. Session Management

### POST `/api/sessions`
Creates an active session for a player. If other active sessions exist for this user ID, they are terminated atomically.

*   **Request**:
    ```bash
    curl -X POST http://localhost:3000/api/sessions \
      -H "Content-Type: application/json" \
      -d '{
        "userId": "player-omega",
        "ipAddress": "192.168.1.45",
        "deviceType": "mobile-ios"
      }'
    ```
*   **Response (201 Created)**:
    ```json
    {
      "message": "Session established",
      "sessionId": "4db75c91-9c86-4e58-9ff1-6d7c88b2a1a8",
      "userId": "player-omega"
    }
    ```

---

## 🏆 3. Leaderboard Endpoints

### POST `/api/leaderboard/scores`
Directly increments a player's score on the global leaderboard (typically an admin or background worker event).

*   **Request**:
    ```bash
    curl -X POST http://localhost:3000/api/leaderboard/scores \
      -H "Content-Type: application/json" \
      -d '{
        "playerId": "player-omega",
        "points": 25
      }'
    ```
*   **Response (200 OK)**:
    ```json
    {
      "message": "Score updated",
      "playerId": "player-omega",
      "newScore": 25
    }
    ```

### GET `/api/leaderboard/top/:count`
Retrieves the top list of players, sorted by rank (descending score).

*   **Request**:
    ```bash
    curl -X GET http://localhost:3000/api/leaderboard/top/3
    ```
*   **Response (200 OK)**:
    ```json
    [
      { "rank": 1, "playerId": "super-star", "score": 450 },
      { "rank": 2, "playerId": "quiz-master", "score": 380 },
      { "rank": 3, "playerId": "player-omega", "score": 25 }
    ]
    ```

### GET `/api/leaderboard/player/:playerId`
Inspects a specific player's position, score, percentile, and retrieves neighboring players.

*   **Request**:
    ```bash
    curl -X GET http://localhost:3000/api/leaderboard/player/quiz-master
    ```
*   **Response (200 OK)**:
    ```json
    {
      "playerId": "quiz-master",
      "score": 380,
      "rank": 2,
      "percentile": 66.67,
      "nearbyPlayers": {
        "above": [
          { "rank": 1, "playerId": "super-star", "score": 450 }
        ],
        "below": [
          { "rank": 3, "playerId": "player-omega", "score": 25 }
        ]
      }
    }
    ```

---

## 🎮 4. Trivia Game submissions

### POST `/api/admin/rounds` (Seed Round)
Seeds a game round configuration in Redis.

*   **Request**:
    ```bash
    curl -X POST http://localhost:3000/api/admin/rounds \
      -H "Content-Type: application/json" \
      -d '{
        "gameId": "game-77",
        "roundId": "round-04",
        "durationSeconds": 60,
        "correctAnswer": "Redis",
        "points": 15
      }'
    ```
*   **Response (201 Created)**:
    ```json
    {
      "message": "Round round-04 seeded for game game-77",
      "endTime": 1779282318000
    }
    ```

### POST `/api/game/submit` (Answer Quiz)
Atomically processes a player's round submission.

*   **Request**:
    ```bash
    curl -X POST http://localhost:3000/api/game/submit \
      -H "Content-Type: application/json" \
      -d '{
        "gameId": "game-77",
        "roundId": "round-04",
        "playerId": "player-omega",
        "answer": "Redis"
      }'
    ```
*   **Response (200 OK - Correct Answer)**:
    ```json
    {
      "status": "SUCCESS",
      "isCorrect": true,
      "newScore": 40
    }
    ```

*   **Response (400 Bad Request - Duplicate submission)**:
    ```json
    {
      "status": "ERROR",
      "code": "DUPLICATE_SUBMISSION",
      "message": "Player has already submitted an answer for this round"
    }
    ```

*   **Response (403 Forbidden - Round Expired)**:
    ```json
    {
      "status": "ERROR",
      "code": "ROUND_EXPIRED",
      "message": "Round has expired or does not exist"
    }
    ```

---

## 📡 5. Real-Time Event Stream

### GET `/api/events` (SSE Connection)
Establishes a Server-Sent Events stream. Keep connection open to receive broadcast events.

*   **Request**:
    ```bash
    curl -N http://localhost:3000/api/events
    ```
*   **Stream output (Sample text/event-stream)**:
    ```text
    event: connected
    data: {"message":"SSE Connection Established"}

    event: answer_submitted
    data: {"gameId":"game-77","roundId":"round-04","playerId":"player-omega","isCorrect":true}

    event: leaderboard_updated
    data: {"playerId":"player-omega","newScore":40}
    ```

---

## 🛠️ 6. Session Administration

### GET `/api/admin/sessions/user/:userId`
Lists all active session metadata indexed for a specific user.

*   **Request**:
    ```bash
    curl -X GET http://localhost:3000/api/admin/sessions/user/player-omega
    ```
*   **Response (200 OK)**:
    ```json
    [
      {
        "sessionId": "4db75c91-9c86-4e58-9ff1-6d7c88b2a1a8",
        "userId": "player-omega",
        "ipAddress": "192.168.1.45",
        "deviceType": "mobile-ios",
        "createdAt": "2026-05-20T12:00:00.000Z",
        "lastActive": "2026-05-20T12:00:00.000Z"
      }
    ]
    ```

### DELETE `/api/admin/sessions/:sessionId`
Invalidates a session ID, terminating it immediately.

*   **Request**:
    ```bash
    curl -X DELETE http://localhost:3000/api/admin/sessions/4db75c91-9c86-4e58-9ff1-6d7c88b2a1a8
    ```
*   **Response (204 No Content)**:
    *(No response body)*

import asyncio
import base64
import json
import os
from datetime import datetime, timedelta
import sqlite3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import pyaudio
import wave
import speech_recognition as sr

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# Configuración de audio
CHUNK = 1024
FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 44100

# Lista de clientes conectados
clients = {}
users = {}

# Funciones de base de datos
def init_db():
    conn = sqlite3.connect("history.db")
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS messages 
                 (id INTEGER PRIMARY KEY, user_id TEXT, audio BLOB, text TEXT, timestamp TEXT, date TEXT)''')
    conn.commit()
    conn.close()

def save_message(user_id, audio_data, text, timestamp):
    date = datetime.utcnow().strftime("%Y-%m-%d")
    conn = sqlite3.connect("history.db")
    c = conn.cursor()
    c.execute("INSERT INTO messages (user_id, audio, text, timestamp, date) VALUES (?, ?, ?, ?, ?)",
              (user_id, audio_data, text, timestamp, date))
    conn.commit()
    conn.close()

def get_history():
    conn = sqlite3.connect("history.db")
    c = conn.cursor()
    c.execute("SELECT user_id, audio, text, timestamp, date FROM messages ORDER BY date, timestamp")
    rows = c.fetchall()
    conn.close()
    return [{"user_id": row[0], "audio": base64.b64encode(row[1]).decode('utf-8'), 
             "text": row[2], "timestamp": row[3], "date": row[4]} for row in rows]

# Funciones de audio
def record_audio(filename, duration=None):
    p = pyaudio.PyAudio()
    stream = p.open(format=FORMAT, channels=CHANNELS, rate=RATE, input=True, frames_per_buffer=CHUNK)
    frames = []
    if duration:
        for _ in range(0, int(RATE / CHUNK * duration)):
            data = stream.read(CHUNK)
            frames.append(data)
    else:
        while True:
            data = stream.read(CHUNK)
            frames.append(data)
            break  # Simplificado para este ejemplo, controlado por frontend
    stream.stop_stream()
    stream.close()
    p.terminate()
    wf = wave.open(filename, 'wb')
    wf.setnchannels(CHANNELS)
    wf.setsampwidth(p.get_sample_size(FORMAT))
    wf.setframerate(RATE)
    wf.writeframes(b''.join(frames))
    wf.close()

def play_audio(data):
    p = pyaudio.PyAudio()
    stream = p.open(format=FORMAT, channels=CHANNELS, rate=RATE, output=True)
    stream.write(data)
    stream.stop_stream()
    stream.close()
    p.terminate()

# Inicializar base de datos
init_db()

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await websocket.accept()
    clients[user_id] = {"ws": websocket, "muted": False}
    users[user_id] = {"name": user_id.split("_")[1]}
    await broadcast_users()
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message["type"] == "register":
                users[user_id]["name"] = message["name"]
                await broadcast_users()
            
            elif message["type"] == "audio":
                audio_data = base64.b64decode(message["data"])
                timestamp = datetime.utcnow().strftime("%H:%M")
                
                # Speech-to-Text con CMU Sphinx
                recognizer = sr.Recognizer()
                audio_file = "temp.wav"
                with open(audio_file, "wb") as f:
                    f.write(audio_data)
                with sr.AudioFile(audio_file) as source:
                    audio = recognizer.record(source)
                try:
                    text = recognizer.recognize_sphinx(audio)
                except sr.UnknownValueError:
                    text = "No se pudo transcribir"
                os.remove(audio_file)
                
                # Guardar en base de datos
                save_message(user_id, audio_data, text, timestamp)
                
                # Enviar a todos los clientes no muteados
                for client_id, client in clients.items():
                    if client_id != user_id and not client["muted"]:
                        await client["ws"].send_text(json.dumps({
                            "type": "audio",
                            "data": message["data"],
                            "text": text,
                            "timestamp": timestamp,
                            "sender": users[user_id]["name"]
                        }))
            
            elif message["type"] == "mute":
                clients[user_id]["muted"] = True
            elif message["type"] == "unmute":
                clients[user_id]["muted"] = False
            
    except WebSocketDisconnect:
        del clients[user_id]
        del users[user_id]
        await broadcast_users()

async def broadcast_users():
    user_count = len(clients)
    user_list = [users[uid]["name"] for uid in users]
    for client in clients.values():
        await client["ws"].send_text(json.dumps({
            "type": "users",
            "count": user_count,
            "list": user_list
        }))

@app.get("/history")
async def get_history_endpoint():
    return get_history()

async def clear_messages():
    while True:
        now = datetime.utcnow()
        start_time = datetime.utcnow().replace(hour=5, minute=30, second=0, microsecond=0)
        if now.hour >= 14 or (now.hour == 5 and now.minute >= 30):
            start_time += timedelta(days=1)
        await asyncio.sleep((start_time - now).total_seconds())

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(clear_messages())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

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
import logging
from pydub import AudioSegment

app = FastAPI()
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Alfabeto ICAO
ICAO_ALPHABET = {
    'A': 'Alfa', 'B': 'Bravo', 'C': 'Charlie', 'D': 'Delta', 'E': 'Echo',
    'F': 'Foxtrot', 'G': 'Golf', 'H': 'Hotel', 'I': 'India', 'J': 'Juliett',
    'K': 'Kilo', 'L': 'Lima', 'M': 'Mike', 'N': 'November', 'O': 'Oscar',
    'P': 'Papa', 'Q': 'Quebec', 'R': 'Romeo', 'S': 'Sierra', 'T': 'Tango',
    'U': 'Uniform', 'V': 'Victor', 'W': 'Whiskey', 'X': 'X-ray', 'Y': 'Yankee',
    'Z': 'Zulu'
}

def to_icao(text):
    return ' '.join(ICAO_ALPHABET.get(char.upper(), char) for char in text if char.isalpha())

CHUNK = 1024
FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 44100

clients = {}
users = {}

@app.get("/")
async def root():
    return {"message": "HANDLEPHONE is running"}

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

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await websocket.accept()
    logger.info(f"Cliente conectado: {user_id}")
    clients[user_id] = {"ws": websocket, "muted": False}
    users[user_id] = {"name": user_id.split("_")[1], "matricula": "LV-000UN", "matricula_icao": to_icao("LV-000UN")}
    await broadcast_users()
    
    try:
        while True:
            data = await websocket.receive_text()
            logger.info(f"Mensaje recibido de {user_id}: {data}")
            message = json.loads(data)
            
            if message["type"] == "register":
                try:
                    legajo = message.get("legajo", "000")
                    name = message.get("name", "Unknown")
                    matricula = f"LV-{str(legajo)[:3]}{name[:2].upper()}"
                    users[user_id] = {
                        "name": name,
                        "matricula": matricula,
                        "matricula_icao": to_icao(matricula)
                    }
                    logger.info(f"Usuario registrado: {user_id} - {matricula}")
                    await broadcast_users()
                except Exception as e:
                    logger.error(f"Error en registro: {str(e)}")
            
            elif message["type"] == "audio":
                try:
                    audio_data = base64.b64decode(message["data"])
                    timestamp = datetime.utcnow().strftime("%H:%M")
                    raw_audio_file = "raw_temp.webm"
                    wav_audio_file = "temp.wav"
                    with open(raw_audio_file, "wb") as f:
                        f.write(audio_data)
                    
                    audio = AudioSegment.from_file(raw_audio_file)
                    audio.export(wav_audio_file, format="wav")
                    
                    recognizer = sr.Recognizer()
                    with sr.AudioFile(wav_audio_file) as source:
                        audio = recognizer.record(source)
                    try:
                        text = recognizer.recognize_sphinx(audio)
                        logger.info(f"Texto transcrito para {user_id}: {text}")
                    except sr.UnknownValueError:
                        text = "No se pudo transcribir"
                        logger.info(f"Error: No se pudo transcribir el audio para {user_id}")
                    
                    os.remove(raw_audio_file)
                    os.remove(wav_audio_file)
                    
                    save_message(user_id, audio_data, text, timestamp)
                    
                    for client_id, client in clients.items():
                        if client_id != user_id and not client["muted"]:
                            await client["ws"].send_text(json.dumps({
                                "type": "audio",
                                "data": message["data"],
                                "text": text,
                                "timestamp": timestamp,
                                "sender": users[user_id]["name"],
                                "matricula": users[user_id]["matricula"],
                                "matricula_icao": users[user_id]["matricula_icao"]
                            }))
                except Exception as e:
                    logger.error(f"Error procesando audio para {user_id}: {str(e)}")
            
            elif message["type"] == "mute":
                clients[user_id]["muted"] = True
            elif message["type"] == "unmute":
                clients[user_id]["muted"] = False
            
    except WebSocketDisconnect:
        del clients[user_id]
        del users[user_id]
        await broadcast_users()
        logger.info(f"Cliente desconectado: {user_id}")
    except Exception as e:
        logger.error(f"Error en WebSocket para {user_id}: {str(e)}")

async def broadcast_users():
    user_count = len(clients)
    user_list = [f"{users[uid]['name']} ({users[uid]['matricula']})" for uid in users]
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
    init_db()
    asyncio.create_task(clear_messages())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

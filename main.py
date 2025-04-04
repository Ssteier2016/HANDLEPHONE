import asyncio
import base64
import json
import os
from datetime import datetime, timedelta
import sqlite3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import logging
import requests

app = FastAPI()
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

OPENSKY_URL = "https://opensky-network.org/api/states/all"
OPENSKY_PARAMS = {
    "lamin": -55.0, "lamax": -22.0, "lomin": -73.0, "lomax": -53.0
}

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

clients = {}  # {user_id: {"ws": WebSocket, "muted": bool}}
users = {}   # {user_id: {"name": str, "matricula": str, "matricula_icao": str, "logged_in": bool}}
active_sessions = {}  # Para persistir sesiones

@app.get("/opensky")
async def get_opensky_data():
    try:
        response = requests.get(OPENSKY_URL, params=OPENSKY_PARAMS)
        if response.status_code == 200:
            data = response.json()
            logger.info("Datos de OpenSky obtenidos correctamente (anónimo)")
            return data["states"]
        else:
            logger.error(f"Error en OpenSky API: {response.status_code}")
            return {"error": f"Error: {response.status_code}"}
    except Exception as e:
        logger.error(f"Error al obtener datos de OpenSky: {str(e)}")
        return {"error": str(e)}

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
    if user_id not in users:
        users[user_id] = {"name": user_id.split("_")[1], "matricula": "00000", "matricula_icao": to_icao("LV-00000"), "logged_in": True}
        active_sessions[user_id] = True
    await broadcast_users()
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            logger.info(f"Mensaje recibido de {user_id}: {data[:50]}...")
            
            if message["type"] == "register":
                legajo = message.get("legajo", "00000")
                name = message.get("name", "Unknown")
                matricula = f"{str(legajo)[:5]}"
                users[user_id] = {
                    "name": name,
                    "matricula": matricula,
                    "matricula_icao": to_icao(matricula),
                    "logged_in": True
                }
                active_sessions[user_id] = True
                await broadcast_users()
            
            elif message["type"] == "audio":
                audio_data = base64.b64decode(message["data"])
                timestamp = datetime.utcnow().strftime("%H:%M")
                text = "Sin transcripción"  # Placeholder hasta agregar Vosk
                
                save_message(user_id, audio_data, text, timestamp)
                
                for client_id, client in list(clients.items()):
                    if client_id != user_id and not client["muted"] and users[client_id]["logged_in"]:
                        await client["ws"].send_text(json.dumps({
                            "type": "audio",
                            "data": message["data"],
                            "text": text,
                            "timestamp": timestamp,
                            "sender": users[user_id]["name"],
                            "matricula": users[user_id]["matricula"],
                            "matricula_icao": users[user_id]["matricula_icao"]
                        }))
                        logger.info(f"Audio retransmitido a {client_id}")
            
            elif message["type"] == "logout":
                users[user_id]["logged_in"] = False
                active_sessions[user_id] = False
                del clients[user_id]
                await broadcast_users()
                await websocket.close()
                logger.info(f"Usuario {user_id} cerró sesión")
                break
            
            elif message["type"] == "mute":
                clients[user_id]["muted"] = True
            elif message["type"] == "unmute":
                clients[user_id]["muted"] = False
            
    except WebSocketDisconnect:
        if user_id in clients:
            del clients[user_id]
        # No eliminamos de users/active_sessions para persistir la sesión
        logger.info(f"Cliente desconectado: {user_id}, sesión sigue activa")
        await broadcast_users()

async def broadcast_users():
    user_count = len([u for u in users if users[u]["logged_in"]])
    user_list = [f"{users[uid]['name']} ({users[uid]['matricula']})" for uid in users if users[uid]["logged_in"]]
    for client in list(clients.values()):
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

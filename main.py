import asyncio
import base64
import json
import os
import time
from datetime import datetime, timedelta
import sqlite3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import logging
import aiohttp  # Reemplazamos requests por aiohttp para Airplanes.Live
from vosk import Model, KaldiRecognizer

# ↓↓↓ AGREGADO PARA DESCARGA AUTOMÁTICA DEL MODELO ↓↓↓
import gdown
import zipfile

MODEL_FOLDER = "Model/vosk-model-es-0.42"
MODEL_ZIP = "Model/vosk-model-es-0.42.zip"
GOOGLE_DRIVE_URL = "https://drive.google.com/uc?id=1A5Coj8R7G0gA9FYF8HdGq5f67TJuePAd"  # URL directa para gdown

if not os.path.exists(MODEL_FOLDER):
    print("🛠️ Modelo Vosk no encontrado. Descargando desde Google Drive...")
    os.makedirs("Model", exist_ok=True)
    gdown.download(GOOGLE_DRIVE_URL, MODEL_ZIP, quiet=False)

    print("📦 Descomprimiendo modelo...")
    if zipfile.is_zipfile(MODEL_ZIP):
        with zipfile.ZipFile(MODEL_ZIP, 'r') as zip_ref:
            zip_ref.extractall("Model")
        print("✅ Modelo descargado y descomprimido correctamente.")
    else:
        print("❌ El archivo descargado no es un zip válido.")
        exit(1)
else:
    print("✅ Modelo Vosk ya está disponible.")
# ↑↑↑ FIN BLOQUE DE DESCARGA ↑↑↑

app = FastAPI()
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Cargar index.html para la ruta raíz
with open("templates/index.html", "r") as f:
    INDEX_HTML = f.read()

@app.get("/", response_class=HTMLResponse)
async def read_root():
    return INDEX_HTML

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ICAO_ALPHABET = {
    'A': 'Alfa', 'B': 'Bravo', 'C': 'Charlie', 'D': 'Delta', 'E': 'Echo',
    'F': 'Foxtrot', 'G': 'Golf', 'H': 'Hotel', 'I': 'India', 'J': 'Juliett',
    'K': 'Kilo', 'L': 'Lima', 'M': 'Mike', 'N': 'November', 'O': 'Oscar',
    'P': 'Papa', 'Q': 'Quebec', 'R': 'Romeo', 'S': 'Sierra', 'T': 'Tango',
    'U': 'Uniform', 'V': 'Victor', 'W': 'Whiskey', 'X': 'X-ray', 'Y': 'Yankee',
    'Z': 'Zulu'
}

try:
    model = Model("C:/Users/Georgiana/Desktop/PROYECTO HANDY HANLDE/Model/vosk-model-es-0.42")
except Exception as e:
    logger.error(f"No se pudo cargar el modelo Vosk: {str(e)}")
    model = None

def to_icao(text):
    return ' '.join(ICAO_ALPHABET.get(char.upper(), char) for char in text if char.isalpha())

clients = {}
users = {}
active_sessions = {}
audio_queue = asyncio.Queue()

last_request_time = 0
cached_data = None
CACHE_DURATION = 15  # Aumentado a 15 segundos para evitar saturación

@app.get("/opensky")
async def get_airplanes_live_data():
    global last_request_time, cached_data
    current_time = time.time()
    if current_time - last_request_time < CACHE_DURATION and cached_data:
        logger.info("Devolviendo datos en caché")
        return cached_data
    try:
        url = "https://api.airplanes.live/v2/point/-34.5597/-58.4116/250"  # 250 millas desde Aeroparque
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status == 200:
                    data = await response.json()
                    cached_data = data.get("ac", [])  # Lista de aviones
                    last_request_time = current_time
                    logger.info("Datos de Airplanes.Live obtenidos correctamente")
                    return cached_data
                else:
                    logger.error(f"Error al obtener datos de Airplanes.Live: {response.status}")
                    return {"error": f"Error: {response.status}"}
    except Exception as e:
        logger.error(f"Error al obtener datos de Airplanes.Live: {str(e)}")
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

async def process_audio_queue():
    recognizer = KaldiRecognizer(model, 16000) if model else None
    while True:
        user_id, audio_data, message = await audio_queue.get()
        timestamp = datetime.utcnow().strftime("%H:%M")
        text = "Sin transcripción"
        if recognizer and recognizer.AcceptWaveform(audio_data):
            result = json.loads(recognizer.Result())
            text = result.get("text", "No se pudo transcribir")
        
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
        audio_queue.task_done()

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
                await audio_queue.put((user_id, audio_data, message))
            
            elif message["type"] == "logout":
                users[user_id]["logged_in"] = False
                active_sessions[user_id] = False
                if user_id in clients:
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
        users[user_id]["logged_in"] = False
        active_sessions[user_id] = False
        logger.info(f"Cliente desconectado: {user_id}, sesión cerrada")
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
    asyncio.create_task(process_audio_queue())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

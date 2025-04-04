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
from vosk import Model, KaldiRecognizer

app = FastAPI()
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Credenciales de OpenSky Network (reemplazá con las tuyas)
url = "https://opensky-network.org/api/states/all"
params = {
    "lamin": -40.0,  # Latitud mínima (ajustado para Argentina)
    "lamax": -20.0,  # Latitud máxima
    "lomin": -70.0,  # Longitud mínima
    "lomax": -50.0   # Longitud máxima
}

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

clients = {}
users = {}
model = Model("model")

# Configurar modelo Vosk
MODEL_PATH = "vosk-model-small-es-0.42"
if not os.path.exists(MODEL_PATH):
    logger.info("Descargando modelo Vosk para español...")
    try:
        os.system("wget https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip -O vosk-model.zip")
        os.system("unzip vosk-model.zip -d .")
        os.rename("vosk-model-small-es-0.42", MODEL_PATH)  # Asegurar nombre correcto
        os.remove("vosk-model.zip")
    except Exception as e:
        logger.error(f"No se pudo descargar o descomprimir el modelo Vosk: {str(e)}")
        raise RuntimeError("Falta el modelo Vosk y no se pudo descargar")
model = Model(MODEL_PATH)
@app.get("/")

async def root():
    return {"message": "HANDLEPHONE is running"}

@app.get("/opensky")
async def get_opensky_data():
    try:
        response = requests.get(url, params=params)
        if response.status_code == 200:
            data = response.json()
            logger.info("Datos de OpenSky obtenidos correctamente")
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
    users[user_id] = {"name": user_id.split("_")[1], "matricula": "00000", "matricula_icao": to_icao("LV-00000")}
    await broadcast_users()
    
    recognizer = KaldiRecognizer(model, 16000)  # 16kHz para streaming
    
    try:
        while True:
            data = await websocket.receive_text()
            logger.info(f"Mensaje recibido de {user_id}: {data[:50]}...")
            message = json.loads(data)
            
            if message["type"] == "register":
                try:
                    legajo = message.get("legajo", "00000")
                    name = message.get("name", "Unknown")
                    matricula = f"{str(legajo)[:5]}"
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
                    
                    # Procesar audio con Vosk
                    if recognizer.AcceptWaveform(audio_data):
                        result = json.loads(recognizer.Result())
                        text = result.get("text", "No se pudo transcribir")
                        logger.info(f"Texto transcrito para {user_id}: {text}")
                    else:
                        partial = json.loads(recognizer.PartialResult())
                        text = partial.get("partial", "")
                    
                    # Guardar en historial
                    save_message(user_id, audio_data, text, timestamp)
                    
                    # Retransmitir audio y texto en tiempo real
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
                            logger.info(f"Audio retransmitido a {client_id}")
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

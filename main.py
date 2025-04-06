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
import aiohttp
import requests
from bs4 import BeautifulSoup

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

def to_icao(text):
    return ' '.join(ICAO_ALPHABET.get(char.upper(), char) for char in text if char.isalpha())

# Diccionarios para manejar clientes, usuarios y sesiones
clients = {}  # {token: {"ws": WebSocket, "muted": bool}}
users = {}    # {token: {"name": str, "matricula": str, "matricula_icao": str, "logged_in": bool}}
active_sessions = {}  # {token: bool}
audio_queue = asyncio.Queue()

last_request_time = 0
cached_data = None
CACHE_DURATION = 15  # 15 segundos para evitar saturación

# Función para obtener datos de Airplanes.Live
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

# Función para hacer web scraping de TAMS
def scrape_tams_data():
    url = "http://www.tams.com.ar/organismos/vuelos.aspx"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')

        spans = soup.find_all('span')
        flight_data = [span.text.strip() for span in spans if span.text.strip() and " " not in span.text]

        flights = []
        for i in range(0, len(flight_data), 17):
            row = flight_data[i:i+17]
            if len(row) < 17:
                continue

            airline = row[1]
            flight_number = row[2]
            scheduled_time = row[3]
            registration = row[4]
            estimated_time = row[6]
            operation_type = row[8]
            origin_dest = row[11]
            status = row[13]

            if airline == "AR" and "AEP" in origin_dest:
                flights.append({
                    "flight": f"AR{flight_number}",
                    "registration": registration,
                    "scheduled": scheduled_time,
                    "estimated": estimated_time if estimated_time != " " else None,
                    "status": status,
                    "type": "Arrival" if operation_type == "A" else "Departure",
                    "origin_dest": origin_dest
                })

        logger.info(f"Datos scrapeados de TAMS: {len(flights)} vuelos de Aerolíneas Argentinas con AEP encontrados")
        return flights
    except Exception as e:
        logger.error(f"Error al scrapear TAMS: {e}")
        return {"error": str(e)}

@app.get("/opensky")
async def get_opensky_data():
    airplanes_data = await get_airplanes_live_data()
    tams_data = scrape_tams_data()
    
    if isinstance(airplanes_data, dict) and "error" in airplanes_data:
        return airplanes_data
    if isinstance(tams_data, dict) and "error" in tams_data:
        return tams_data

    combined_data = []
    for plane in airplanes_data:
        flight = plane.get("flight", "").strip()
        registration = plane.get("r", "").strip()
        if flight and flight.startswith("ARG"):
            plane_info = {
                "flight": flight,
                "registration": registration,
                "lat": plane.get("lat"),
                "lon": plane.get("lon"),
                "alt_geom": plane.get("alt_geom"),
                "gs": plane.get("gs"),
                "vert_rate": plane.get("vert_rate")
            }
            for tams_flight in tams_data:
                if tams_flight["registration"] == registration:
                    plane_info.update({
                        "scheduled": tams_flight["scheduled"],
                        "estimated": tams_flight["estimated"],
                        "status": tams_flight["status"],
                        "type": tams_flight["type"],
                        "origin_dest": tams_flight["origin_dest"]
                    })
                    break
            combined_data.append(plane_info)
    
    for tams_flight in tams_data:
        if not any(plane["registration"] == tams_flight["registration"] for plane in combined_data):
            combined_data.append({
                "flight": tams_flight["flight"],
                "registration": tams_flight["registration"],
                "scheduled": tams_flight["scheduled"],
                "estimated": tams_flight["estimated"],
                "status": tams_flight["status"],
                "type": tams_flight["type"],
                "origin_dest": tams_flight["origin_dest"],
                "lat": None, "lon": None, "alt_geom": None, "gs": None, "vert_rate": None
            })

    return combined_data

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
    while True:
        token, audio_data, message = await audio_queue.get()
        timestamp = datetime.utcnow().strftime("%H:%M")
        text = message.get("text", "Sin transcripción")  # Usar el texto enviado desde el cliente
        user_id = users.get(token, {}).get("name", "Anónimo")
        save_message(user_id, audio_data, text, timestamp)
        
        for client_token, client in list(clients.items()):
            if client_token != token and not client["muted"] and users[client_token]["logged_in"]:
                await client["ws"].send_text(json.dumps({
                    "type": "audio",
                    "data": message["data"],
                    "text": text,
                    "timestamp": timestamp,
                    "sender": users[token]["name"],
                    "matricula": users[token]["matricula"],
                    "matricula_icao": users[token]["matricula_icao"]
                }))
                logger.info(f"Audio retransmitido a {client_token}")
        audio_queue.task_done()

@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    logger.info(f"Cliente conectado con token: {token}")
    clients[token] = {"ws": websocket, "muted": False}
    
    # Si el token ya existe, restaurar la sesión; si no, inicializar
    if token not in users:
        users[token] = {
            "name": "Anónimo",
            "matricula": "00000",
            "matricula_icao": to_icao("LV-00000"),
            "logged_in": True
        }
        active_sessions[token] = True
    else:
        users[token]["logged_in"] = True
        active_sessions[token] = True
    await broadcast_users()
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            logger.info(f"Mensaje recibido de {token}: {data[:50]}...")
            
            if message["type"] == "register":
                name = message.get("name", "Anónimo")
                legajo = message.get("legajo", "00000")
                matricula = f"LV-{str(legajo)[:5]}"
                users[token] = {
                    "name": name,
                    "matricula": matricula,
                    "matricula_icao": to_icao(matricula),
                    "logged_in": True
                }
                active_sessions[token] = True
                await broadcast_users()
            
            elif message["type"] == "audio":
                audio_data = base64.b64decode(message["data"])
                await audio_queue.put((token, audio_data, message))
            
            elif message["type"] == "logout":
                if token in users:
                    users[token]["logged_in"] = False
                    active_sessions[token] = False
                if token in clients:
                    del clients[token]
                await broadcast_users()
                await websocket.close()
                logger.info(f"Usuario {token} cerró sesión")
                break
            
            elif message["type"] == "mute":
                if token in clients:
                    clients[token]["muted"] = True
            elif message["type"] == "unmute":
                if token in clients:
                    clients[token]["muted"] = False
            
    except WebSocketDisconnect:
        logger.info(f"Cliente desconectado: {token}")
        # No eliminar al usuario ni cerrar su sesión, solo remover el WebSocket
        if token in clients:
            del clients[token]
        # Mantener la sesión activa para permitir reconexiones
        await broadcast_users()

async def broadcast_users():
    user_count = len([u for u in users if users[u]["logged_in"]])
    user_list = [f"{users[token]['name']} ({users[token]['matricula']})" for token in users if users[token]["logged_in"]]
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

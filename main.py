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
import speech_recognition as sr
import io
import soundfile as sf
from pydub import AudioSegment
# from pywebpush import WebPush

app = FastAPI()
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Cargar index.html para la ruta raíz
with open("templates/index.html", "r") as f:
    INDEX_HTML = f.read()

@app.get("/", response_class=HTMLResponse)
async def read_root():
    return INDEX_HTML

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configurar claves VAPID para notificaciones push
#VAPID_PUBLIC_KEY = "BIu7_BQhrPKB1Q39EcuUWndK5KosDJx9btpAbqr3T6wq6oTb0QqZaMgA2PAmLHVJbRdFU0lxxEs_k4Mh9JJ0fAg"
#VAPID_PRIVATE_KEY = "hcRHiegtjnRTht4MEjqHs0j6u8Pnsti82u7hDXB85y4"
#VAPID_CLAIMS = {"sub": "mailto:rod.arena7@gmail.com"}

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

# Diccionarios para manejar usuarios, sesiones y suscripciones push
users = {}  # {token: {"name": str, "function": str, "logged_in": bool, "websocket": WebSocket (o None), "subscription": push_subscription}}
audio_queue = asyncio.Queue()

last_request_time = 0
cached_data = None
CACHE_DURATION = 15  # 15 segundos para evitar saturación

# Función para transcribir audio usando speech_recognition
async def transcribe_audio(audio_data):
    try:
        audio_bytes = base64.b64decode(audio_data)
        audio_file = io.BytesIO(audio_bytes)
        audio_segment = AudioSegment.from_file(audio_file, format="webm")
        audio_segment = audio_segment.set_channels(1)
        audio_segment = audio_segment.set_frame_rate(16000)
        wav_io = io.BytesIO()
        audio_segment.export(wav_io, format="wav")
        wav_io.seek(0)
        data, samplerate = sf.read(wav_io)
        recognizer = sr.Recognizer()
        with sr.AudioFile(wav_io) as source:
            audio_data = recognizer.record(source)
            text = recognizer.recognize_google(audio_data, language="es-ES")
            logger.info("Audio transcrito exitosamente en el servidor")
            return text
    except sr.UnknownValueError:
        logger.warning("No se pudo transcribir el audio en el servidor")
        return "No se pudo transcribir"
    except sr.RequestError as e:
        logger.error(f"Error en la transcripción en el servidor: {e}")
        return f"Error en la transcripción: {e}"
    except Exception as e:
        logger.error(f"Error al procesar el audio en el servidor: {e}")
        return f"Error al procesar el audio: {e}"
    finally:
        audio_file.close()
        wav_io.close()

# Función para obtener datos de Airplanes.Live
async def get_airplanes_live_data():
    global last_request_time, cached_data
    current_time = time.time()
    if current_time - last_request_time < CACHE_DURATION and cached_data:
        logger.info("Devolviendo datos en caché")
        return cached_data
    try:
        url = "https://api.airplanes Facultad.live/v2/point/-34.5597/-58.4116/250"  # 250 millas desde Aeroparque
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status == 200:
                    data = await response.json()
                    cached_data = data.get("ac", [])
                    last_request_time = current_time
                    logger.info("Datos de Airplanes.Live obtenidos correctamente")
                    return cached_data
                else:
                    logger.error(f"Error al obtener datos de Airplanes.Live: {response.status}")
                    return {"error": f"Error: {response.status}"}
    except Exception as e:
        logger.error(f"Error al obtener datos de Airplanes.Live: {str(e)}")
        return {"error": str(e)}

# Función para hacer web scraping de TAMS (actualizada para vuelos AR)
def scrape_tams():
    url = "http://www.tams.com.ar/ORGANISMOS/Vuelos.aspx"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        flights = []

        # Buscar spans y extraer datos (ajustado según tu ejemplo anterior)
        spans = soup.find_all('span')
        flight_data = [span.text.strip() for span in spans if span.text.strip() and " " not in span.text]

        for i in range(0, len(flight_data), 17):  # Ajustado según estructura observada
            row = flight_data[i:i+17]
            if len(row) < 17:
                continue

            airline = row[1]
            flight_number = row[2]
            scheduled_time = row[3]
            registration = row[4]
            position = row[5] if len(row) > 5 else ""
            destination = row[11] if len(row) > 11 else ""

            if airline == "AR":  # Solo vuelos de Aerolíneas Argentinas
                flights.append({
                    "Vuelo": f"AR{flight_number}",
                    "STD": scheduled_time,
                    "Posicion": position,
                    "Destino": destination,
                    "Matricula": registration if registration != " " else "N/A"
                })

        logger.info(f"Datos scrapeados de TAMS: {len(flights)} vuelos de Aerolíneas Argentinas encontrados")
        return flights
    except Exception as e:
        logger.error(f"Error al scrapear TAMS: {e}")
        return []

# Función para eliminar duplicados
def remove_duplicates(flights):
    seen = set()
    unique_flights = []
    for flight in flights:
        flight_key = (flight["Vuelo"], flight["STD"])
        if flight_key not in seen:
            seen.add(flight_key)
            unique_flights.append(flight)
    return unique_flights

# Función para actualizar vuelos de TAMS cada 5 minutos y emitir a clientes
async def update_tams_flights():
    while True:
        flights = scrape_tams()
        unique_flights = remove_duplicates(flights)
        if unique_flights:
            # Emitir a todos los clientes conectados
            for user in users.values():
                if user["logged_in"] and user["websocket"] is not None:
                    try:
                        await user["websocket"].send_text(json.dumps({
                            "type": "flight_update",
                            "flights": unique_flights
                        }))
                        logger.info(f"Actualización de vuelos enviada a {user['name']}")
                    except Exception as e:
                        logger.error(f"Error al enviar actualización de vuelos: {e}")
                        user["websocket"] = None
            logger.info(f"Enviados {len(unique_flights)} vuelos únicos")
        await asyncio.sleep(300)  # 5 minutos

@app.get("/opensky")
async def get_opensky_data():
    airplanes_data = await get_airplanes_live_data()
    tams_data = scrape_tams()
    
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
                if tams_flight["Matricula"] == registration:
                    plane_info.update({
                        "scheduled": tams_flight["STD"],
                        "position": tams_flight["Posicion"],
                        "destination": tams_flight["Destino"],
                    })
                    break
            combined_data.append(plane_info)
    
    for tams_flight in tams_data:
        if not any(plane["registration"] == tams_flight["Matricula"] for plane in combined_data):
            combined_data.append({
                "flight": tams_flight["Vuelo"],
                "registration": tams_flight["Matricula"],
                "scheduled": tams_flight["STD"],
                "position": tams_flight["Posicion"],
                "destination": tams_flight["Destino"],
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
        try:
            message = await audio_queue.get()
            sender = message.get("sender", "Unknown")
            function = message.get("function", "Unknown")
            text = message.get("text", "Audio message")
            token = message.get("token")

            # Guardar el mensaje en la base de datos
            save_message(sender, function, text, token)

            # Enviar notificación push a los usuarios suscritos
            # for user_token, user in users.items():
            #     if user_token == token:
            #         continue
            #     subscription = user.get("subscription")
            #     if subscription:
            #         try:
            #             WebPush(
            #                 subscription,
            #                 data=json.dumps({
            #                     "type": "audio",
            #                     "sender": sender,
            #                     "function": function,
            #                     "text": text
            #                 }),
            #                 vapid_private_key=VAPID_PRIVATE_KEY,
            #                 vapid_claims={"sub": "mailto:your-email@example.com"}
            #             ).send()
            #         except Exception as e:
            #             logger.error(f"Error sending push notification to {user_token}: {e}")

            # Retransmitir el mensaje a los clientes conectados
            for user_token, user in users.items():
                if user_token == token or user.get("muted", False):
                    continue
                ws = user.get("ws")
                if ws:
                    try:
                        await ws.send_json({
                            "type": "audio",
                            "sender": sender,
                            "function": function,
                            "text": text,
                            "token": token
                        })
                    except Exception as e:
                        logger.error(f"Error broadcasting message to {user_token}: {e}")
        except Exception as e:
            logger.error(f"Error processing audio queue: {e}")
        finally:
            audio_queue.task_done()

@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    logger.info(f"Cliente conectado con token: {token}")

    try:
        user_id = base64.b64decode(token).decode('utf-8')
        if token in users:
            users[token]["websocket"] = websocket
            users[token]["logged_in"] = True
        else:
            users[token] = {
                "name": "Anónimo",
                "function": "Desconocida",
                "logged_in": True,
                "websocket": websocket,
                "muted": False,
                "subscription": None
            }

        await broadcast_users()

        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            logger.info(f"Mensaje recibido de {token}: {data[:50]}...")

            if message["type"] == "register":
                name = message.get("name", "Anónimo")
                function = message.get("function", "Desconocida")
                users[token]["name"] = name
                users[token]["function"] = function
                users[token]["logged_in"] = True
                await broadcast_users()

            elif message["type"] == "subscribe":
                users[token]["subscription"] = message["subscription"]
                logger.info(f"Suscripción push recibida para {token}")

            elif message["type"] == "audio":
                audio_data = base64.b64decode(message["data"])
                await audio_queue.put((token, audio_data, message))

            elif message["type"] == "logout":
                if token in users:
                    users[token]["logged_in"] = False
                    del users[token]
                await broadcast_users()
                await websocket.close()
                logger.info(f"Usuario {token} cerró sesión")
                break

            elif message["type"] == "mute":
                users[token]["muted"] = True
            elif message["type"] == "unmute":
                users[token]["muted"] = False

    except WebSocketDisconnect:
        logger.info(f"Cliente desconectado: {token}")
        if token in users:
            users[token]["websocket"] = None
    except Exception as e:
        logger.error(f"Error en WebSocket para el cliente {token}: {str(e)}", exc_info=True)
        if token in users:
            users[token]["websocket"] = None
        await websocket.close()

async def broadcast_users():
    user_list = []
    for token in users:
        if users[token]["logged_in"]:
            decoded_token = base64.b64decode(token).decode('utf-8')
            legajo, name, _ = decoded_token.split('_', 2)
            user_list.append(f"{users[token]['name']} ({legajo})")
    for user in users.values():
        if user["logged_in"] and user["websocket"] is not None:
            try:
                await user["websocket"].send_text(json.dumps({
                    "type": "users",
                    "count": len(user_list),
                    "list": user_list
                }))
            except Exception as e:
                logger.error(f"Error al enviar lista de usuarios a un cliente: {e}")
                user["websocket"] = None

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
    asyncio.create_task(update_tams_flights())  # Iniciar actualización de vuelos de TAMS

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

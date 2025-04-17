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
import speech_recognition as sr
import io
import soundfile as sf
from pydub import AudioSegment
import math
from dotenv import load_dotenv
from cachetools import TTLCache

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Cargar variables de entorno
load_dotenv()

# Inicializar FastAPI
app = FastAPI()
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Validar clave de AviationStack
AVIATIONSTACK_API_KEY = os.getenv("AVIATIONSTACK_API_KEY")
if not AVIATIONSTACK_API_KEY:
    logger.error("Falta AVIATIONSTACK_API_KEY en las variables de entorno")
    raise ValueError("AVIATIONSTACK_API_KEY no está configurada")

# Cargar index.html
with open("templates/index.html", "r") as f:
    INDEX_HTML = f.read()

@app.get("/", response_class=HTMLResponse)
async def read_root():
    response = HTMLResponse(content=INDEX_HTML)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# Diccionario ICAO para pronunciación fonética
ICAO_ALPHABET = {
    'Alfa': 'A', 'Bravo': 'B', 'Charlie': 'C', 'Delta': 'D', 'Echo': 'E',
    'Foxtrot': 'F', 'G': 'Golf', 'H': 'Hotel', 'I': 'India', 'J': 'Juliett',
    'K': 'Kilo', 'L': 'Lima', 'M': 'Mike', 'N': 'November', 'O': 'Oscar',
    'P': 'Papa', 'Q': 'Quebec', 'R': 'Romeo', 'S': 'Sierra', 'T': 'Tango',
    'U': 'Uniform', 'V': 'Victor', 'W': 'Whiskey', 'X': 'X-ray', 'Y': 'Yankee',
    'Z': 'Zulu'
}

def to_icao(text):
    """Convierte texto a pronunciación ICAO (ej. 'AR123' -> 'Alfa Romeo')."""
    return ' '.join(ICAO_ALPHABET.get(char.upper(), char) for char in text if char.isalpha())

# Estructuras de datos
users = {}  # Dict[token, Dict[str, Any]]: Almacena info de usuarios en memoria
audio_queue = asyncio.Queue()  # Cola para procesar audio asincrónicamente
groups = {}  # Dict[group_id, List[token]]: Grupos de usuarios
flights_cache = []  # Cache global para vuelos combinados (OpenSky + AviationStack)
global_mute_active = False  # Estado de muteo general

# Cache para datos de OpenSky
opensky_cache = TTLCache(maxsize=1, ttl=15)  # 15 segundos

# Función para filtrar vuelos cerca de Aeroparque
def is_near_aeroparque(lat, lon, max_distance_km=1500):
    """Verifica si un vuelo está a menos de max_distance_km de Aeroparque (AEP)."""
    aep_lat, aep_lon = -34.6084, -58.3732
    dlat = math.radians(lat - aep_lat)
    dlon = math.radians(lon - aep_lon)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(aep_lat)) * math.cos(math.radians(lat)) * math.sin(dlon/2)**2
    c = 2 * math.asin(math.sqrt(a))
    distance_km = 6371 * c
    return distance_km <= max_distance_km

# Función unificada para obtener vuelos de AviationStack
async def fetch_aviationstack_flights(flight_type="partidas", airport="Aeroparque, AEP"):
    """Obtiene vuelos de AviationStack para partidas o llegadas."""
    flight_type_param = "dep_iata" if flight_type.lower() == "partidas" else "arr_iata"
    airport_code = airport.split(", ")[1] if ", " in airport else "AEP"
    url = "http://api.aviationstack.com/v1/flights"
    params = {
        "access_key": AVIATIONSTACK_API_KEY,
        flight_type_param: airport_code,
        "airline_iata": "AR",
        "limit": 100
    }
    retries = 5
    for attempt in range(retries):
        async with aiohttp.ClientSession() as session:
            try:
                async with session.get(url, params=params, timeout=15) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        logger.error(f"Error AviationStack ({flight_type}, intento {attempt+1}): {response.status} {error_text}")
                        if response.status == 429:
                            await asyncio.sleep(2 ** attempt)
                            continue
                        return []
                    data = await response.json()
                    flights = []
                    for flight in data.get("data", []):
                        airline = flight.get("airline")
                        if not airline or airline.get("iata") != "AR":
                            logger.debug(f"Vuelo descartado (sin airline o no AR): {flight.get('flight', {}).get('iata', 'N/A')}")
                            continue
                        status = flight.get("flight_status")
                        if status is None:
                            logger.warning(f"Vuelo sin flight_status: {flight.get('flight', {}).get('iata', 'N/A')}")
                            continue
                        if status.lower() == "cancelled":
                            continue
                        status_map = {
                            "scheduled": "Estimado",
                            "active": "En vuelo",
                            "landed": "Aterrizado",
                            "delayed": "Demorado",
                            "departed": "Despegado"
                        }
                        status_text = status_map.get(status.lower(), status.capitalize())
                        flight_number = flight.get("flight", {}).get("iata", "")
                        scheduled_time = flight.get(f"{flight_type_param.replace('_iata', '')}_scheduled_time", "")
                        origin = flight.get("arrival", {}).get("iata", "N/A") if flight_type_param == "arr_iata" else "N/A"
                        destination = flight.get("departure", {}).get("iata", "N/A") if flight_type_param == "dep_iata" else "N/A"
                        gate = flight.get(f"{flight_type_param.replace('_iata', '')}", {}).get("gate", "N/A")
                        flights.append({
                            "Vuelo": flight_number,
                            "STD": scheduled_time,
                            "Destino": destination if flight_type_param == "dep_iata" else origin,
                            "Estado": status_text,
                            "Posicion": gate,
                            "Matricula": "N/A"
                        })
                    logger.info(f"Obtenidos {len(flights)} vuelos de {flight_type}")
                    return flights
            except Exception as e:
                logger.error(f"Error AviationStack ({flight_type}, intento {attempt+1}): {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** attempt)
                else:
                    return []
    return []

# Función para obtener datos de OpenSky Network
async def get_opensky_data():
    """Obtiene datos de vuelos cerca de Aeroparque desde OpenSky Network."""
    if "data" in opensky_cache:
        logger.info("Devolviendo datos en caché de OpenSky")
        return opensky_cache["data"]
    try:
        # Definir área alrededor de Aeroparque (lat: -34.6084, lon: -58.3732)
        url = "https://opensky-network.org/api/states/all"
        params = {
            "lamin": -35.6084,  # Latitud mínima
            "lomin": -59.3732,  # Longitud mínima
            "lamax": -33.6084,  # Latitud máxima
            "lomax": -57.3732   # Longitud máxima
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, timeout=10) as response:
                if response.status == 200:
                    data = await response.json()
                    states = data.get("states", [])
                    arrivals = await fetch_aviationstack_flights(flight_type="llegadas")
                    departures = await fetch_aviationstack_flights(flight_type="partidas")
                    tams_data = arrivals + departures
                    combined_data = []
                    for state in states:
                        icao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_altitude, on_ground, velocity, true_track, vertical_rate, sensors, geo_altitude, squawk, spi, position_source = state[:17]
                        callsign = callsign.strip() if callsign else ""
                        if callsign and callsign.startswith("ARG"):
                            flight_info = {
                                "flight": callsign,
                                "registration": icao24,
                                "lat": lat,
                                "lon": lon,
                                "alt_geom": geo_altitude,
                                "gs": velocity * 1.94384 if velocity else None,  # Convertir m/s a nudos
                                "vert_rate": vertical_rate,
                                "origin_dest": "N/A",
                                "heading": true_track
                            }
                            for tams_flight in tams_data:
                                if tams_flight["Vuelo"] == callsign:
                                    flight_info.update({
                                        "scheduled": tams_flight["STD"],
                                        "position": tams_flight["Posicion"],
                                        "destination": tams_flight["Destino"],
                                        "status": tams_flight["Estado"]
                                    })
                                    break
                            combined_data.append(flight_info)
                    # Añadir vuelos de AviationStack sin datos de OpenSky
                    for tams_flight in tams_data:
                        if not any(plane["flight"] == tams_flight["Vuelo"] for plane in combined_data):
                            combined_data.append({
                                "flight": tams_flight["Vuelo"],
                                "registration": tams_flight["Matricula"],
                                "scheduled": tams_flight["STD"],
                                "position": tams_flight["Posicion"],
                                "destination": tams_flight["Destino"],
                                "status": tams_flight["Estado"],
                                "lat": None,
                                "lon": None,
                                "alt_geom": None,
                                "gs": None,
                                "vert_rate": None,
                                "origin_dest": None,
                                "heading": None
                            })
                    opensky_cache["data"] = combined_data
                    logger.info(f"Datos de OpenSky: {len(combined_data)} vuelos")
                    return combined_data
                else:
                    logger.error(f"Error OpenSky: {response.status}")
                    return []
    except Exception as e:
        logger.error(f"Error al obtener OpenSky: {str(e)}")
        return []

# Actualizar vuelos AviationStack
async def update_flights():
    """Actualiza el caché de vuelos de AviationStack."""
    global flights_cache
    while True:
        flights = []
        for flight_type in ["llegadas", "partidas"]:
            flights.extend(await fetch_aviationstack_flights(flight_type=flight_type))
        flights_cache = remove_duplicates(flights)
        if not flights_cache:
            logger.warning("No se encontraron vuelos de AviationStack")
        await asyncio.sleep(300)  # 5 minutos

# Actualizar vuelos OpenSky periódicamente
async def update_flights_periodically():
    """Actualiza el caché de vuelos de OpenSky y los envía a los clientes cada 10 segundos."""
    global flights_cache
    while True:
        try:
            flights = await get_opensky_data()
            flights_cache.clear()
            flights_cache.extend(flights)
            disconnected_users = []
            for token, user in users.items():
                if not user["logged_in"] or not user["websocket"]:
                    disconnected_users.append(token)
                    continue
                try:
                    await user["websocket"].send_json({
                        "type": "flight_update",
                        "flights": flights
                    })
                    logger.info(f"Actualización de vuelos enviada a {user['name']}")
                except Exception as e:
                    logger.error(f"Error enviando vuelos a {user['name']}: {e}")
                    disconnected_users.append(token)
            for token in disconnected_users:
                if token in users:
                    users[token]["websocket"] = None
                    users[token]["logged_in"] = False
                    logger.info(f"Usuario {token} marcado como desconectado")
            if disconnected_users:
                await broadcast_users()
        except Exception as e:
            logger.error(f"Error actualizando vuelos: {e}")
        await asyncio.sleep(10)  # 10 segundos

# Función para transcribir audio
async def transcribe_audio(audio_data):
    """Transcribe audio WebM a texto usando Google Speech Recognition."""
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
            text = recognizer.recognize_google(audio_data, language="es-ES", timeout=10)
            logger.info("Audio transcrito exitosamente")
            return text
    except sr.UnknownValueError:
        logger.warning("No se pudo transcribir el audio")
        return "Transcripción no disponible"
    except sr.RequestError as e:
        logger.error(f"Error en la transcripción: {e}")
        return "Transcripción no disponible"
    except Exception as e:
        logger.error(f"Error al procesar el audio: {e}")
        return "Transcripción no disponible"
    finally:
        audio_file.close()
        wav_io.close()

# Función para procesar consultas de búsqueda
async def process_search_query(query, flights):
    """Busca vuelos según la consulta del usuario."""
    query = query.lower().strip()
    results = []
    for flight in flights:
        if (query in flight["flight"].lower() or
            query in flight["destination"].lower() or
            query in flight["status"].lower() or
            "ar" + query in flight["flight"].lower()):
            results.append(flight)
    if not results:
        return "No se encontraron vuelos para tu consulta."
    return ", ".join([f"{f['flight']} a {f['destination']}, {f['status']}" for f in results])

# Función para eliminar duplicados
def remove_duplicates(flights):
    """Elimina vuelos duplicados basándose en flight y STD."""
    seen = set()
    unique_flights = []
    for flight in flights:
        flight_key = (flight["flight"], flight["scheduled"])
        if flight_key not in seen:
            seen.add(flight_key)
            unique_flights.append(flight)
    return unique_flights

@app.get("/opensky")
async def get_opensky_data_endpoint():
    """Endpoint para obtener datos combinados de OpenSky y AviationStack."""
    data = await get_opensky_data()
    logger.info(f"Datos combinados: {len(data)} vuelos")
    return data

def init_db():
    """Inicializa la base de datos para mensajes y sesiones."""
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS messages 
                 (id INTEGER PRIMARY KEY, user_id TEXT, audio TEXT, text TEXT, timestamp TEXT, date TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS sessions 
                 (token TEXT PRIMARY KEY, user_id TEXT, name TEXT, function TEXT, group_id TEXT, 
                  muted_users TEXT, last_active TIMESTAMP)''')
    conn.commit()
    conn.close()

def save_session(token, user_id, name, function, group_id=None, muted_users=None):
    """Guarda o actualiza una sesión en la base de datos."""
    muted_users_str = json.dumps(list(muted_users or set()))
    last_active = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute('''INSERT OR REPLACE INTO sessions 
                 (token, user_id, name, function, group_id, muted_users, last_active) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)''',
              (token, user_id, name, function, group_id, muted_users_str, last_active))
    conn.commit()
    conn.close()
    logger.info(f"Sesión guardada para token={token}")

def load_session(token):
    """Carga una sesión desde la base de datos."""
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute("SELECT user_id, name, function, group_id, muted_users, last_active FROM sessions WHERE token = ?",
              (token,))
    row = c.fetchone()
    conn.close()
    if row:
        user_id, name, function, group_id, muted_users_str, last_active = row
        try:
            muted_users = set(json.loads(muted_users_str))
        except json.JSONDecodeError:
            muted_users = set()
        return {
            "user_id": user_id,
            "name": name,
            "function": function,
            "group_id": group_id,
            "muted_users": muted_users,
            "last_active": last_active
        }
    return None

def delete_session(token):
    """Elimina una sesión de la base de datos."""
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()
    conn.close()
    logger.info(f"Sesión eliminada para token={token}")

def save_message(user_id, audio_data, text, timestamp):
    """Guarda un mensaje en la base de datos."""
    date = datetime.utcnow().strftime("%Y-%m-%d")
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute("INSERT INTO messages (user_id, audio, text, timestamp, date) VALUES (?, ?, ?, ?, ?)",
              (user_id, audio_data, text, timestamp, date))
    conn.commit()
    conn.close()
    logger.info(f"Mensaje guardado: user_id={user_id}, timestamp={timestamp}")

def get_history():
    """Obtiene el historial de mensajes."""
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute("SELECT user_id, audio, text, timestamp, date FROM messages ORDER BY date, timestamp")
    rows = c.fetchall()
    conn.close()
    return [{"user_id": row[0], "audio": row[1], "text": row[2], "timestamp": row[3], "date": row[4]} for row in rows]

async def process_audio_queue():
    """Procesa la cola de audio para transcripción y difusión."""
    while True:
        try:
            item = await audio_queue.get()
            if not isinstance(item, tuple) or len(item) != 3:
                logger.error(f"Elemento mal formado en audio_queue: {item}")
                audio_queue.task_done()
                continue
            token, audio_data, message = item

            sender = message.get("sender", "Unknown")
            function = message.get("function", "Unknown")
            text = message.get("text", "Sin transcripción")
            timestamp = message.get("timestamp", datetime.utcnow().strftime("%H:%M"))

            logger.info(f"Procesando audio de {sender} ({function})")

            if global_mute_active:
                logger.info("Muteo global activo, audio no transmitido")
                await broadcast_message({
                    "type": "mute_notification",
                    "message": "Muteo global activo, audio no transmitido"
                })
                audio_queue.task_done()
                continue

            if text == "Sin transcripción" or text == "Pendiente de transcripción":
                logger.info("Transcribiendo audio...")
                try:
                    text = await transcribe_audio(audio_data)
                    logger.info(f"Transcripción: {text}")
                except Exception as e:
                    logger.error(f"Error al transcribir audio: {e}")
                    text = "Error en transcripción"

            user_id = f"{sender}_{function}"
            try:
                save_message(user_id, audio_data, text, timestamp)
            except Exception as e:
                logger.error(f"Error al guardar mensaje: {e}")

            broadcast_message = {
                "type": "audio",
                "sender": sender,
                "function": function,
                "text": text,
                "timestamp": timestamp,
                "data": audio_data
            }
            disconnected_users = []
            for user_token, user in list(users.items()):
                if user_token == token:
                    continue
                if not user["logged_in"] or not user["websocket"]:
                    disconnected_users.append(user_token)
                    continue
                muted_users = user.get("muted_users", set())
                sender_id = f"{sender}_{function}"
                if sender_id in muted_users:
                    logger.info(f"{sender_id} muteado por {user['name']}")
                    continue
                try:
                    await user["websocket"].send_json(broadcast_message)
                    logger.info(f"Mensaje audio enviado a {user['name']}")
                except Exception as e:
                    logger.error(f"Error al enviar a {user['name']} ({user_token}): {e}")
                    disconnected_users.append(user_token)

            for user_token in disconnected_users:
                if user_token in users:
                    users[user_token]["websocket"] = None
                    users[user_token]["logged_in"] = False
                    logger.info(f"Usuario {user_token} marcado como desconectado")
            if disconnected_users:
                await broadcast_users()

        except asyncio.CancelledError:
            logger.info("Tarea de audio queue cancelada")
            raise
        except Exception as e:
            logger.error(f"Error procesando audio queue: {e}")
        finally:
            audio_queue.task_done()

async def clean_expired_sessions():
    """Elimina sesiones inactivas (más de 24 horas) de la base de datos."""
    while True:
        try:
            conn = sqlite3.connect("chat_history.db")
            c = conn.cursor()
            expiration_time = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
            c.execute("DELETE FROM sessions WHERE last_active < ?", (expiration_time,))
            conn.commit()
            deleted = c.rowcount
            if deleted > 0:
                logger.info(f"Eliminadas {deleted} sesiones expiradas")
            conn.close()
        except Exception as e:
            logger.error(f"Error al limpiar sesiones: {e}")
        await asyncio.sleep(3600)

@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    """Maneja conexiones WebSocket para comunicación en tiempo real."""
    await websocket.accept()
    logger.info(f"Cliente conectado: {token}")

    global global_mute_active

    try:
        session = load_session(token)
        user_id = base64.b64decode(token).decode('utf-8', errors='ignore')
        if session:
            users[token] = {
                "user_id": session["user_id"],
                "name": session["name"],
                "function": session["function"],
                "logged_in": True,
                "websocket": websocket,
                "muted_users": session["muted_users"],
                "subscription": None,
                "group_id": session["group_id"]
            }
            if session["group_id"] and session["group_id"] not in groups:
                groups[session["group_id"]] = []
            if session["group_id"] and token not in groups[session["group_id"]]:
                groups[session["group_id"]].append(token)
            logger.info(f"Sesión restaurada para {session['name']} ({token})")
        else:
            users[token] = {
                "user_id": user_id,
                "name": "Anónimo",
                "function": "Desconocida",
                "logged_in": True,
                "websocket": websocket,
                "muted_users": set(),
                "subscription": None,
                "group_id": None
            }
            save_session(token, user_id, "Anónimo", "Desconocida")
            logger.info(f"Nueva sesión creada para {token}")

        await websocket.send_json({"type": "connection_success", "message": "Conectado"})
        await websocket.send_json({"type": "flight_update", "flights": flights_cache})
        await broadcast_users()

        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
                logger.info(f"Mensaje recibido de {token}: {data[:50]}...")
            except json.JSONDecodeError as e:
                logger.error(f"Error decodificando mensaje de {token}: {e}")
                continue

            if message["type"] == "ping":
                await websocket.send_json({"type": "pong"})
                save_session(
                    token,
                    users[token]["user_id"],
                    users[token]["name"],
                    users[token]["function"],
                    users[token]["group_id"],
                    users[token]["muted_users"]
                )
                continue

            elif message["type"] == "register":
                name = message.get("name", "Anónimo")
                function = message.get("function", "Desconocida")
                users[token]["name"] = name
                users[token]["function"] = function
                users[token]["logged_in"] = True
                save_session(token, user_id, name, function, users[token]["group_id"], users[token]["muted_users"])
                await websocket.send_json({"type": "register_success", "message": "Registro exitoso"})
                await broadcast_users()

            elif message["type"] == "subscribe":
                users[token]["subscription"] = message["subscription"]

            elif message["type"] == "audio":
                audio_data = message.get("data")
                if not audio_data:
                    logger.error("Audio sin datos")
                    continue
                await audio_queue.put((token, audio_data, message))

            elif message["type"] == "logout":
                group_id = users[token]["group_id"]
                if group_id and group_id in groups:
                    if token in groups[group_id]:
                        groups[group_id].remove(token)
                    if not groups[group_id]:
                        del groups[group_id]
                users[token]["logged_in"] = False
                delete_session(token)
                if token in users:
                    del users[token]
                await websocket.send_json({"type": "logout_success", "message": "Sesión cerrada"})
                await broadcast_users()
                await websocket.close()
                break

            elif message["type"] == "mute_user":
                target_user_id = message.get("target_user_id")
                if target_user_id:
                    users[token]["muted_users"].add(target_user_id)
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        users[token]["group_id"],
                        users[token]["muted_users"]
                    )

            elif message["type"] == "unmute_user":
                target_user_id = message.get("target_user_id")
                if target_user_id:
                    users[token]["muted_users"].discard(target_user_id)
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        users[token]["group_id"],
                        users[token]["muted_users"]
                    )

            elif message["type"] == "mute_all":
                global_mute_active = True
                await broadcast_global_mute_state("mute_all_success", "Muteo global activado")

            elif message["type"] == "unmute_all":
                global_mute_active = False
                await broadcast_global_mute_state("unmute_all_success", "Muteo global desactivado")

            elif message["type"] == "mute":
                await websocket.send_json({"type": "mute_success", "message": "Mute activado"})

            elif message["type"] == "unmute":
                await websocket.send_json({"type": "unmute_success", "message": "Mute desactivado"})

            elif message["type"] == "create_group":
                group_id = message["group_id"]
                is_private = message.get("is_private", False)
                if group_id not in groups:
                    groups[group_id] = []
                    groups[group_id].append(token)
                    users[token]["group_id"] = group_id
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        group_id,
                        users[token]["muted_users"]
                    )
                    await websocket.send_json({
                        "type": "create_group_success",
                        "group_id": group_id,
                        "is_private": is_private
                    })
                    await broadcast_users()
                else:
                    await websocket.send_json({
                        "type": "create_group_error",
                        "message": "El grupo ya existe"
                    })

            elif message["type"] == "join_group":
                group_id = message["group_id"]
                is_private = message.get("is_private", False)
                if group_id not in groups:
                    groups[group_id] = []
                if token not in groups[group_id]:
                    groups[group_id].append(token)
                users[token]["group_id"] = group_id
                save_session(
                    token,
                    users[token]["user_id"],
                    users[token]["name"],
                    users[token]["function"],
                    group_id,
                    users[token]["muted_users"]
                )
                await websocket.send_json({
                    "type": "join_group",
                    "group_id": group_id,
                    "is_private": is_private
                })
                await broadcast_users()

            elif message["type"] == "leave_group":
                group_id = users[token]["group_id"]
                if group_id and group_id in groups:
                    if token in groups[group_id]:
                        groups[group_id].remove(token)
                    if not groups[group_id]:
                        del groups[group_id]
                    users[token]["group_id"] = None
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        None,
                        users[token]["muted_users"]
                    )
                    await websocket.send_json({
                        "type": "leave_group_success",
                        "group_id": group_id
                    })
                    await broadcast_users()

            elif message["type"] == "check_group":
                group_id = message["group_id"]
                in_group = False
                if group_id in groups and token in groups[group_id]:
                    in_group = True
                await websocket.send_json({
                    "type": "check_group",
                    "group_id": group_id,
                    "in_group": in_group
                })

            elif message["type"] == "group_message":
                group_id = users[token]["group_id"]
                if group_id and group_id in groups:
                    audio_data = message.get("data")
                    if not audio_data:
                        logger.error("Grupo mensaje sin audio")
                        continue
                    text = message.get("text", "Sin transcripción")
                    timestamp = message.get("timestamp", datetime.utcnow().strftime("%H:%M"))

                    if text == "Sin transcripción" or text == "Pendiente de transcripción":
                        try:
                            text = await transcribe_audio(audio_data)
                        except Exception as e:
                            logger.error(f"Error al transcribir audio de grupo: {e}")
                            text = "Error en transcripción"

                    user_id = f"{users[token]['name']}_{users[token]['function']}"
                    try:
                        save_message(user_id, audio_data, f"[Grupo {group_id}] {text}", timestamp)
                    except Exception as e:
                        logger.error(f"Error al guardar mensaje grupo: {e}")

                    broadcast_message = {
                        "type": "group_message",
                        "sender": users[token]["name"],
                        "function": users[token]["function"],
                        "text": text,
                        "timestamp": timestamp,
                        "data": audio_data,
                        "group_id": group_id
                    }
                    disconnected_users = []
                    for user_token in groups[group_id]:
                        if user_token == token:
                            continue
                        if user_token in users:
                            user = users[user_token]
                            muted_users = user.get("muted_users", set())
                            sender_id = f"{users[token]['name']}_{users[token]['function']}"
                            if sender_id in muted_users:
                                continue
                            ws = user.get("websocket")
                            if ws and user["logged_in"]:
                                try:
                                    await ws.send_json(broadcast_message)
                                except Exception as e:
                                    logger.error(f"Error al enviar grupo a {user['name']}: {e}")
                                    disconnected_users.append(user_token)

                    for user_token in disconnected_users:
                        if user_token in users:
                            users[user_token]["websocket"] = None
                            users[user_token]["logged_in"] = False
                    if disconnected_users:
                        await broadcast_users()

            elif message["type"] == "search_query":
                response = await process_search_query(message["query"], flights_cache)
                await websocket.send_json({"type": "search_response", "message": response})

    except WebSocketDisconnect:
        logger.info(f"Cliente desconectado: {token}")
        if token in users:
            users[token]["websocket"] = None
            users[token]["logged_in"] = False
            await broadcast_users()
            save_session(
                token,
                users[token]["user_id"],
                users[token]["name"],
                users[token]["function"],
                users[token]["group_id"],
                users[token]["muted_users"]
            )
    except Exception as e:
        logger.error(f"Error WebSocket {token}: {str(e)}")
        if token in users:
            users[token]["websocket"] = None
            users[token]["logged_in"] = False
            await broadcast_users()
            save_session(
                token,
                users[token]["user_id"],
                users[token]["name"],
                users[token]["function"],
                users[token]["group_id"],
                users[token]["muted_users"]
            )
        await websocket.close()

async def broadcast_global_mute_state(message_type, message_text):
    """Difunde el estado de muteo global a todos los usuarios conectados."""
    disconnected_users = []
    for user in list(users.values()):
        if user["logged_in"] and user["websocket"]:
            try:
                await user["websocket"].send_json({"type": message_type, "message": message_text})
            except Exception as e:
                logger.error(f"Error al enviar mute global a {user['name']}: {e}")
                disconnected_users.append(user["name"])
                user["websocket"] = None
                user["logged_in"] = False
    if disconnected_users:
        await broadcast_users()

async def broadcast_users():
    """Difunde la lista de usuarios conectados."""
    user_list = []
    for token in users:
        if users[token]["logged_in"] and users[token]["websocket"]:
            decoded_token = base64.b64decode(token).decode('utf-8', errors='ignore')
            legajo, name, _ = decoded_token.split('_', 2) if '_' in decoded_token else (token, "Anónimo", "Desconocida")
            user_id = f"{users[token]['name']}_{users[token]['function']}"
            user_list.append({
                "display": f"{users[token]['name']} ({legajo})",
                "user_id": user_id,
                "group_id": users[token]["group_id"]
            })
    disconnected_users = []
    for token, user in list(users.items()):
        if user["logged_in"] and user["websocket"]:
            try:
                await user["websocket"].send_json({
                    "type": "users",
                    "count": len(user_list),
                    "list": user_list
                })
            except Exception as e:
                logger.error(f"Error al enviar usuarios a {user['name']}: {e}")
                disconnected_users.append(token)
                user["websocket"] = None
                user["logged_in"] = False
    if disconnected_users:
        for token in disconnected_users:
            if token in users:
                users[token]["websocket"] = None
                users[token]["logged_in"] = False
        await broadcast_users()

@app.get("/history")
async def get_history_endpoint():
    """Obtiene el historial de mensajes."""
    history = get_history()
    return history

async def clear_messages():
    """Programa la limpieza de mensajes."""
    while True:
        now = datetime.utcnow()
        start_time = datetime.utcnow().replace(hour=5, minute=30, second=0, microsecond=0)
        if now.hour >= 14 or (now.hour == 5 and now.minute >= 30):
            start_time += timedelta(days=1)
        await asyncio.sleep((start_time - now).total_seconds())

@app.on_event("startup")
async def startup_event():
    """Tareas de inicio de la aplicación."""
    init_db()
    asyncio.create_task(clear_messages())
    asyncio.create_task(process_audio_queue())
    asyncio.create_task(update_flights())
    asyncio.create_task(update_flights_periodically())
    asyncio.create_task(clean_expired_sessions())
    logger.info("Aplicación iniciada")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)

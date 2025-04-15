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
from FlightRadar24 import FlightRadar24API
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
users = {}  # Dict[token, Dict[str, Any]]: Almacena info de usuarios (name, function, websocket, etc.)
audio_queue = asyncio.Queue()  # Cola para procesar audio asincrónicamente
groups = {}  # Dict[group_id, List[token]]: Grupos de usuarios
flights_cache = []  # Cache global para vuelos AviationStack
fr24_cache = []  # Cache global para vuelos FlightRadar24
global_mute_active = False  # Estado de muteo general

# Cache para Airplanes.Live
airplanes_cache = TTLCache(maxsize=1, ttl=15)  # 15 segundos

# Función para filtrar vuelos cerca de Aeroparque
def is_near_aeroparque(lat, lon, max_distance_km=1000):
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
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(url, params=params) as response:
                if response.status != 200:
                    logger.error(f"Error AviationStack ({flight_type}): {response.status} {await response.text()}")
                    return []
                data = await response.json()
                flights = []
                for flight in data.get("data", []):
                    if flight.get("airline", {}).get("iata", "") != "AR":
                        continue
                    status = flight.get("flight_status", "").lower()
                    if status == "cancelled":
                        continue
                    status_map = {
                        "scheduled": "Estimado",
                        "active": "En vuelo",
                        "landed": "Aterrizado",
                        "delayed": "Demorado",
                        "departed": "Despegado"
                    }
                    status_text = status_map.get(status, status.capitalize())
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
            logger.error(f"Error AviationStack ({flight_type}): {e}")
            return []

# Actualizar vuelos AviationStack
async def update_flights():
    """Actualiza el caché de vuelos y los envía a los clientes conectados."""
    global flights_cache
    while True:
        flights = []
        for flight_type in ["llegadas", "partidas"]:
            flights.extend(await fetch_aviationstack_flights(flight_type=flight_type))
        flights_cache = remove_duplicates(flights)
        if flights_cache:
            for user in users.values():
                if user["logged_in"] and user["websocket"]:
                    try:
                        await user["websocket"].send_json({
                            "type": "flight_update",
                            "flights": flights_cache
                        })
                        logger.info(f"Actualización de vuelos enviada a {user['name']}")
                    except Exception as e:
                        logger.error(f"Error al enviar vuelos: {e}")
                        user["websocket"] = None
        else:
            logger.warning("No se encontraron vuelos")
        await asyncio.sleep(300)  # 5 minutos

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
        return "No se pudo transcribir"
    except sr.RequestError as e:
        logger.error(f"Error en la transcripción: {e}")
        return f"Error en la transcripción: {e}"
    except Exception as e:
        logger.error(f"Error al procesar el audio: {e}")
        return f"Error al procesar el audio: {e}"
    finally:
        audio_file.close()
        wav_io.close()

# Función para procesar consultas de búsqueda
async def process_search_query(query, flights):
    """Busca vuelos según la consulta del usuario."""
    query = query.lower()
    results = []
    if "demorado" in query or "demorados" in query:
        results = [f for f in flights if f["Estado"].lower() == "demorado"]
    elif "a " in query:
        destination = query.split("a ")[-1].strip()
        results = [f for f in flights if destination in f["Destino"].lower()]
    elif "ar" in query:
        flight_number = query.upper().split("AR")[-1].strip()
        results = [f for f in flights if f["Vuelo"] == f"AR{flight_number}"]
    else:
        results = flights
    if not results:
        return "No se encontraron vuelos para tu consulta."
    return ", ".join([f"{f['Vuelo']} a {f['Destino']}, {f['Estado']}" for f in results])

# Función para obtener datos de Airplanes.Live
async def get_airplanes_live_data():
    """Obtiene datos de aviones cerca de Aeroparque desde Airplanes.Live."""
    if "data" in airplanes_cache:
        logger.info("Devolviendo datos en caché")
        return airplanes_cache["data"]
    try:
        url = "https://api.airplanes.live/v2/point/-34.5597/-58.4116/250"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status == 200:
                    data = await response.json()
                    airplanes_cache["data"] = data.get("ac", [])
                    logger.info("Datos de Airplanes.Live obtenidos")
                    return airplanes_cache["data"]
                else:
                    logger.error(f"Error Airplanes.Live: {response.status}")
                    return []
    except Exception as e:
        logger.error(f"Error al obtener Airplanes.Live: {str(e)}")
        return []

# Función para obtener vuelos de FlightRadar24
async def get_flightradar24_data():
    """Obtiene vuelos cercanos a Aeroparque desde FlightRadar24."""
    try:
        fr_api = FlightRadar24API()
        flights = fr_api.get_flights()
        local_flights = [
            flight for flight in flights
            if is_near_aeroparque(flight.latitude, flight.longitude)
        ]
        return [
            {
                "flight": flight.id,
                "origin": flight.origin_airport_iata or "N/A",
                "destination": flight.destination_airport_iata or "N/A",
                "latitude": flight.latitude,
                "longitude": flight.longitude,
                "status": "Activo",
                "scheduled": "N/A"
            }
            for flight in local_flights[:5]
        ]
    except Exception as e:
        logger.error(f"Error al obtener FlightRadar24: {str(e)}")
        return []

# Función para eliminar duplicados
def remove_duplicates(flights):
    """Elimina vuelos duplicados basándose en Vuelo y STD."""
    seen = set()
    unique_flights = []
    for flight in flights:
        flight_key = (flight["Vuelo"], flight["STD"])
        if flight_key not in seen:
            seen.add(flight_key)
            unique_flights.append(flight)
    return unique_flights

# Actualizar vuelos FlightRadar24
async def update_fr24_flights():
    """Actualiza el caché de FlightRadar24 y lo envía a los clientes."""
    global fr24_cache
    while True:
        fr24_data = await get_flightradar24_data()
        fr24_cache = fr24_data
        if fr24_cache:
            for user in users.values():
                if user["logged_in"] and user["websocket"]:
                    try:
                        await user["websocket"].send_json({
                            "type": "fr24_update",
                            "flights": fr24_cache
                        })
                        logger.info(f"Actualización FlightRadar24 enviada a {user['name']}")
                    except Exception as e:
                        logger.error(f"Error al enviar vuelos FR24: {e}")
                        user["websocket"] = None
        else:
            logger.warning("No se encontraron vuelos FlightRadar24")
        await asyncio.sleep(60)  # 1 minuto

@app.get("/opensky")
async def get_opensky_data():
    airplanes_data = await get_airplanes_live_data()
    arrivals = fetch_flights_api(flight_type="llegadas")
    departures = fetch_flights_api(flight_type="partidas")
    tams_data = arrivals + departures

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
                "vert_rate": plane.get("vert_rate"),
                "origin_dest": f"{plane.get('orig', 'N/A')}-{plane.get('dest', 'N/A')}"
            }
            for tams_flight in tams_data:
                if tams_flight["Vuelo"] == flight:
                    plane_info.update({
                        "scheduled": tams_flight["STD"],
                        "position": tams_flight["Posicion"],
                        "destination": tams_flight["Destino"],
                        "status": tams_flight["Estado"]
                    })
                    break
            combined_data.append(plane_info)

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
                "origin_dest": None
            })

    logger.info(f"Datos combinados: {len(combined_data)} vuelos")
    return combined_data

@app.get("/flightradar24")
async def get_flightradar24_flights():
    data = await get_flightradar24_data()
    logger.info(f"Datos FlightRadar24: {len(data)} vuelos")
    return data

def init_db():
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS messages 
                 (id INTEGER PRIMARY KEY, user_id TEXT, audio TEXT, text TEXT, timestamp TEXT, date TEXT)''')
    conn.commit()
    conn.close()

def save_message(user_id, audio_data, text, timestamp):
    date = datetime.utcnow().strftime("%Y-%m-%d")
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute("INSERT INTO messages (user_id, audio, text, timestamp, date) VALUES (?, ?, ?, ?, ?)",
              (user_id, audio_data, text, timestamp, date))
    conn.commit()
    conn.close()
    logger.info(f"Mensaje guardado: user_id={user_id}, timestamp={timestamp}")

def get_history():
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute("SELECT user_id, audio, text, timestamp, date FROM messages ORDER BY date, timestamp")
    rows = c.fetchall()
    conn.close()
    return [{"user_id": row[0], "audio": row[1], "text": row[2], "timestamp": row[3], "date": row[4]} for row in rows]

async def process_audio_queue():
    while True:
        try:
            token, audio_data, message = await audio_queue.get()
            sender = message.get("sender", "Unknown")
            function = message.get("function", "Unknown")
            text = message.get("text", "Sin transcripción")
            timestamp = message.get("timestamp", datetime.utcnow().strftime("%H:%M"))

            logger.info(f"Procesando audio de {sender} ({function})")

            if global_mute_active:
                logger.info("Muteo global activo, audio no transmitido")
                audio_queue.task_done()
                continue

            if text == "Sin transcripción" or text == "Pendiente de transcripción":
                logger.info("Transcribiendo audio...")
                text = await transcribe_audio(audio_data)
                logger.info(f"Transcripción: {text}")

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
            for user_token, user in list(users.items()):
                if user_token == token:
                    continue
                muted_users = user.get("muted_users", set())
                sender_id = f"{sender}_{function}"
                if sender_id in muted_users or user.get("group_id"):
                    continue
                ws = user.get("websocket")
                if ws:
                    try:
                        await ws.send_json(broadcast_message)
                        logger.info(f"Mensaje enviado a {user['name']}")
                    except Exception as e:
                        logger.error(f"Error al enviar a {user['name']}: {e}")
                        user["websocket"] = None
                        users[user_token]["logged_in"] = False
                        await broadcast_users()
        except Exception as e:
            logger.error(f"Error procesando audio queue: {e}")
        finally:
            audio_queue.task_done()

@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    logger.info(f"Cliente conectado: {token}")

    global global_mute_active

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
                "muted_users": set(),
                "subscription": None,
                "group_id": None
            }

        await websocket.send_json({"type": "connection_success", "message": "Conectado"})
        logger.info(f"Confirmación enviada a {token}")

        await websocket.send_json({"type": "flight_update", "flights": flights_cache})
        await websocket.send_json({"type": "fr24_update", "flights": fr24_cache})
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
                await websocket.send_json({"type": "register_success", "message": "Registro exitoso"})
                logger.info(f"Usuario registrado: {name} ({function})")
                await broadcast_users()

            elif message["type"] == "subscribe":
                users[token]["subscription"] = message["subscription"]
                logger.info(f"Suscripción push para {token}")

            elif message["type"] == "audio":
                audio_data = message.get("data")
                if not audio_data:
                    logger.error("Audio sin datos")
                    continue
                await audio_queue.put((token, audio_data, message))
                logger.info(f"Audio recibido de {token}")

            elif message["type"] == "logout":
                group_id = users[token]["group_id"]
                if group_id and group_id in groups:
                    if token in groups[group_id]:
                        groups[group_id].remove(token)
                    if not groups[group_id]:
                        del groups[group_id]
                users[token]["logged_in"] = False
                del users[token]
                await broadcast_users()
                await websocket.close()
                logger.info(f"Usuario {token} cerró sesión")
                break

            elif message["type"] == "mute_user":
                target_user_id = message.get("target_user_id")
                if target_user_id:
                    users[token]["muted_users"].add(target_user_id)
                    logger.info(f"{users[token]['name']} muteó a {target_user_id}")
                else:
                    logger.error("mute_user sin target_user_id")

            elif message["type"] == "unmute_user":
                target_user_id = message.get("target_user_id")
                if target_user_id:
                    users[token]["muted_users"].discard(target_user_id)
                    logger.info(f"{users[token]['name']} desmuteó a {target_user_id}")
                else:
                    logger.error("unmute_user sin target_user_id")

            elif message["type"] == "mute_all":
                global_mute_active = True
                await broadcast_global_mute_state("mute_all_success", "Muteo global activado")
                logger.info(f"{users[token]['name']} activó muteo global")

            elif message["type"] == "unmute_all":
                global_mute_active = False
                await broadcast_global_mute_state("unmute_all_success", "Muteo global desactivado")
                logger.info(f"{users[token]['name']} desactivó muteo global")

            elif message["type"] == "mute":
                await websocket.send_json({"type": "mute_success", "message": "Mute activado"})
                logger.info(f"{users[token]['name']} activó mute local")

            elif message["type"] == "unmute":
                await websocket.send_json({"type": "unmute_success", "message": "Mute desactivado"})
                logger.info(f"{users[token]['name']} desactivó mute local")

            elif message["type"] == "join_group":
                group_id = message["group_id"]
                if group_id not in groups:
                    groups[group_id] = []
                if token not in groups[group_id]:
                    groups[group_id].append(token)
                users[token]["group_id"] = group_id
                await websocket.send_json({"type": "join_group", "group_id": group_id})
                logger.info(f"{users[token]['name']} se unió al grupo {group_id}")
                await broadcast_users()

            elif message["type"] == "leave_group":
                group_id = message["group_id"]
                if token and group_id in groups:
                    if token in groups[group_id]:
                        groups[group_id].remove(token)
                    if not groups[group_id]:
                        del groups[group_id]
                    users[token]["group_id"] = None
                    await broadcast_users()
                    logger.info(f"{users[token]['name']} salió del grupo {group_id}")

            elif message["type"] == "check_group":
                group_id = message["group_id"]
                in_group = False
                if token and group_id in groups and token in groups[group_id]:
                    in_group = True
                await websocket.send_json({"type": "check_group", "group_id": group_id, "in_group": in_group})
                logger.info(f"Verificación grupo para {users[token]['name']}: {'está' if in_group else 'no está'} en {group_id}")

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
                        logger.info("Transcribiendo grupo audio...")
                        text = await transcribe_audio(audio_data)
                        logger.info(f"Transcripción grupo: {text}")

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
                            if ws:
                                try:
                                    await ws.send_json(broadcast_message)
                                    logger.info(f"Mensaje grupo enviado a {user['name']} en {group_id}")
                                except Exception as e:
                                    logger.error(f"Error al enviar grupo a {user['name']}: {e}")
                                    user["websocket"] = None
                                    users[user_token]["logged_in"] = False
                                    await broadcast_users()

            elif message["type"] == "search_query":
                response = await process_search_query(message["query"], flights_cache)
                await websocket.send_json({"type": "search_response", "message": response})
                logger.info(f"Consulta procesada para {users[token]['name']}: {message['query']} -> {response}")

    except WebSocketDisconnect:
        logger.info(f"Cliente desconectado: {token}")
        if token in users:
            group_id = users[token]["group_id"]
            if group_id and group_id in groups:
                if token in groups[group_id]:
                    groups[group_id].remove(token)
                if not groups[group_id]:
                    del groups[group_id]
            users[token]["websocket"] = None
            users[token]["logged_in"] = False
            await broadcast_users()
    except Exception as e:
        logger.error(f"Error WebSocket {token}: {str(e)}")
        if token in users:
            group_id = users[token]["group_id"]
            if group_id and group_id in groups:
                if token in groups[group_id]:
                    groups[group_id].remove(token)
                if not groups[group_id]:
                    del groups[group_id]
            users[token]["websocket"] = None
            users[token]["logged_in"] = False
            await broadcast_users()
        await websocket.close()

async def broadcast_global_mute_state(message_type, message_text):
    for user in list(users.values()):
        if user["logged_in"] and user["websocket"]:
            try:
                await user["websocket"].send_json({"type": message_type, "message": message_text})
                logger.info(f"Estado mute global ({message_type}) a {user['name']}")
            except Exception as e:
                logger.error(f"Error al enviar mute global a {user['name']}: {e}")
                user["websocket"] = None
                user["logged_in"] = False
                await broadcast_users()

async def broadcast_users():
    user_list = []
    for token in users:
        if users[token]["logged_in"]:
            decoded_token = base64.b64decode(token).decode('utf-8')
            legajo, name, _ = decoded_token.split('_', 2)
            user_id = f"{users[token]['name']}_{users[token]['function']}"
            user_list.append({
                "display": f"{users[token]['name']} ({legajo})",
                "user_id": user_id,
                "group_id": users[token]["group_id"]
            })
    for user in list(users.values()):
        if user["logged_in"] and user["websocket"]:
            try:
                await user["websocket"].send_text(json.dumps({
                    "type": "users",
                    "count": len(user_list),
                    "list": user_list
                }))
                logger.info(f"Lista usuarios enviada a {user['name']}")
            except Exception as e:
                logger.error(f"Error al enviar usuarios: {e}")
                user["websocket"] = None
                user["logged_in"] = False

@app.get("/history")
async def get_history_endpoint():
    history = get_history()
    logger.info(f"Historial: {len(history)} mensajes")
    return history

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
    asyncio.create_task(update_flights())
    asyncio.create_task(update_fr24_flights())
    logger.info("Aplicación iniciada")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)

import asyncio
import base64
import json
import os
import time
from datetime import datetime, timedelta
import sqlite3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
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

# Configurar CORS
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:8000,https://tu-dominio.com").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Montar archivos estáticos
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Validar claves de API
GOFLIGHTLABS_API_KEY = os.getenv("GOFLIGHTLABS_API_KEY")
#AVIATIONSTACK_API_KEY = os.getenv("AVIATIONSTACK_API_KEY")
if not GOFLIGHTLABS_API_KEY: # or not AVIATIONSTACK_API_KEY:
    logger.error("Faltan claves de API de GoFlightLabs en las variables de entorno")
    raise ValueError("GOFLIGHTLABS_API_KEY no están configuradas")

# Cargar index.html
with open("templates/index.html", "r") as f:
    INDEX_HTML = f.read()

# Crear cachés
flight_cache = TTLCache(maxsize=100, ttl=300)  # 5 minutos para /aep_flights
flight_details_cache = TTLCache(maxsize=100, ttl=300)  # 5 minutos para /flight_details
#opensky_cache = TTLCache(maxsize=1, ttl=15)  # 15 segundos para OpenSky

# Lista de usuarios permitidos (apellido: legajo o None si no se especifica)
ALLOWED_USERS = {
    "Souto": "35127",
    "Vázquez": None,  # Sin legajo, se permitirá registro con cualquier legajo
    "Giménez": "35145",
    "Gómez": "35128",
    "Benítez": "33366",
    "Contartese": "38818",
    "Leites": "38880",
    "Duartero": "36000",
    "Arena": "35596",
    "Brandariz": "35417",
    "Fossati": "35152",
    "Test": "12345",
    "Bot": "00000"
}

# Sectores disponibles
ALLOWED_SECTORS = ["Operaciones", "Control", "Administración", "Mantenimiento", "Seguridad"]

# Ruta raíz
@app.get("/")
async def read_root():
    response = HTMLResponse(content=INDEX_HTML)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# Diccionario ICAO para pronunciación fonética
ICAO_ALPHABET = {
    'Alfa': 'A', 'Bravo': 'B', 'Charlie': 'C', 'Delta': 'D', 'Echo': 'E',
    'Foxtrot': 'F', 'Golf': 'G', 'Hotel': 'H', 'India': 'I', 'Juliett': 'J',
    'Kilo': 'K', 'Lima': 'L', 'Mike': 'M', 'November': 'N', 'Oscar': 'O',
    'Papa': 'P', 'Quebec': 'Q', 'Romeo': 'R', 'Sierra': 'S', 'Tango': 'T',
    'Uniform': 'U', 'Victor': 'V', 'Whiskey': 'W', 'X-ray': 'X', 'Yankee': 'Y',
    'Zulu': 'Z'
}

def to_icao(text):
    """Convierte texto a pronunciación ICAO (ej. 'Foxtrot Uniform Alfa' -> 'FUA')."""
    return ' '.join(ICAO_ALPHABET.get(char.upper(), char) for char in text if char.isalpha())

# Estructuras de datos
users = {}  # Dict[token, Dict[str, Any]]: Almacena info de usuarios
audio_queue = asyncio.Queue()  # Cola para procesar audio
groups = {}  # Dict[group_id, List[token]]: Grupos de usuarios
flights_cache = []  # Cache global para vuelos
global_mute_active = False  # Estado de muteo general

# Ruta para obtener vuelos de Aeroparque
@app.get("/aep_flights")
async def get_aep_flights(query: str = None):
    cache_key = f'aep_flights_ar_{query or "all"}'
    if cache_key in flight_cache:
        logger.info(f'Sirviendo desde caché: {cache_key}')
        return flight_cache[cache_key]

    try:
        params = {
            'access_key': GOFLIGHTLABS_API_KEY,
            'airline_iata': 'AR',
            'dep_iata': 'AEP',
            'arr_iata': 'AEP',
            'flight_status': 'scheduled,active,landed'
        }
        async with aiohttp.ClientSession() as session:
            async with session.get('https://www.goflightlabs.com/flights', params=params, timeout=15) as response:
                if response.status != 200:
                    logger.error(f"Error GoFlightLabs: {response.status}")
                    raise HTTPException(status_code=500, detail="Error en la API de GoFlightLabs")
                data = await response.json()

        if not data.get('success', False):
            logger.error(f"Error GoFlightLabs: {data.get('error', 'Unknown')}")
            raise HTTPException(status_code=500, detail="Error en la API de GoFlightLabs")

        now = datetime.utcnow()
        time_min = now - timedelta(hours=12)
        time_max = now + timedelta(hours=12)

        filtered_flights = []
        for flight in data.get('data', []):
            departure_time = flight.get('departure', {}).get('scheduled', '')
            arrival_time = flight.get('arrival', {}).get('scheduled', '')
            try:
                dep_dt = datetime.fromisoformat(departure_time.replace('Z', '+00:00')) if departure_time else None
                arr_dt = datetime.fromisoformat(arrival_time.replace('Z', '+00:00')) if arrival_time else None
            except ValueError:
                logger.warning(f"Formato de fecha inválido: {departure_time}, {arrival_time}")
                continue
            if (dep_dt and time_min <= dep_dt <= time_max) or (arr_dt and time_min <= arr_dt <= time_max):
                flight_data = {
                    'flight_number': flight.get('flight', {}).get('number', ''),
                    'departure_airport': flight.get('departure', {}).get('airport', ''),
                    'departure_time': departure_time,
                    'arrival_airport': flight.get('arrival', {}).get('airport', ''),
                    'arrival_time': arrival_time,
                    'status': flight.get('flight_status', ''),
                    'gate': flight.get('departure', {}).get('gate', 'N/A'),
                    'delay': flight.get('departure', {}).get('delay', 0),
                    'registration': flight.get('aircraft', {}).get('registration', 'N/A')
                    'destination': flight.get('arrival', {}).get('airport', ''),
                    'origin': flight.get('departure', {}).get('airport', '')
                }
                filtered_flights.append(flight_data)

        if query:
            query = query.lower()
            filtered_flights = [
                f for f in filtered_flights
                if query in f['flight_number'].lower() or
                   query in f['departure_airport'].lower() or
                   query in f['arrival_airport'].lower() or
                   query in f['status'].lower()
            ]

        response_data = {'flights': filtered_flights}
        flight_cache[cache_key] = response_data
        logger.info(f'Respuesta cacheada: {cache_key}, {len(filtered_flights)} vuelos')
        return response_data

    except aiohttp.ClientError as e:
        logger.error(f"Error al consultar GoFlightLabs: {e}")
        raise HTTPException(status_code=500, detail=f"Error al consultar la API: {str(e)}")
    except Exception as e:
        logger.error(f"Error interno en /aep_flights: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")

# Endpoint para detalles de un vuelo
@app.get("/flight_details/{flight_number}")
async def get_flight_details(flight_number: str):
    cache_key = f'flight_details_{flight_number}'
    if cache_key in flight_details_cache:
        logger.info(f'Sirviendo desde caché: {cache_key}')
        return flight_details_cache[cache_key]

    try:
        params = {
            'access_key': GOFLIGHTLABS_API_KEY,
            'flight_iata': f'AR{flight_number}' if not flight_number.startswith('AR') else flight_number,
            'dep_iata': 'AEP',
            'arr_iata': 'AEP'
        }
        async with aiohttp.ClientSession() as session:
            async with session.get('https://www.goflightlabs.com/flights', params=params, timeout=15) as response:
                if response.status != 200:
                    logger.error(f"Error GoFlightLabs: {response.status}")
                    raise HTTPException(status_code=500, detail="Error en la API de GoFlightLabs)
                data = await response.json()

        flights = data.get('data', [])
        if not flights:
            logger.warning(f"No se encontró el vuelo: {flight_number}")
            raise HTTPException(status_code=404, detail="Vuelo no encontrado")

        flight = flights[0]
        flight_data = {
            'flight_number': flight.get('flight', {}).get('number', ''),
            'departure_airport': flight.get('departure', {}).get('iata', ''),
            'departure_time': flight.get('departure', {}).get('scheduled', ''),
            'arrival_airport': flight.get('arrival', {}).get('iata', ''),
            'arrival_time': flight.get('arrival', {}).get('scheduled', ''),
            'status': flight.get('flight_status', ''),
            'gate': flight.get('departure', {}).get('gate', 'N/A'),
            'delay': flight.get('departure', {}).get('delay', 0),
            'registration': flight.get('aircraft', {}).get('registration', 'N/A'),
            'destination': flight.get('arrival', {}).get('airport', ''),
            'origin': flight.get('departure', {}).get('airport', '')
        }

        flight_details_cache[cache_key] = flight_data
        logger.info(f'Detalles cacheados: {cache_key}')
        return flight_data

    except aiohttp.ClientError as e:
        logger.error(f"Error al consultar GoFlightLabs: {e}")
        raise HTTPException(status_code=500, detail=f"Error al consultar la API: {str(e)}")
    except Exception as e:
        logger.error(f"Error interno en /flight_details: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")

# Función para filtrar vuelos cerca de Aeroparque
def is_near_aeroparque(lat, lon, max_distance_km=1500):
    aep_lat, aep_lon = -34.6084, -58.3732
    dlat = math.radians(lat - aep_lat)
    dlon = math.radians(lon - aep_lon)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(aep_lat)) * math.cos(math.radians(lat)) * math.sin(dlon/2)**2
    c = 2 * math.asin(math.sqrt(a))
    distance_km = 6371 * c
    return distance_km <= max_distance_km

# Función unificada para obtener vuelos de AviationStack
async def fetch_aviationstack_flights(flight_type="partidas", airport="Aeroparque, AEP"):
    flight_type_param = "dep_iata" if flight_type.lower() == "partidas" else "arr_iata"
    airport_code = airport.split(", ")[1] if ", " in airport else "AEP"
    url = "https://www.goflightlabs.com/flights"
    params = {
        "access_key": GOFLIGHTLABS_API_KEY,
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
                logger.error(f"Error GoFlightLabs ({flight_type}, intento {attempt+1}): {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** attempt)
                else:
                    return []
    return []

# Función para obtener datos de OpenSky Network
async def get_opensky_data():
    if "data" in opensky_cache:
        logger.info("Devolviendo datos en caché de OpenSky")
        return opensky_cache["data"]
    try:
        url = "https://opensky-network.org/api/states/all"
        params = {
            "lamin": -35.6084,
            "lomin": -59.3732,
            "lamax": -33.6084,
            "lomax": -57.3732
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
                                "gs": velocity * 1.94384 if velocity else None,
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
    global flights_cache
    while True:
        flights = []
        for flight_type in ["llegadas", "partidas"]:
            flights.extend(await fetch_aviationstack_flights(flight_type=flight_type))
        flights_cache = remove_duplicates(flights)
        if not flights_cache:
            logger.warning("No se encontraron vuelos de AviationStack")
        await asyncio.sleep(300)

# Actualizar vuelos OpenSky periódicamente
async def update_flights_periodically():
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
        await asyncio.sleep(10)

# Función para transcribir audio
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
    seen = set()
    unique_flights = []
    for flight in flights:
        flight_key = (flight["Vuelo"], flight["STD"])
        if flight_key not in seen:
            seen.add(flight_key)
            unique_flights.append(flight)
    return unique_flights

@app.get("/opensky")
async def get_opensky_data_endpoint():
    data = await get_opensky_data()
    logger.info(f"Datos combinados: {len(data)} vuelos")
    return data

def init_db():
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
    conn = sqlite3.connect("chat_history.db")
    c = conn.cursor()
    c.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()
    conn.close()
    logger.info(f"Sesión eliminada para token={token}")

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

async def clear_messages():
    while True:
        try:
            now = datetime.utcnow()
            start_time = now.replace(hour=5, minute=30, second=0, microsecond=0)
            if now >= start_time:
                start_time += timedelta(days=1)
            await asyncio.sleep((start_time - now).total_seconds())
            
            conn = sqlite3.connect("chat_history.db")
            c = conn.cursor()
            expiration_time = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
            c.execute("DELETE FROM messages WHERE date < ?", (expiration_time,))
            conn.commit()
            deleted = c.rowcount
            if deleted > 0:
                logger.info(f"Eliminados {deleted} mensajes antiguos")
            conn.close()
        except Exception as e:
            logger.error(f"Error al limpiar mensajes: {e}")

            
@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    logger.info(f"Cliente conectado: {token}")

    try:
        # Validar formato del token
        try:
            decoded_token = base64.b64decode(token).decode('utf-8')
            if '_' not in decoded_token or len(decoded_token.split('_')) != 3:
                raise ValueError("Formato de token inválido")
        except (base64.binascii.Error, ValueError) as e:
            logger.error(f"Token inválido: {token}, {str(e)}")
            await websocket.send_json({"type": "error", "message": "Token inválido"})
            await websocket.close()
            return

        session = load_session(token)
        user_id = decoded_token
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

            elif message["type"] == "mute_non_group":
                group_id = users[token]["group_id"]
                if group_id:
                    muted_users = []
                    for user_token, user in users.items():
                        if user_token != token and user["group_id"] != group_id:
                            user_id = f"{user['name']}_{user['function']}"
                            users[token]["muted_users"].add(user_id)
                            muted_users.append(user_id)
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        users[token]["group_id"],
                        users[token]["muted_users"]
                    )
                    await websocket.send_json({
                        "type": "mute_non_group_success",
                        "message": "Usuarios fuera del grupo muteados",
                        "muted_users": muted_users
                    })
                else:
                    await websocket.send_json({
                        "type": "mute_non_group_error",
                        "message": "No estás en ningún grupo"
                    })

            elif message["type"] == "unmute_non_group":
                group_id = users[token]["group_id"]
                if group_id:
                    unmuted_users = []
                    for user_token, user in users.items():
                        if user_token != token and user["group_id"] != group_id:
                            user_id = f"{user['name']}_{user['function']}"
                            if user_id in users[token]["muted_users"]:
                                users[token]["muted_users"].discard(user_id)
                                unmuted_users.append(user_id)
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        users[token]["group_id"],
                        users[token]["muted_users"]
                    )
                    await websocket.send_json({
                        "type": "unmute_non_group_success",
                        "message": "Usuarios fuera del grupo desmuteados",
                        "unmuted_users": unmuted_users
                    })
                else:
                    await websocket.send_json({
                        "type": "unmute_non_group_error",
                        "message": "No estás en ningún grupo"
                    })

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

            elif message["type"] == "flight_details_request":
                flight_number = message.get("flight_number")
                if not flight_number:
                    await websocket.send_json({
                        "type": "flight_details_error",
                        "message": "Número de vuelo no proporcionado"
                    })
                    continue
                try:
                    flight_data = await get_flight_details(flight_number)
                    await websocket.send_json({
                        "type": "flight_details_response",
                        "flight": flight_data
                    })
                except HTTPException as e:
                    await websocket.send_json({
                        "type": "flight_details_error",
                        "message": e.detail
                    })

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

async def broadcast_users():
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
    history = get_history()
    return history

@app.on_event("startup")
async def startup_event():
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

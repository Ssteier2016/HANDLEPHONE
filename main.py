import asyncio
import base64
import json
import os
from datetime import datetime, timedelta
import sqlite3
from typing import Dict, List, Optional, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
import aiohttp
import speech_recognition as sr
import io
import soundfile as sf
from pydub import AudioSegment
from dotenv import load_dotenv
from cachetools import TTLCache
from pydantic import BaseModel, validator
from passlib.context import CryptContext

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

# Estado de la aplicación
app_state = {
    "global_mute_active": False
}

# Configurar hash de contraseñas
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Configurar CORS
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:8000,https://handyhandle.onrender.com").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# Montar archivos estáticos
try:
    app.mount("/templates", StaticFiles(directory="templates"), name="templates")
    logger.info("Directorio 'templates' montado correctamente")
except Exception as e:
    logger.error(f"Error al montar directorio 'templates': {e}")

# Configuración de Flightradar24
BASE_URL = "https://fr24api.flightradar24.com/api/flight-summary/light"

# Cargar tokens desde variables de entorno
FLIGHTRADAR24_TOKEN_PRIMARY = os.getenv(
    "FLIGHTRADAR24_TOKEN_PRIMARY",
    "0196bbf3-6f6b-724e-9f55-2d133a569225|KvaPf2rP7ZOeuV9xSS0ggJ8ZUsWd29mgGOuHU8zX59d2f2d3"
)
FLIGHTRADAR24_TOKEN_SANDBOX = os.getenv(
    "FLIGHTRADAR24_TOKEN_SANDBOX",
    "0196af1f-7948-706c-af15-5e72920ecdbf|RDLvw2k7yFpRYpSKishi9kO8m96zmzC5gyrttGtCdca6a5d4"
)

# Lista de tokens: principal primero, luego sandbox
TOKENS = [FLIGHTRADAR24_TOKEN_PRIMARY, FLIGHTRADAR24_TOKEN_SANDBOX]

# Cargar index.html
try:
    with open("templates/index.html", "r") as f:
        INDEX_HTML = f.read()
    logger.info("Archivo index.html cargado correctamente")
except Exception as e:
    logger.error(f"Error al cargar index.html: {e}")
    INDEX_HTML = "<html><body><h1>Error: No se pudo cargar index.html</h1></body></html>"

# Crear cachés
flightradar24_cache = TTLCache(maxsize=100, ttl=300)
flight_details_cache = TTLCache(maxsize=100, ttl=300)

# Lista de usuarios permitidos
ALLOWED_USERS = {
    "Souto": "35127", "Vázquez": "35806", "Giménez": "35145", "Gómez": "35128",
    "Benítez": "33366", "Contartese": "38818", "Leites": "38880", "Duartero": "36000",
    "Arena": "35596", "Brandariz": "35417", "Fossati": "35152", "Test": "12345",
    "Bot": "00000", "Test2": "12345", "Binda": "38530"
}

# Sectores disponibles
ALLOWED_SECTORS = [
    "Maletero", "Cintero", "Tractorista", "Equipos", "Supervisor",
    "Jefatura", "Movilero", "Señalero", "Pañolero"
]
# Modelo para la solicitud de validación
class TokenValidationRequest(BaseModel):
    token: str

# Simulación de almacenamiento de tokens válidos (en producción, usa una base de datos o Redis)
valid_tokens = set()  # Ejemplo: almacenar tokens válidos

# Modelos Pydantic para validación
class RegisterRequest(BaseModel):
    surname: str
    employee_id: str
    sector: str
    password: str

    @validator('surname')
    def validate_surname(cls, v):
        if not v.strip().replace(' ', '').isalpha():
            raise ValueError('El apellido debe contener solo letras')
        return v.strip().capitalize()

    @validator('employee_id')
    def validate_employee_id(cls, v):
        if not v.strip().isdigit() or len(v.strip()) != 5:
            raise ValueError('El legajo debe ser un número de 5 dígitos')
        return v.strip()

    @validator('sector')
    def validate_sector(cls, v):
        if v not in ALLOWED_SECTORS:
            raise ValueError('Sector no válido')
        return v.strip()

    @validator('password')
    def validate_password(cls, v):
        if len(v) < 6:
            raise ValueError('La contraseña debe tener al menos 6 caracteres')
        return v

class LoginRequest(BaseModel):
    surname: str
    employee_id: str
    password: str

    @validator('surname')
    def validate_surname(cls, v):
        if not v.strip().replace(' ', '').isalpha():
            raise ValueError('El apellido debe contener solo letras')
        return v.strip().capitalize()

    @validator('employee_id')
    def validate_employee_id(cls, v):
        if not v.strip().isdigit() or len(v.strip()) != 5:
            raise ValueError('El legajo debe ser un número de 5 dígitos')
        return v.strip()

# Ruta raíz
@app.get("/")
async def read_root():
    response = HTMLResponse(content=INDEX_HTML)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.head("/")
async def root_head():
    return {"status": "healthy"}

# Endpoint de salud
@app.head("/health")
@app.get("/health")
async def health_check():
    return {"status": "healthy"}

# Diccionario ICAO para pronunciación fonética
ICAO_ALPHABET = {
    'Alfa': 'A', 'Bravo': 'B', 'Charlie': 'C', 'Delta': 'D', 'Echo': 'E',
    'Foxtrot': 'F', 'Golf': 'G', 'Hotel': 'H', 'India': 'I', 'Juliett': 'J',
    'Kilo': 'K', 'Lima': 'L', 'Mike': 'M', 'November': 'N', 'Oscar': 'O',
    'Papa': 'P', 'Quebec': 'Q', 'Romeo': 'R', 'Sierra': 'S', 'Tango': 'T',
    'Uniform': 'U', 'Victor': 'V', 'Whiskey': 'W', 'X-ray': 'X', 'Yankee': 'Y',
    'Zulu': 'Z'
}

def to_icao(text: str) -> str:
    return ' '.join(ICAO_ALPHABET.get(char.upper(), char) for char in text if char.isalpha())

# Inicializar base de datos
def init_db():
    try:
        with sqlite3.connect("chat_history.db") as conn:
            c = conn.cursor()
            c.execute('''CREATE TABLE IF NOT EXISTS messages 
                         (id INTEGER PRIMARY KEY, user_id TEXT, audio TEXT, text TEXT, timestamp TEXT, date TEXT)''')
            c.execute('''CREATE TABLE IF NOT EXISTS sessions 
                         (token TEXT PRIMARY KEY, user_id TEXT, name TEXT, function TEXT, group_id TEXT, 
                          muted_users TEXT, last_active TIMESTAMP)''')
            c.execute('''CREATE TABLE IF NOT EXISTS users 
                         (surname TEXT PRIMARY KEY, employee_id TEXT, sector TEXT, password TEXT)''')
            conn.commit()
        logger.info("Base de datos inicializada correctamente")
    except Exception as e:
        logger.error(f"Error al inicializar la base de datos: {e}")

# Estructuras de datos
users: Dict[str, Dict[str, any]] = {}
audio_queue: asyncio.Queue = asyncio.Queue()
groups: Dict[str, List[str]] = {}

# Endpoint de registro
@app.post("/register")
async def register_user(request: RegisterRequest):
    surname = request.surname
    employee_id = request.employee_id
    sector = request.sector
    password = request.password

    if surname not in ALLOWED_USERS:
        logger.error(f"Intento de registro con apellido no permitido: {surname}")
        raise HTTPException(status_code=403, detail="Usuario no permitido")
    
    expected_employee_id = ALLOWED_USERS[surname]
    if expected_employee_id and expected_employee_id != employee_id:
        logger.error(f"Legajo incorrecto para {surname}: {employee_id}")
        raise HTTPException(status_code=403, detail="Legajo incorrecto")

    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT surname FROM users WHERE surname = ?", (surname,))
        if c.fetchone():
            logger.error(f"Usuario ya registrado: {surname}")
            raise HTTPException(status_code=400, detail="Usuario ya registrado")

        hashed_password = pwd_context.hash(password)
        c.execute("INSERT INTO users (surname, employee_id, sector, password) VALUES (?, ?, ?, ?)",
                  (surname, employee_id, sector, hashed_password))
        conn.commit()
    
    logger.info(f"Usuario registrado: {surname} ({employee_id}, {sector})")
    return {"message": "Registro exitoso"}

@app.post("/validate-token")
async def validate_token(request: TokenValidationRequest):
    token = request.token
    if not token:
        logger.error("Token no proporcionado en la solicitud")
        raise HTTPException(status_code=400, detail="Token no proporcionado")
    
    try:
        # Decodificar el token
        decoded = base64.b64decode(token).decode("utf-8")
        employee_id, surname, sector = decoded.split("_")
        if not all([employee_id, surname, sector]):
            logger.error(f"Token inválido: {token}. Componentes incompletos")
            raise HTTPException(status_code=401, detail="Token inválido")
        
        # Verificar si el token es válido (simulación)
        if token not in valid_tokens:
            logger.error(f"Token no registrado: {token}")
            raise HTTPException(status_code=401, detail="Token no registrado")
        
        logger.info(f"Token validado exitosamente: {token}")
        return {"status": "valid"}
    
    except Exception as e:
        logger.error(f"Excepción al validar token {token}: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Error al validar token: {str(e)}")
        

# Endpoint de inicio de sesión
@app.post("/login")
async def login_user(request: LoginRequest):
    surname = request.surname
    employee_id = request.employee_id
    password = request.password

    if surname not in ALLOWED_USERS:
        logger.error(f"Intento de login con apellido no permitido: {surname}")
        raise HTTPException(status_code=403, detail="Usuario no permitido")

    expected_employee_id = ALLOWED_USERS[surname]
    if expected_employee_id and expected_employee_id != employee_id:
        logger.error(f"Legajo incorrecto para {surname}: {employee_id}")
        raise HTTPException(status_code=403, detail="Legajo incorrecto")

    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT surname, employee_id, sector, password FROM users WHERE surname = ? AND employee_id = ?",
                  (surname, employee_id))
        user = c.fetchone()

    if not user:
        logger.error(f"Credenciales inválidas para {surname}: {employee_id}")
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    stored_password = user[3]
    if not pwd_context.verify(password, stored_password):
        logger.error(f"Contraseña incorrecta para {surname}: {employee_id}")
        raise HTTPException(status_code=401, detail="Contraseña incorrecta")

    sector = user[2]
    token_data = f"{employee_id}_{surname}_{sector}"
    token = base64.b64encode(token_data.encode('utf-8')).decode('utf-8')
    logger.info(f"Login exitoso: {surname} ({employee_id}, {sector})")
    return {"token": token, "message": "Inicio de sesión exitoso"}

# Endpoint para vuelos de Aerolíneas Argentinas desde Flightradar24
@app.get("/flightradar24_flights")
async def get_flightradar24_flights(query: Optional[str] = None):
    cache_key = f'flightradar24_flights_ar_{query or "all"}'
    if cache_key in flightradar24_cache:
        logger.info(f'Sirviendo desde caché: {cache_key}')
        return flightradar24_cache[cache_key]

    # Configuración de la solicitud
    now = datetime.utcnow()
    date_from = now - timedelta(hours=24)
    date_to = now
    flight_datetime_from = date_from.strftime("%Y-%m-%dT%H:%M:%SZ")
    flight_datetime_to = date_to.strftime("%Y-%m-%dT%H:%M:%SZ")

    params = {
        "flight_datetime_from": flight_datetime_from,
        "flight_datetime_to": flight_datetime_to,
        "airports": "AEP",  # Filtro necesario para la API
        "limit": 100
    }

    # Intentar con cada token en orden
    for token in TOKENS:
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Accept-Version": "v1",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(BASE_URL, params=params, headers=headers, timeout=15) as response:
                    if response.status == 200:
                        data = await response.json()
                        # Filtrar vuelos de Aerolíneas Argentinas
                        flights = []
                        for flight in data.get("data", []):
                            flight_number = flight.get("flight", "N/A")
                            if flight_number.startswith("AR"):
                                status = "Landed" if flight.get("flight_ended", False) else "En vuelo"
                                if flight.get("datetime_landed") and not flight.get("flight_ended"):
                                    status = "En tierra"
                                flight_data = {
                                    "flight_number": flight_number,
                                    "departure_time": flight.get("datetime_takeoff", "N/A"),
                                    "arrival_airport": flight.get("dest_icao", flight.get("dest_iata", "N/A")),
                                    "status": status,
                                    "gate": "N/A",
                                    "origin": flight.get("orig_icao", flight.get("orig_iata", "N/A")),
                                    "destination": flight.get("dest_icao", flight.get("dest_iata", "N/A")),
                                    "registration": flight.get("reg", "N/A"),
                                    "source": "flightradar24"
                                }
                                flights.append(flight_data)
                        if query:
                            query = query.lower()
                            flights = [
                                f for f in flights
                                if query in f["flight_number"].lower() or
                                   query in f["destination"].lower() or
                                   query in f["status"].lower()
                            ]
                        response_data = {"flights": flights}
                        flightradar24_cache[cache_key] = response_data
                        logger.info(f"Respuesta cacheada: {cache_key}, {len(flights)} vuelos (usando token {token[:10]}...)")
                        return response_data
                    else:
                        error_details = await response.text() or "Error desconocido"
                        logger.error(f"Error con token {token[:10]}...: {response.status}, Detalles: {error_details}")
        except Exception as e:
            logger.error(f"Excepción con token {token[:10]}...: {str(e)}")
            continue  # Pasar al siguiente token

    # Si ambos tokens fallan
    cached_data = flightradar24_cache.get(cache_key)
    if cached_data:
        logger.info(f"Sirviendo datos desde caché debido a fallo de todos los tokens: {cache_key}")
        return cached_data
    raise HTTPException(
        status_code=500,
        detail="No se pudo obtener datos de Flightradar24 con ningún token"
    )

# Endpoint para detalles de un vuelo
@app.get("/flight_details/{flight_number}")
async def get_flight_details(flight_number: str):
    cache_key = f'flight_details_{flight_number}'
    if cache_key in flight_details_cache:
        logger.info(f'Sirviendo desde caché: {cache_key}')
        return flight_details_cache[cache_key]

    # Configuración de la solicitud
    now = datetime.utcnow()
    date_from = now - timedelta(hours=24)
    date_to = now
    flight_datetime_from = date_from.strftime("%Y-%m-%dT%H:%M:%SZ")
    flight_datetime_to = date_to.strftime("%Y-%m-%dT%H:%M:%SZ")

    params = {
        "flight_datetime_from": flight_datetime_from,
        "flight_datetime_to": flight_datetime_to,
        "airports": "AEP",  # Filtro necesario para la API
        "limit": 100
    }

    # Intentar con cada token en orden
    for token in TOKENS:
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Accept-Version": "v1",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(BASE_URL, params=params, headers=headers, timeout=15) as response:
                    if response.status == 200:
                        data = await response.json()
                        # Buscar el vuelo específico
                        flight = next((f for f in data.get("data", []) if f.get("flight") == flight_number), None)
                        if not flight:
                            logger.warning(f"No se encontró el vuelo: {flight_number}")
                            raise HTTPException(status_code=404, detail="Vuelo no encontrado")
                        status = "Landed" if flight.get("flight_ended", False) else "En vuelo"
                        if flight.get("datetime_landed") and not flight.get("flight_ended"):
                            status = "En tierra"
                        flight_data = {
                            "flight_number": flight.get("flight", "N/A"),
                            "departure_time": flight.get("datetime_takeoff", "N/A"),
                            "arrival_airport": flight.get("dest_icao", flight.get("dest_iata", "N/A")),
                            "status": status,
                            "gate": "N/A",
                            "origin": flight.get("orig_icao", flight.get("orig_iata", "N/A")),
                            "destination": flight.get("dest_icao", flight.get("dest_iata", "N/A")),
                            "registration": flight.get("reg", "N/A"),
                            "source": "flightradar24"
                        }
                        flight_details_cache[cache_key] = flight_data
                        logger.info(f'Detalles cacheados: {cache_key} (usando token {token[:10]}...)')
                        return flight_data
                    else:
                        error_details = await response.text() or "Error desconocido"
                        logger.error(f"Error con token {token[:10]}...: {response.status}, Detalles: {error_details}")
        except Exception as e:
            logger.error(f"Excepción con token {token[:10]}...: {str(e)}")
            continue  # Pasar al siguiente token

    # Si ambos tokens fallan
    cached_data = flight_details_cache.get(cache_key)
    if cached_data:
        logger.info(f"Sirviendo datos desde caché debido a fallo de todos los tokens: {cache_key}")
        return cached_data
    raise HTTPException(
        status_code=500,
        detail="No se pudo obtener detalles del vuelo con ningún token"
    )

@app.get("/api/flights")
async def get_flights():
    try:
        # Ejemplo de llamada a FlightRadar24 (reemplazar con tu API real)
        response = requests.get("https://api.flightradar24.com/flights", headers={
            "Authorization": "Bearer YOUR_FLIGHTRADAR24_API_KEY"
        })
        if response.status_code == 200:
            flights = response.json().get("flights", [])
            logger.info(f"Vuelos obtenidos de FlightRadar24: {len(flights)}")
            # Filtrar vuelos de Aerolíneas Argentinas (ejemplo)
            filtered_flights = [
                {
                    "flight_number": f["flight_number"],
                    "departure_time": f.get("departure_time", "N/A"),
                    "arrival_airport": f.get("arrival_airport", "N/A"),
                    "status": f.get("status", "Desconocido"),
                    "gate": f.get("gate", "N/A")
                }
                for f in flights if f["flight_number"].startswith("AR")
            ]
            logger.info(f"Vuelos filtrados: {len(filtered_flights)}")
            return {"flights": filtered_flights}
        else:
            logger.error(f"Error al consultar FlightRadar24: {response.status_code}")
            return {"flights": []}
    except Exception as e:
        logger.error(f"Error al obtener vuelos: {str(e)}")
        return {"flights": []}


# Actualizar vuelos periódicamente
async def update_flights():
    while True:
        try:
            response = await get_flightradar24_flights()
            logger.info(f"Cache de vuelos actualizado: {len(response['flights'])} vuelos")
            disconnected_users = []
            for token, user in users.items():
                if not user["logged_in"] or not user["websocket"]:
                    disconnected_users.append(token)
                    continue
                try:
                    await user["websocket"].send_json({
                        "type": "flight_update",
                        "flights": response['flights']
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
        except HTTPException as e:
            logger.error(f"Error HTTP en update_flights: {e.detail}")
        except Exception as e:
            logger.error(f"Error general en update_flights: {e}")
        await asyncio.sleep(300)  # Actualizar cada 5 minutos

# Función para transcribir audio
async def transcribe_audio(audio_data: str) -> str:
    try:
        audio_bytes = base64.b64decode(audio_data)
        with io.BytesIO(audio_bytes) as audio_file:
            audio_segment = AudioSegment.from_file(audio_file, format="webm")
            audio_segment = audio_segment.set_channels(1).set_frame_rate(16000)
            with io.BytesIO() as wav_io:
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

# Función para procesar consultas de búsqueda
async def process_search_query(query: str, flights: List[Dict]) -> str:
    query = query.lower().strip()
    results = []
    for flight in flights:
        if (query in flight["flight_number"].lower() or
                query in flight["destination"].lower() or
                query in flight["status"].lower() or
                "ar" + query in flight["flight_number"].lower()):
            results.append(flight)
    if not results:
        return "No se encontraron vuelos para tu consulta."
    return ", ".join([f"{f['flight_number']} a {f['destination']}, {f['status']}" for f in results])

# Funciones de base de datos
def save_session(token: str, user_id: str, name: str, function: str, group_id: Optional[str] = None, muted_users: Optional[Set[str]] = None):
    muted_users_str = json.dumps(list(muted_users or set()))
    last_active = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute('''INSERT OR REPLACE INTO sessions 
                     (token, user_id, name, function, group_id, muted_users, last_active) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)''',
                  (token, user_id, name, function, group_id, muted_users_str, last_active))
        conn.commit()
    logger.info(f"Sesión guardada para token={token}")

def load_session(token: str) -> Optional[Dict]:
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT user_id, name, function, group_id, muted_users, last_active FROM sessions WHERE token = ?",
                  (token,))
        row = c.fetchone()
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

def delete_session(token: str):
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
    logger.info(f"Sesión eliminada para token={token}")

def save_message(user_id: str, audio_data: str, text: str, timestamp: str):
    date = datetime.utcnow().strftime("%Y-%m-%d")
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("INSERT INTO messages (user_id, audio, text, timestamp, date) VALUES (?, ?, ?, ?, ?)",
                  (user_id, audio_data, text, timestamp))
        conn.commit()
    logger.info(f"Mensaje guardado: user_id={user_id}, timestamp={timestamp}")

def get_history() -> List[Dict]:
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT user_id, audio, text, timestamp, date FROM messages ORDER BY date, timestamp")
        rows = c.fetchall()
    return [{"user_id": row[0], "audio": row[1], "text": row[2], "timestamp": row[3], "date": row[4]} for row in rows]

# Procesar cola de audio
async def process_audio_queue():
    while True:
        try:
            item = await audio_queue.get()
            if not isinstance(item, tuple) or len(item) != 3:
                logger.error(f"Elemento mal formado en audio_queue: {item}")
                continue
            token, audio_data, message = item

            sender = message.get("sender", "Unknown")
            function = message.get("function", "Unknown")
            text = message.get("text", "Sin transcripción")
            timestamp = message.get("timestamp", datetime.utcnow().strftime("%H:%M"))

            logger.info(f"Procesando audio de {sender} ({function})")

            if app_state["global_mute_active"]:
                logger.info("Muteo global activo, audio no transmitido")
                await broadcast_message({
                    "type": "mute_notification",
                    "message": "Muteo global activo, audio no transmitido"
                })
                continue

            if text == "Sin transcripción" or text == "Pendiente de transcripción":
                logger.info("Transcribiendo audio...")
                text = await transcribe_audio(audio_data)

            user_id = f"{sender}_{function}"
            save_message(user_id, audio_data, text, timestamp)

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
                    users[token]["websocket"] = None
                    users[token]["logged_in"] = False
                    logger.info(f"Usuario {user_token} marcado como desconectado")
            if disconnected_users:
                await broadcast_users()

            # Llamar task_done() solo después de procesar exitosamente
            audio_queue.task_done()

        except asyncio.CancelledError:
            logger.info("Tarea de audio queue cancelada")
            break
        except Exception as e:
            logger.error(f"Error procesando audio queue: {e}")
            # No llamar task_done() en caso de error

# Limpiar sesiones expiradas
async def clean_expired_sessions():
    while True:
        try:
            with sqlite3.connect("chat_history.db") as conn:
                c = conn.cursor()
                expiration_time = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
                c.execute("DELETE FROM sessions WHERE last_active < ?", (expiration_time,))
                conn.commit()
                deleted = c.rowcount
                if deleted > 0:
                    logger.info(f"Eliminadas {deleted} sesiones expiradas")
        except Exception as e:
            logger.error(f"Error al limpiar sesiones: {e}")
        await asyncio.sleep(3600)

# Limpiar mensajes antiguos
async def clear_messages():
    while True:
        try:
            now = datetime.utcnow()
            start_time = now.replace(hour=5, minute=30, second=0, microsecond=0)
            if now >= start_time:
                start_time += timedelta(days=1)
            await asyncio.sleep((start_time - now).total_seconds())
            
            with sqlite3.connect("chat_history.db") as conn:
                c = conn.cursor()
                expiration_time = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
                c.execute("DELETE FROM messages WHERE date < ?", (expiration_time,))
                conn.commit()
                deleted = c.rowcount
                if deleted > 0:
                    logger.info(f"Eliminados {deleted} mensajes antiguos")
        except Exception as e:
            logger.error(f"Error al limpiar mensajes: {e}")

# Endpoint WebSocket
@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    logger.info(f"Cliente conectado: {token}")

    try:
        try:
            decoded_token = base64.b64decode(token).decode('utf-8')
            employee_id, surname, sector = decoded_token.split('_')
        except (base64.binascii.Error, ValueError) as e:
            logger.error(f"Token inválido: {token}, {str(e)}")
            await websocket.send_json({"type": "error", "message": "Token inválido"})
            await websocket.close()
            return

        with sqlite3.connect("chat_history.db") as conn:
            c = conn.cursor()
            c.execute("SELECT surname, employee_id, sector FROM users WHERE surname = ? AND employee_id = ? AND sector = ?",
                      (surname, employee_id, sector))
            user = c.fetchone()

        if not user:
            logger.error(f"Token no corresponde a un usuario registrado: {token}")
            await websocket.send_json({"type": "error", "message": "Usuario no registrado"})
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
                "name": surname,
                "function": sector,
                "logged_in": True,
                "websocket": websocket,
                "muted_users": set(),
                "subscription": None,
                "group_id": None
            }
            save_session(token, user_id, surname, sector)
            logger.info(f"Nueva sesión creada para {token}")

        await websocket.send_json({"type": "connection_success", "message": "Conectado"})
        await websocket.send_json({"type": "mute_state", "global_mute_active": app_state["global_mute_active"]})
        await websocket.send_json({"type": "flight_update", "flights": (await get_flights())['flights']})
        await broadcast_users()

        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
                logger.debug(f"Mensaje recibido de {token}: {data[:50]}...")
            except json.JSONDecodeError as e:
                logger.error(f"Error decodificando mensaje de {token}: {e}")
                await websocket.send_json({"type": "error", "message": "Mensaje JSON inválido"})
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
                app_state["global_mute_active"] = True
                await broadcast_global_mute_state("mute_all_success", "Muteo global activado")

            elif message["type"] == "unmute_all":
                app_state["global_mute_active"] = False
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
                        text = await transcribe_audio(audio_data)

                    user_id = f"{users[token]['name']}_{users[token]['function']}"
                    save_message(user_id, audio_data, f"[Grupo {group_id}] {text}", timestamp)

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
                response = await process_search_query(message["query"], (await get_flights())['flights'])
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
            group_id = users[token]["group_id"]
            if group_id and group_id in groups and token in groups[group_id]:
                groups[group_id].remove(token)
                if not groups[group_id]:
                    del groups[group_id]
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
            group_id = users[token]["group_id"]
            if group_id and group_id in groups and token in groups[group_id]:
                groups[group_id].remove(token)
                if not groups[group_id]:
                    del groups[group_id]
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

async def broadcast_global_mute_state(message_type: str, message_text: str):
    disconnected_users = []
    for user in list(users.values()):
        if user["logged_in"] and user["websocket"]:
            try:
                await user["websocket"].send_json({"type": "mute_state", "global_mute_active": app_state["global_mute_active"]})
                await user["websocket"].send_json({"type": message_type, "message": message_text})
            except Exception as e:
                logger.error(f"Error al enviar mute global a {user['name']}: {e}")
                disconnected_users.append(user["name"])
                user["websocket"] = None
                user["logged_in"] = False
    if disconnected_users:
        await broadcast_users()

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

async def broadcast_message(message: Dict):
    disconnected_users = []
    for token, user in list(users.items()):
        if not user["logged_in"] or not user["websocket"]:
            disconnected_users.append(token)
            continue
        try:
            await user["websocket"].send_json(message)
        except Exception as e:
            logger.error(f"Error al enviar mensaje a {user['name']}: {e}")
            disconnected_users.append(token)
    for token in disconnected_users:
        if token in users:
            users[token]["websocket"] = None
            users[token]["logged_in"] = False
            logger.info(f"Usuario {token} marcado como desconectado")
    if disconnected_users:
        await broadcast_users()

@app.get("/history")
async def get_history_endpoint():
    return get_history()

@app.get("/api/history")
async def get_api_history_endpoint():
    return get_history()

@app.on_event("startup")
async def startup_event():
    try:
        logger.info("Iniciando aplicación...")
        init_db()
        logger.info("Tarea init_db completada")
        asyncio.create_task(clear_messages())
        logger.info("Tarea clear_messages programada")
        asyncio.create_task(process_audio_queue())
        logger.info("Tarea process_audio_queue programada")
        asyncio.create_task(update_flights())
        logger.info("Tarea update_flights programada")
        asyncio.create_task(clean_expired_sessions())
        logger.info("Tarea clean_expired_sessions programada")
        logger.info("Aplicación iniciada correctamente")
    except Exception as e:
        logger.error(f"Error durante el inicio de la aplicación: {e}")
        raise

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    try:
        logger.info(f"Iniciando Uvicorn en puerto {port}")
        uvicorn.run(app, host="0.0.0.0", port=port)
    except Exception as e:
        logger.error(f"Error al iniciar Uvicorn: {e}")
        raise

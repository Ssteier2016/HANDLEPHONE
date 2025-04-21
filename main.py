import asyncio
import base64
import json
import os
import time
from datetime import datetime, timedelta
import sqlite3
from typing import Dict, List, Optional, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
import aiohttp
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup
import speech_recognition as sr
import io
import soundfile as sf
from pydub import AudioSegment
from pydantic import BaseModel, validator
from passlib.context import CryptContext
from cachetools import TTLCache

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Inicializar FastAPI
app = FastAPI()

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
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Configurar hash de contraseñas
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Cargar index.html
with open("templates/index.html", "r") as f:
    INDEX_HTML = f.read()

# Crear cachés
flight_cache = TTLCache(maxsize=100, ttl=15)  # 15 segundos para /opensky
flight_details_cache = TTLCache(maxsize=100, ttl=300)  # 5 minutos para /flight_details

# Lista de usuarios permitidos
ALLOWED_USERS = {
    "Souto": "35127", "Vázquez": "35806", "Giménez": "35145", "Gómez": "35128",
    "Benítez": "33366", "Contartese": "38818", "Leites": "38880", "Duartero": "36000",
    "Arena": "35596", "Brandariz": "35417", "Fossati": "35152", "Test": "12345",
    "Bot": "00000", "Test2": "12345", "Binda": "38530"
}
ALLOWED_SECTORS = [
    "Maletero", "Cintero", "Tractorista", "Equipos", "Supervisor",
    "Jefatura", "Movilero", "Señalero", "Pañolero"
]

# Modelos Pydantic
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
@app.get("/", response_class=HTMLResponse)
async def read_root():
    response = HTMLResponse(content=INDEX_HTML)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# Diccionario ICAO
ICAO_ALPHABET = {
    'A': 'Alfa', 'B': 'Bravo', 'C': 'Charlie', 'D': 'Delta', 'E': 'Echo',
    'F': 'Foxtrot', 'G': 'Golf', 'H': 'Hotel', 'I': 'India', 'J': 'Juliett',
    'K': 'Kilo', 'L': 'Lima', 'M': 'Mike', 'N': 'November', 'O': 'Oscar',
    'P': 'Papa', 'Q': 'Quebec', 'R': 'Romeo', 'S': 'Sierra', 'T': 'Tango',
    'U': 'Uniform', 'V': 'Victor', 'W': 'Whiskey', 'X': 'X-ray', 'Y': 'Yankee',
    'Z': 'Zulu'
}

def to_icao(text: str) -> str:
    return ' '.join(ICAO_ALPHABET.get(char.upper(), char) for char in text if char.isalpha())

# Estructuras de datos
users: Dict[str, Dict[str, any]] = {}
audio_queue: asyncio.Queue = asyncio.Queue()
groups: Dict[str, List[str]] = {}
global_mute_active = False
last_request_time = 0
cached_data = None

# Inicializar base de datos
def init_db():
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

def save_message(user_id: str, audio_data: str, text: str, timestamp: str):
    date = datetime.utcnow().strftime("%Y-%m-%d")
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("INSERT INTO messages (user_id, audio, text, timestamp, date) VALUES (?, ?, ?, ?, ?)",
                  (user_id, audio_data, text, timestamp, date))
        conn.commit()

def get_history() -> List[Dict]:
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT user_id, audio, text, timestamp, date FROM messages ORDER BY date, timestamp")
        rows = c.fetchall()
    return [{"user_id": row[0], "audio": row[1], "text": row[2], "timestamp": row[3], "date": row[4]} for row in rows]

# Registro de usuarios
@app.post("/register")
async def register_user(request: RegisterRequest):
    surname = request.surname
    employee_id = request.employee_id
    sector = request.sector
    password = request.password

    if surname not in ALLOWED_USERS:
        raise HTTPException(status_code=403, detail="Usuario no permitido")
    
    expected_employee_id = ALLOWED_USERS[surname]
    if expected_employee_id and expected_employee_id != employee_id:
        raise HTTPException(status_code=403, detail="Legajo incorrecto")

    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT surname FROM users WHERE surname = ?", (surname,))
        if c.fetchone():
            raise HTTPException(status_code=400, detail="Usuario ya registrado")

        hashed_password = pwd_context.hash(password)
        c.execute("INSERT INTO users (surname, employee_id, sector, password) VALUES (?, ?, ?, ?)",
                  (surname, employee_id, sector, hashed_password))
        conn.commit()
    
    logger.info(f"Usuario registrado: {surname} ({employee_id}, {sector})")
    return {"message": "Registro exitoso"}

# Inicio de sesión
@app.post("/login")
async def login_user(request: LoginRequest):
    surname = request.surname
    employee_id = request.employee_id
    password = request.password

    if surname not in ALLOWED_USERS:
        raise HTTPException(status_code=403, detail="Usuario no permitido")

    expected_employee_id = ALLOWED_USERS[surname]
    if expected_employee_id and expected_employee_id != employee_id:
        raise HTTPException(status_code=403, detail="Legajo incorrecto")

    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT surname, employee_id, sector, password FROM users WHERE surname = ? AND employee_id = ?",
                  (surname, employee_id))
        user = c.fetchone()

    if not user:
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    stored_password = user[3]
    if not pwd_context.verify(password, stored_password):
        raise HTTPException(status_code=401, detail="Contraseña incorrecta")

    sector = user[2]
    token_data = f"{employee_id}_{surname}_{sector}"
    token = base64.b64encode(token_data.encode('utf-8')).decode('utf-8')
    logger.info(f"Login exitoso: {surname} ({employee_id}, {sector})")
    return {"token": token, "message": "Inicio de sesión exitoso"}

# Obtener datos de Airplanes.Live
async def get_airplanes_live_data():
    global last_request_time, cached_data
    current_time = time.time()
    cache_key = "airplanes_live"
    if cache_key in flight_cache:
        logger.info("Devolviendo datos en caché de Airplanes.Live")
        return flight_cache[cache_key]
    try:
        url = "https://api.airplanes.live/v2/point/-34.5597/-58.4116/250"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status == 200:
                    data = await response.json()
                    cached_data = data.get("ac", [])
                    last_request_time = current_time
                    flight_cache[cache_key] = cached_data
                    logger.info("Datos de Airplanes.Live obtenidos correctamente")
                    return cached_data
                else:
                    logger.error(f"Error al obtener datos de Airplanes.Live: {response.status}")
                    return []
    except Exception as e:
        logger.error(f"Error al obtener datos de Airplanes.Live: {str(e)}")
        return []

# Scrapear TAMS
def scrape_tams():
    url = "http://www.tams.com.ar/ORGANISMOS/Vuelos.aspx"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    session = requests.Session()
    retries = Retry(total=3, backoff_factor=1, status_forcelist=[502, 503, 504])
    session.mount("http://", HTTPAdapter(max_retries=retries))

    try:
        response = session.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        flights = []
        spans = soup.find_all('span')
        flight_data = [span.text.strip() for span in spans if span.text.strip() and " " not in span.text]

        for i in range(0, len(flight_data), 17):
            row = flight_data[i:i+17]
            if len(row) < 17:
                continue
            airline = row[1]
            flight_number = row[2]
            scheduled_time = row[3]
            registration = row[4]
            position = row[5] if len(row) > 5 else ""
            destination = row[11] if len(row) > 11 else ""
            status = row[15] if len(row) > 15 else "Desconocido"

            if airline == "AR":
                flights.append({
                    "Vuelo": f"AR{flight_number}",
                    "STD": scheduled_time,
                    "Posicion": position,
                    "Destino": destination,
                    "Matricula": registration if registration != " " else "N/A",
                    "Estado": status
                })

        logger.info(f"Datos scrapeados de TAMS: {len(flights)} vuelos")
        return flights
    except Exception as e:
        logger.error(f"Error al scrapear TAMS: {e}")
        return []

# Eliminar duplicados
def remove_duplicates(flights):
    seen = set()
    unique_flights = []
    for flight in flights:
        flight_key = (flight["Vuelo"], flight["STD"])
        if flight_key not in seen:
            seen.add(flight_key)
            unique_flights.append(flight)
    return unique_flights

# Actualizar vuelos de TAMS
async def update_tams_flights():
    while True:
        flights = scrape_tams()
        unique_flights = remove_duplicates(flights)
        if unique_flights:
            for user in users.values():
                if user["logged_in"] and user["websocket"]:
                    try:
                        await user["websocket"].send_text(json.dumps({
                            "type": "flight_update",
                            "flights": unique_flights
                        }))
                    except Exception as e:
                        logger.error(f"Error al enviar actualización de vuelos: {e}")
                        user["websocket"] = None
            logger.info(f"Enviados {len(unique_flights)} vuelos únicos")
        await asyncio.sleep(300)

# Obtener datos combinados
@app.get("/opensky")
async def get_opensky_data():
    cache_key = "opensky_combined"
    if cache_key in flight_cache:
        logger.info("Devolviendo datos combinados en caché")
        return flight_cache[cache_key]

    airplanes_data = await get_airplanes_live_data()
    tams_data = scrape_tams()
    
    combined_data = []
    for plane in airplanes_data:
        flight = plane.get("flight", "").strip()
        registration = plane.get("r", "").strip()
        if flight and flight.startswith("ARG"):
            plane_info = {
                "flight_number": flight,
                "registration": registration,
                "lat": plane.get("lat"),
                "lon": plane.get("lon"),
                "altitude": plane.get("alt_geom"),
                "ground_speed": plane.get("gs"),
                "vertical_rate": plane.get("vert_rate"),
                "origin": plane.get("orig", "N/A"),
                "destination": plane.get("dest", "N/A"),
                "status": "En vuelo"
            }
            for tams_flight in tams_data:
                if tams_flight["Matricula"] == registration:
                    plane_info.update({
                        "scheduled_time": tams_flight["STD"],
                        "gate": tams_flight["Posicion"],
                        "destination": tams_flight["Destino"],
                        "status": tams_flight.get("Estado", "Desconocido")
                    })
                    break
            combined_data.append(plane_info)
    
    for tams_flight in tams_data:
        if not any(plane["registration"] == tams_flight["Matricula"] for plane in combined_data):
            combined_data.append({
                "flight_number": tams_flight["Vuelo"],
                "registration": tams_flight["Matricula"],
                "scheduled_time": tams_flight["STD"],
                "gate": tams_flight["Posicion"],
                "destination": tams_flight["Destino"],
                "status": tams_flight.get("Estado", "Desconocido"),
                "lat": None,
                "lon": None,
                "altitude": None,
                "ground_speed": None,
                "vertical_rate": None,
                "origin": None
            })

    flight_cache[cache_key] = combined_data
    logger.info(f"Datos combinados: {len(combined_data)} vuelos")
    return combined_data

# Detalles de un vuelo
@app.get("/flight_details/{flight_number}")
async def get_flight_details(flight_number: str):
    cache_key = f'flight_details_{flight_number}'
    if cache_key in flight_details_cache:
        logger.info(f'Sirviendo desde caché: {cache_key}')
        return flight_details_cache[cache_key]

    flights = await get_opensky_data()
    flight_data = next((f for f in flights if f["flight_number"].lower() == flight_number.lower()), None)
    
    if not flight_data:
        raise HTTPException(status_code=404, detail="Vuelo no encontrado")

    flight_details_cache[cache_key] = flight_data
    logger.info(f'Detalles cacheados: {cache_key}')
    return flight_data

# Transcribir audio
async def transcribe_audio(audio_data: str) -> str:
    try:
        audio_bytes = base64.b64decode(audio_data)
        audio_file = io.BytesIO(audio_bytes)
        audio_segment = AudioSegment.from_file(audio_file, format="webm")
        audio_segment = audio_segment.set_channels(1).set_frame_rate(16000)
        wav_io = io.BytesIO()
        audio_segment.export(wav_io, format="wav")
        wav_io.seek(0)
        data, samplerate = sf.read(wav_io)
        recognizer = sr.Recognizer()
        with sr.AudioFile(wav_io) as source:
            audio_data = recognizer.record(source)
            text = recognizer.recognize_google(audio_data, language="es-ES")
            logger.info("Audio transcrito exitosamente")
            return text
    except sr.UnknownValueError:
        logger.warning("No se pudo transcribir el audio")
        return "No se pudo transcribir"
    except Exception as e:
        logger.error(f"Error al procesar el audio: {e}")
        return "Error al procesar el audio"
    finally:
        audio_file.close()
        wav_io.close()

# Procesar cola de audio
async def process_audio_queue():
    while True:
        try:
            token, audio_data, message = await audio_queue.get()
            sender = message.get("sender", "Unknown")
            function = message.get("function", "Unknown")
            text = message.get("text", "Sin transcripción")
            timestamp = message.get("timestamp", datetime.utcnow().strftime("%H:%M"))

            if global_mute_active:
                logger.info("Muteo global activo, audio no transmitido")
                audio_queue.task_done()
                continue

            if text == "Sin transcripción" or text == "Pendiente de transcripción":
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
            for user_token, user in list(users.items()):
                if user_token == token:
                    continue
                muted_users = user.get("muted_users", set())
                sender_id = f"{sender}_{function}"
                if sender_id in muted_users:
                    continue
                if user.get("group_id"):
                    continue
                ws = user.get("websocket")
                if ws:
                    try:
                        await ws.send_json(broadcast_message)
                    except Exception as e:
                        logger.error(f"Error al enviar mensaje: {e}")
                        user["websocket"] = None
                        users[user_token]["logged_in"] = False
                        await broadcast_users()
        except Exception as e:
            logger.error(f"Error procesando audio queue: {e}")
        finally:
            audio_queue.task_done()

# Limpiar sesiones y mensajes
async def clean_expired_sessions():
    while True:
        try:
            with sqlite3.connect("chat_history.db") as conn:
                c = conn.cursor()
                expiration_time = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
                c.execute("DELETE FROM sessions WHERE last_active < ?", (expiration_time,))
                conn.commit()
                if c.rowcount > 0:
                    logger.info(f"Eliminadas {c.rowcount} sesiones expiradas")
        except Exception as e:
            logger.error(f"Error al limpiar sesiones: {e}")
        await asyncio.sleep(3600)

async def clear_messages():
    while True:
        now = datetime.utcnow()
        start_time = now.replace(hour=5, minute=30, second=0, microsecond=0)
        if now >= start_time:
            start_time += timedelta(days=1)
        await asyncio.sleep((start_time - now).total_seconds())
        try:
            with sqlite3.connect("chat_history.db") as conn:
                c = conn.cursor()
                expiration_time = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
                c.execute("DELETE FROM messages WHERE date < ?", (expiration_time,))
                conn.commit()
                if c.rowcount > 0:
                    logger.info(f"Eliminados {c.rowcount} mensajes antiguos")
        except Exception as e:
            logger.error(f"Error al limpiar mensajes: {e}")

# WebSocket
@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    logger.info(f"Cliente conectado: {token}")

    try:
        try:
            decoded_token = base64.b64decode(token).decode('utf-8')
            employee_id, surname, sector = decoded_token.split('_')
        except Exception:
            await websocket.send_json({"type": "error", "message": "Token inválido"})
            await websocket.close()
            return

        with sqlite3.connect("chat_history.db") as conn:
            c = conn.cursor()
            c.execute("SELECT surname, employee_id, sector FROM users WHERE surname = ? AND employee_id = ? AND sector = ?",
                      (surname, employee_id, sector))
            user = c.fetchone()

        if not user:
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

        await websocket.send_json({"type": "connection_success", "message": "Conectado"})
        await websocket.send_json({"type": "mute_state", "global_mute_active": global_mute_active})
        await broadcast_users()

        while True:
            data = await websocket.receive_text()
            message = json.loads(data)

            if message["type"] == "register":
                users[token]["name"] = message.get("name", surname)
                users[token]["function"] = message.get("function", sector)
                save_session(token, user_id, users[token]["name"], users[token]["function"])
                await websocket.send_json({"type": "register_success", "message": "Registro exitoso"})
                await broadcast_users()

            elif message["type"] == "subscribe":
                users[token]["subscription"] = message["subscription"]

            elif message["type"] == "audio":
                audio_data = message.get("data")
                if audio_data:
                    await audio_queue.put((token, audio_data, message))

            elif message["type"] == "logout":
                group_id = users[token]["group_id"]
                if group_id and group_id in groups:
                    if token in groups[group_id]:
                        groups[group_id].remove(token)
                    if not groups[group_id]:
                        del groups[group_id]
                delete_session(token)
                if token in users:
                    del users[token]
                await broadcast_users()
                await websocket.close()
                break

            elif message["type"] == "mute_user":
                target_user_id = message.get("target_user_id")
                if target_user_id:
                    users[token]["muted_users"].add(target_user_id)
                    save_session(token, user_id, users[token]["name"], users[token]["function"], users[token]["group_id"], users[token]["muted_users"])

            elif message["type"] == "unmute_user":
                target_user_id = message.get("target_user_id")
                if target_user_id:
                    users[token]["muted_users"].discard(target_user_id)
                    save_session(token, user_id, users[token]["name"], users[token]["function"], users[token]["group_id"], users[token]["muted_users"])

            elif message["type"] == "mute_all":
                global global_mute_active
                global_mute_active = True
                await broadcast_global_mute_state("mute_all_success", "Muteo global activado")

            elif message["type"] == "unmute_all":
                global global_mute_active
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
                    save_session(token, user_id, users[token]["name"], users[token]["function"], group_id, users[token]["muted_users"])
                    await websocket.send_json({
                        "type": "mute_non_group_success",
                        "message": "Usuarios fuera del grupo muteados",
                        "muted_users": muted_users
                    })

            elif message["type"] == "join_group":
                group_id = message["group_id"]
                if group_id not in groups:
                    groups[group_id] = []
                if token not in groups[group_id]:
                    groups[group_id].append(token)
                users[token]["group_id"] = group_id
                save_session(token, user_id, users[token]["name"], users[token]["function"], group_id, users[token]["muted_users"])
                await websocket.send_json({"type": "join_group", "group_id": group_id})
                await broadcast_users()

            elif message["type"] == "leave_group":
                group_id = users[token]["group_id"]
                if group_id and group_id in groups:
                    if token in groups[group_id]:
                        groups[group_id].remove(token)
                    if not groups[group_id]:
                        del groups[group_id]
                    users[token]["group_id"] = None
                    save_session(token, user_id, users[token]["name"], users[token]["function"], None, users[token]["muted_users"])
                    await broadcast_users()

            elif message["type"] == "group_message":
                group_id = users[token]["group_id"]
                if group_id and group_id in groups:
                    audio_data = message.get("data")
                    if not audio_data:
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
                                except Exception as e:
                                    logger.error(f"Error al enviar mensaje de grupo: {e}")
                                    user["websocket"] = None
                                    users[user_token]["logged_in"] = False
                                    await broadcast_users()

    except WebSocketDisconnect:
        if token in users:
            group_id = users[token]["group_id"]
            if group_id and group_id in groups:
                if token in groups[group_id]:
                    groups[group_id].remove(token)
                if not groups[group_id]:
                    del groups[group_id]
            users[token]["websocket"] = None
            users[token]["logged_in"] = False
            save_session(token, users[token]["user_id"], users[token]["name"], users[token]["function"], users[token]["group_id"], users[token]["muted_users"])
            await broadcast_users()
# Difundir estado de muteo global
async def broadcast_global_mute_state(message_type: str, message_text: str):
    for user in list(users.values()):
        if user["logged_in"] and user["websocket"]:
            try:
                await user["websocket"].send_json({"type": message_type, "message": message_text})
            except Exception as e:
                logger.error(f"Error al enviar estado de muteo: {e}")
                user["websocket"] = None
                user["logged_in"] = False
                await broadcast_users()

# Difundir lista de usuarios
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
                await user["websocket"].send_json({
                    "type": "users",
                    "count": len(user_list),
                    "list": user_list
                })
            except Exception as e:
                logger.error(f"Error al enviar lista de usuarios: {e}")
                user["websocket"] = None
                user["logged_in"] = False

@app.get("/history")
async def get_history_endpoint():
    return get_history()

@app.on_event("startup")
async def startup_event():
    init_db()
    asyncio.create_task(clear_messages())
    asyncio.create_task(process_audio_queue())
    asyncio.create_task(update_tams_flights())
    asyncio.create_task(clean_expired_sessions())
    logger.info("Aplicación iniciada")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)

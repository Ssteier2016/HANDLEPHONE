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
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
import aiohttp
import requests
from bs4 import BeautifulSoup
import speech_recognition as sr
import io
import soundfile as sf
from pydub import AudioSegment
from dotenv import load_dotenv
from cachetools import TTLCache
from pydantic import BaseModel, validator
import bcrypt
from gtts import gTTS

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
    "global_mute_active": False,
    "announced_flights": set(),
    "updates_enabled": True,  # Interruptor para actualizaciones
    "daily_token_count": 0,  # Contador de tokens diarios
    "last_request_time": datetime.now(),
    "day_reset": datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
}

# Configurar hash de contraseñas
# bcrypt es usado directamente para evitar problemas de compatibilidad en python 3.11+

# Configurar CORS
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:8000,https://handyhandle.onrender.com").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# Montar archivos estáticos para la carpeta templates
try:
    app.mount("/templates", StaticFiles(directory="templates"), name="templates")
    logger.info("Directorio 'templates' montado correctamente")
except Exception as e:
    logger.error(f"Error al montar directorio 'templates': {e}")

# Cargar index.html
INDEX_HTML = ""
try:
    with open("templates/index.html", "r", encoding="utf-8") as f:
        INDEX_HTML = f.read()
    logger.info("Archivo index.html cargado correctamente")
except Exception as e:
    logger.error(f"Error al cargar index.html: {e}")
    INDEX_HTML = "<html><body><h1>Error: No se pudo cargar index.html</h1></body></html>"

# Sectores disponibles en rampa
ALLOWED_SECTORS = [
    "Maletero", "Cintero", "Tractorista", "Equipos", "Supervisor",
    "Jefatura", "Movilero", "Señalero", "Pañolero"
]

# Prefijos de aerolíneas objetivo (Aerolíneas Argentinas, LATAM, Flybondi, JetSmart, Gol, etc.)
TARGET_AIRLINES = ["AR", "ARG", "LA", "LAN", "JJ", "TAM", "LP", "LPE", "XL", "LNE", "4M", "DSM", "WJ", "FO", "FB", "G3", "GLO"]

# Caché global para servir vuelos en tiempo real
global_flights_cache = {"flights": []}

# Modelos Pydantic para validación
class TokenValidationRequest(BaseModel):
    token: str

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
        val = v.strip()
        if not val.isdigit() or len(val) not in [5, 6]:
            raise ValueError('El legajo debe ser un número de 5 o 6 dígitos')
        return val

    @validator('sector')
    def validate_sector(cls, v):
        if v not in ALLOWED_SECTORS:
            raise ValueError('Sector no válido')
        return v.strip()

    @validator('password')
    def validate_password(cls, v):
        if len(v) < 4:
            raise ValueError('La contraseña debe tener al menos 4 caracteres')
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
        val = v.strip()
        if not val.isdigit() or len(val) not in [5, 6]:
            raise ValueError('El legajo debe ser un número de 5 o 6 dígitos')
        return val

# Ruta raíz
@app.get("/")
async def read_root():
    # Recargar index.html dinámicamente si cambió
    global INDEX_HTML
    try:
        with open("templates/index.html", "r", encoding="utf-8") as f:
            INDEX_HTML = f.read()
    except Exception as e:
        logger.error(f"Error recargando index.html: {e}")
    
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

@app.get("/sw.js")
async def get_service_worker():
    return FileResponse("handlysw.js", media_type="application/javascript")

# Inicializar base de datos SQLite
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
        logger.info("Base de datos chat_history.db inicializada correctamente")
    except Exception as e:
        logger.error(f"Error al inicializar la base de datos: {e}")

# Estructuras de datos para control de WebSockets
users: Dict[str, Dict[str, any]] = {}
audio_queue: asyncio.Queue = asyncio.Queue()
groups: Dict[str, List[str]] = {}

# Persistence helper for valid tokens (SQLite fallback)
def load_all_valid_tokens() -> Set[str]:
    tokens = set()
    try:
        with sqlite3.connect("chat_history.db") as conn:
            c = conn.cursor()
            c.execute("SELECT token FROM sessions")
            for row in c.fetchall():
                tokens.add(row[0])
    except Exception as e:
        logger.error(f"Error cargando tokens persistentes: {e}")
    return tokens

valid_tokens = load_all_valid_tokens()

@app.post("/register")
async def register_user(request: RegisterRequest):
    surname = request.surname
    employee_id = request.employee_id
    sector = request.sector
    password = request.password

    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT surname FROM users WHERE employee_id = ?", (employee_id,))
        if c.fetchone():
            logger.error(f"Legajo ya registrado: {employee_id}")
            raise HTTPException(status_code=400, detail="Legajo ya registrado")

        hashed_password = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        c.execute("INSERT INTO users (surname, employee_id, sector, password) VALUES (?, ?, ?, ?)",
                  (surname, employee_id, sector, hashed_password))
        conn.commit()
    
    logger.info(f"Usuario registrado: {surname} ({employee_id}, {sector})")
    return {"message": "Registro exitoso"}

# Validación de token
@app.post("/validate-token")
async def validate_token(request: TokenValidationRequest):
    token = request.token
    if not token:
        logger.error("Token no proporcionado en la solicitud")
        raise HTTPException(status_code=400, detail="Token no proporcionado")
    
    try:
        decoded = base64.b64decode(token).decode("utf-8")
        parts = decoded.split("_")
        if len(parts) != 3:
            logger.error(f"Token mal formateado: {token}")
            raise HTTPException(status_code=401, detail="Formato de token inválido")
        
        employee_id, surname, sector = parts
        if token not in valid_tokens:
            logger.error(f"Token no registrado: {token}")
            raise HTTPException(status_code=401, detail="Token no registrado")
        
        return {"status": "valid"}
    except Exception as e:
        logger.error(f"Error al validar token {token}: {str(e)}")
        raise HTTPException(status_code=401, detail="Token inválido")

@app.post("/login")
async def login_user(request: LoginRequest):
    surname = request.surname
    employee_id = request.employee_id
    password = request.password

    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT surname, employee_id, sector, password FROM users WHERE employee_id = ?",
                  (employee_id,))
        user = c.fetchone()

    if not user:
        logger.error(f"Credenciales inválidas para {surname}: {employee_id}")
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    stored_password = user[3]
    stored_bytes = stored_password.encode('utf-8') if isinstance(stored_password, str) else stored_password
    if not bcrypt.checkpw(password.encode('utf-8'), stored_bytes):
        logger.error(f"Contraseña incorrecta para {surname}: {employee_id}")
        raise HTTPException(status_code=401, detail="Contraseña incorrecta")

    sector = user[2]
    token_data = f"{employee_id}_{surname}_{sector}"
    token = base64.b64encode(token_data.encode('utf-8')).decode('utf-8')
    valid_tokens.add(token)
    save_session(token, token_data, surname, sector)
    logger.info(f"Login exitoso: {surname} ({employee_id}, {sector})")
    return {"token": token, "message": "Inicio de sesión exitoso"}

# Endpoint para generar anuncios TTS (Text to Speech)
@app.get("/announcement/{flight_number}/{destination}")
async def generate_announcement(flight_number: str, destination: str):
    text = f"El vuelo {flight_number} con destino a {destination} está próximo a despegar."
    tts = gTTS(text=text, lang='es')
    
    # Resolver ruta de forma portable para Windows/Linux
    temp_dir = "temp_announcements"
    os.makedirs(temp_dir, exist_ok=True)
    audio_path = os.path.join(temp_dir, f"{flight_number}_announcement.mp3")
    
    # Guardar audio
    tts.save(audio_path)
    logger.info(f"Anuncio generado para {flight_number} a {destination}")
    return FileResponse(audio_path, media_type="audio/mpeg", filename=f"{flight_number}_announcement.mp3")

# Endpoint de consulta de vuelos
@app.get("/api/flights")
async def get_flights(query: Optional[str] = None):
    flights = global_flights_cache.get("flights", [])
    if query:
        query = query.lower().strip()
        flights = [
            f for f in flights
            if query in f["flight_number"].lower() or
               query in f["destination"].lower() or
               query in f["origin"].lower() or
               query in f["status"].lower() or
               (f["registration"] and query in f["registration"].lower())
        ]
    return {"flights": flights}

# Consulta de detalles de un vuelo
@app.get("/flight_details/{flight_number}")
async def get_flight_details(flight_number: str):
    flights = global_flights_cache.get("flights", [])
    flight_data = next((f for f in flights if f["flight_number"].lower() == flight_number.lower()), None)
    if not flight_data:
        raise HTTPException(status_code=404, detail="Vuelo no encontrado")
    return flight_data

# --- SCRAPER TAMS & AIRPLANES.LIVE ---

def scrape_tams_side(mov_type="A") -> List[Dict]:
    url = "http://www.tams.com.ar/ORGANISMOS/Vuelos.aspx"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    
    flights = []
    try:
        session = requests.Session()
        # 1. Obtener claves ASP.NET
        r = session.get(url, headers=headers, timeout=10)
        logger.info(f"TAMS GET status: {r.status_code} | len={len(r.text)}")
        soup = BeautifulSoup(r.text, 'html.parser')
        
        viewstate = soup.find('input', {'name': '__VIEWSTATE'}).get('value') if soup.find('input', {'name': '__VIEWSTATE'}) else ''
        eventvalidation = soup.find('input', {'name': '__EVENTVALIDATION'}).get('value') if soup.find('input', {'name': '__EVENTVALIDATION'}) else ''
        viewstategenerator = soup.find('input', {'name': '__VIEWSTATEGENERATOR'}).get('value') if soup.find('input', {'name': '__VIEWSTATEGENERATOR'}) else ''
        logger.info(f"TAMS VIEWSTATE len={len(viewstate)} EVENTVALIDATION len={len(eventvalidation)}")
        
        # 2. Hacer consulta POST para el aeropuerto SABE (Aeroparque)
        payload = {
            "__VIEWSTATE": viewstate,
            "__VIEWSTATEGENERATOR": viewstategenerator,
            "__EVENTVALIDATION": eventvalidation,
            "__EVENTTARGET": "",
            "__EVENTARGUMENT": "",
            "__LASTFOCUS": "",
            "ddlMovTp": mov_type,
            "ddlAeropuerto": "AEP",
            "ddlSector": "-1",
            "ddlAerolinea": "-1",
            "ddlAterrizados": "TODOS",
            "ddlVentanaH": "12",
            "btnBuscar": "Buscar"
        }
        
        r_post = session.post(url, data=payload, headers=headers, timeout=10)
        r_post.encoding = r_post.apparent_encoding or 'utf-8'
        logger.info(f"TAMS POST status: {r_post.status_code} | len={len(r_post.text)}")

        soup_post = BeautifulSoup(r_post.text, 'html.parser')
        
        grid_id = "dgGrillaA" if mov_type == "A" else "dgGrillaD"
        table = soup_post.find('table', {'id': grid_id})
        
        logger.info(f"TAMS {mov_type}: tabla '{grid_id}' {'encontrada' if table else 'NO encontrada'}")
        if table:
            rows = table.find_all('tr')
            # Saltar fila de encabezado
            for row in rows[1:]:
                cells = [td.text.strip() for td in row.find_all('td')]
                if len(cells) < 6:
                    continue
                
                airline = cells[0].strip().upper()
                if airline not in TARGET_AIRLINES:
                    continue
                
                flight_number = cells[1].strip()
                scheduled_time = cells[2].strip()
                registration = cells[3].strip() if len(cells) > 3 else "N/A"
                position = cells[4].strip() if len(cells) > 4 else "N/A"
                
                if mov_type == "A":
                    origin = cells[11].strip() if len(cells) > 11 else (cells[9].strip() if len(cells) > 9 else "Desconocido")
                    destination = "SABE"
                    eta = cells[5].strip() if len(cells) > 5 else "N/A"
                    status = cells[13].strip() if len(cells) > 13 else (cells[12].strip() if len(cells) > 12 else "Programado")
                else:
                    origin = "SABE"
                    destination = cells[11].strip() if len(cells) > 11 else (cells[9].strip() if len(cells) > 9 else "Desconocido")
                    eta = cells[5].strip() if len(cells) > 5 else "N/A"
                    gate = cells[10].strip() if len(cells) > 10 else "N/A"
                    if gate and gate != "" and gate != "N/A":
                        position = gate
                    status = cells[13].strip() if len(cells) > 13 else (cells[12].strip() if len(cells) > 12 else "Programado")
                
                flights.append({
                    "flight_number": f"{airline}{flight_number}",
                    "registration": registration if registration and registration != "" else "N/A",
                    "sta": scheduled_time,
                    "eta": eta if eta and eta != "" else "N/A",
                    "origin": origin,
                    "destination": destination,
                    "status": status if status and status != "" else "Programado",
                    "position": position if position and position != "" else "N/A",
                    "airline": airline,
                    "type": "arrival" if mov_type == "A" else "departure"
                })
    except Exception as e:
        logger.error(f"Error scraping TAMS {mov_type}: {e}")
        
    return flights

async def get_airplanes_live_data() -> List[Dict]:
    url = "https://api.airplanes.live/v2/point/-34.5597/-58.4116/250"
    headers = {
        "User-Agent": "Mozilla/5.0"
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=10) as response:
                if response.status == 200:
                    data = await response.json()
                    return data.get("ac", [])
                else:
                    logger.error(f"Error al obtener datos de Airplanes.Live: {response.status}")
                    return []
    except Exception as e:
        logger.error(f"Excepción al obtener datos de Airplanes.Live: {str(e)}")
        return []

# FR24 API token
FR24_TOKEN = os.getenv("FLIGHTRADAR24_TOKEN_PRIMARY", "")

async def get_fr24_flights(airport_iata: str = "AEP") -> List[Dict]:
    """Fetch live flight data from FlightRadar24 API for a given airport."""
    if not FR24_TOKEN:
        logger.warning("No FR24 token available")
        return []
    token = FR24_TOKEN.split("|")[1] if "|" in FR24_TOKEN else FR24_TOKEN
    url = f"https://fr24api.flightradar24.com/api/live/flight-positions/light"
    headers = {
        "Accept": "application/json",
        "Accept-Version": "v1",
        "Authorization": f"Bearer {token}"
    }
    params = {"airports": airport_iata, "limit": 100}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, params=params, timeout=15) as resp:
                logger.info(f"FR24 API status for {airport_iata}: {resp.status}")
                if resp.status == 200:
                    data = await resp.json()
                    flights = data.get("data", [])
                    logger.info(f"FR24 {airport_iata}: {len(flights)} vuelos obtenidos")
                    return flights
                else:
                    body = await resp.text()
                    logger.error(f"FR24 API error {resp.status}: {body[:200]}")
                    return []
    except Exception as e:
        logger.error(f"Error consultando FR24 API: {e}", exc_info=True)
        return []

async def get_combined_flights() -> List[Dict]:
    loop = asyncio.get_event_loop()
    # 1. Scrapear TAMS en paralelo
    try:
        tams_arr = await loop.run_in_executor(None, scrape_tams_side, "A")
    except Exception as e:
        logger.error(f"Error scraping arrivals: {e}", exc_info=True)
        tams_arr = []
        
    try:
        tams_dep = await loop.run_in_executor(None, scrape_tams_side, "D")
    except Exception as e:
        logger.error(f"Error scraping departures: {e}", exc_info=True)
        tams_dep = []
        
    tams_data = tams_arr + tams_dep
    logger.info(f"TAMS arrivals: {len(tams_arr)} | TAMS departures: {len(tams_dep)} | Total TAMS: {len(tams_data)}")
    
    # 2. Consultar radares geográficos de Airplanes.Live
    airplanes_data = await get_airplanes_live_data()
    logger.info(f"Airplanes.Live raw planes cerca del área: {len(airplanes_data)}")
    
    # 2b. Consultar FlightRadar24 API (token disponible) como fuente adicional
    fr24_data = await get_fr24_flights("AEP")
    logger.info(f"FR24 vuelos AEP: {len(fr24_data)}")
    
    # Merge FR24 data into airplanes_data format if FR24 returned data
    if fr24_data:
        # FR24 data format: {callsign, lat, lon, alt_baro, gspeed, reg, type, ...}
        for fr in fr24_data:
            callsign = (fr.get("callsign") or fr.get("flightId") or "").strip()
            if not callsign:
                continue
            # Check if this plane is already in airplanes_data by registration
            reg = fr.get("reg", "").strip()
            already_exists = any(
                (a.get("r", "").strip().upper() == reg.upper() and reg) or
                (a.get("flight", "").strip().upper() == callsign.upper())
                for a in airplanes_data
            )
            if not already_exists:
                airplanes_data.append({
                    "flight": callsign,
                    "r": reg,
                    "lat": fr.get("lat"),
                    "lon": fr.get("lon"),
                    "alt_geom": fr.get("alt_baro") or fr.get("alt"),
                    "gs": fr.get("gspeed") or fr.get("spd"),
                    "vert_rate": fr.get("vspeed"),
                    "t": fr.get("type", "N/A"),
                    "orig": fr.get("orig_iata") or fr.get("orig") or "N/A",
                    "dest": fr.get("dest_iata") or fr.get("dest") or "N/A",
                })
    logger.info(f"Total airplanes tras merge FR24+Airplanes.Live: {len(airplanes_data)}")

    
    combined_data = []
    icao_to_iata = {
        "ARG": "AR",
        "LAN": "LA",
        "TAM": "JJ",
        "LPE": "LP",
        "LNE": "XL",
        "DSM": "4M",
        "FBZ": "FO",
        "JAT": "WJ",
        "GLO": "G3"
    }
    
    # 3. Cruzar datos de radares activos
    for plane in airplanes_data:
        flight = plane.get("flight", "").strip()
        registration = plane.get("r", "").strip()
        
        # Validar si el prefijo de vuelo corresponde a nuestras aerolíneas de interés
        is_target = False
        if flight:
            if flight.startswith("ARG"):
                is_target = True
            elif any(flight.startswith(prefix) for prefix in ["LAN", "TAM", "LPE", "LNE", "DSM", "LAP", "FBZ", "JAT", "GLO"]):
                is_target = True
            elif any(flight.startswith(prefix) for prefix in TARGET_AIRLINES):
                is_target = True
                
        if is_target:
            iata_flight = flight
            for icao, iata in icao_to_iata.items():
                if flight.startswith(icao):
                    iata_flight = flight.replace(icao, iata, 1)
                    break
            
            raw_orig = plane.get("orig") or ""
            raw_dest = plane.get("dest") or ""
            # Default to SABE for planes without origin/destination (they're within AEP radius)
            origin = raw_orig if raw_orig and raw_orig not in ("", "N/A") else "SABE"
            destination = raw_dest if raw_dest and raw_dest not in ("", "N/A") else "SABE"
            plane_info = {
                "flight_number": iata_flight,
                "registration": registration if registration else "N/A",
                "lat": plane.get("lat"),
                "lon": plane.get("lon"),
                "altitude": plane.get("alt_geom"),
                "ground_speed": plane.get("gs"),
                "vertical_rate": plane.get("vert_rate"),
                "origin": origin,
                "destination": destination,
                "status": "En vuelo",
                "color": "green",
                "position": "N/A",
                "sta": None,
                "eta": None,
                "airline": iata_flight[:2],
                "aircraft_type": plane.get("t", "N/A"),
            }
            
            # Cruzar con TAMS para rellenar horarios y posiciones
            for tams_flight in tams_data:
                t_reg = tams_flight["registration"].replace("-", "").replace(" ", "").upper()
                p_reg = registration.replace("-", "").replace(" ", "").upper()
                
                # Normalizar números de vuelo (ej: AR1361 vs AR 1361)
                t_fl = tams_flight["flight_number"].replace(" ", "").upper()
                p_fl = iata_flight.replace(" ", "").upper()
                
                # Intentar cruce también por el número numérico puro de vuelo (ej: 1361)
                t_num = "".join(filter(str.isdigit, t_fl))
                p_num = "".join(filter(str.isdigit, p_fl))
                
                if (t_reg != "N/A" and t_reg == p_reg) or t_fl == p_fl or (t_num != "" and t_num == p_num):
                    status = tams_flight.get("status", "En vuelo")
                    color = "green"
                    if "demorado" in status.lower() or "dem" in status.lower():
                        color = "orange"
                    elif "cancelado" in status.lower() or "can" in status.lower():
                        color = "red"
                    elif "arribado" in status.lower() or "arr" in status.lower():
                        color = "gray"
                    elif "embarcando" in status.lower() or "emb" in status.lower() or "pre" in status.lower():
                        color = "yellow"
                    
                    plane_info.update({
                        "sta": tams_flight["sta"],
                        "eta": tams_flight.get("eta") if tams_flight.get("eta") != "N/A" else tams_flight["sta"],
                        "position": tams_flight["position"],
                        "origin": tams_flight["origin"],
                        "destination": tams_flight["destination"],
                        "status": status,
                        "color": color
                    })
                    break
            combined_data.append(plane_info)
            
    # 4. Añadir vuelos de TAMS que aún no están en vuelo (programados en tierra)
    for tams_flight in tams_data:
        already_added = False
        t_reg = tams_flight["registration"].replace("-", "").replace(" ", "").upper()
        t_fl = tams_flight["flight_number"].replace(" ", "").upper()
        
        for plane in combined_data:
            p_reg = plane["registration"].replace("-", "").replace(" ", "").upper()
            p_fl = plane["flight_number"].replace(" ", "").upper()
            if (t_reg != "N/A" and t_reg == p_reg) or t_fl == p_fl:
                already_added = True
                break
                
        if not already_added:
            status = tams_flight.get("status", "Programado")
            color = "blue"
            if "embarcando" in status.lower() or "emb" in status.lower() or "pre" in status.lower():
                color = "yellow"
            elif "demorado" in status.lower() or "dem" in status.lower():
                color = "orange"
            elif "cancelado" in status.lower() or "can" in status.lower():
                color = "red"
            elif "arribado" in status.lower() or "arr" in status.lower():
                color = "gray"
                
            combined_data.append({
                "flight_number": tams_flight["flight_number"],
                "registration": tams_flight["registration"],
                "sta": tams_flight["sta"],
                "eta": tams_flight["eta"],
                "origin": tams_flight["origin"],
                "destination": tams_flight["destination"],
                "status": status,
                "color": color,
                "position": tams_flight["position"],
                "airline": tams_flight["airline"],
                "lat": None,
                "lon": None,
                "altitude": None,
                "ground_speed": None,
                "vertical_rate": None,
                "aircraft_type": "N/A",
            })
            
    logger.info(f"Combined flights total: {len(combined_data)}")
    return combined_data

# Helper para parsear la hora STD del TAMS (ej: "14:30")
def parse_std_time(std_str: str) -> Optional[datetime]:
    if not std_str:
        return None
    # STD puede ser "07/07 14:30" o sólo "14:30"
    std_str = std_str.strip()
    try:
        if " " in std_str:
            # "07/07 14:30"
            date_part, time_part = std_str.split(" ")
            day, month = map(int, date_part.split("/"))
            hour, minute = map(int, time_part.split(":"))
            now = datetime.now()
            return now.replace(month=month, day=day, hour=hour, minute=minute, second=0, microsecond=0)
        else:
            # "14:30"
            hour, minute = map(int, std_str.split(":"))
            now = datetime.now()
            return now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    except Exception:
        return None

# --- COMUNICACIÓN Y MENSAJERÍA ---

# Base de datos local
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

# Transcribir audio a texto (Google Speech Recognition con fallback sf)
async def transcribe_audio(audio_data: str) -> str:
    try:
        audio_bytes = base64.b64decode(audio_data)
        
        # 1. Intentar con soundfile primero para evitar dependencia de ffmpeg/Pydub
        try:
            with io.BytesIO(audio_bytes) as audio_file:
                data, samplerate = sf.read(audio_file)
                # Exportar a WAV en memoria
                with io.BytesIO() as wav_io:
                    sf.write(wav_io, data, samplerate, format='WAV', subtype='PCM_16')
                    wav_io.seek(0)
                    recognizer = sr.Recognizer()
                    with sr.AudioFile(wav_io) as source:
                        recorded_audio = recognizer.record(source)
                        text = recognizer.recognize_google(recorded_audio, language="es-ES")
                        logger.info("Audio transcrito exitosamente usando SoundFile.")
                        return text
        except Exception as sf_err:
            logger.warn(f"SoundFile no pudo transcribir, intentando Pydub: {sf_err}")
            
        # 2. Fallback a Pydub/FFmpeg tradicional
        with io.BytesIO(audio_bytes) as audio_file:
            audio_segment = AudioSegment.from_file(audio_file, format="webm")
            audio_segment = audio_segment.set_channels(1).set_frame_rate(16000)
            with io.BytesIO() as wav_io:
                audio_segment.export(wav_io, format="wav")
                wav_io.seek(0)
                recognizer = sr.Recognizer()
                with sr.AudioFile(wav_io) as source:
                    recorded_audio = recognizer.record(source)
                    text = recognizer.recognize_google(recorded_audio, language="es-ES")
                    logger.info("Audio transcrito exitosamente usando Pydub.")
                    return text
    except Exception as e:
        logger.error(f"Error al transcribir el audio en todos los métodos: {e}")
        return "Transcripción no disponible"

# Procesar cola de audio de WebSockets
async def process_audio_queue():
    while True:
        try:
            item = await audio_queue.get()
            token, audio_data, message = item

            sender = message.get("sender", "Unknown")
            function = message.get("function", "Unknown")
            text = message.get("text", "Sin transcripción")
            timestamp = message.get("timestamp", datetime.utcnow().strftime("%H:%M"))

            if app_state["global_mute_active"]:
                continue

            if text == "Sin transcripción" or text == "Pendiente de transcripción":
                text = await transcribe_audio(audio_data)

            user_id = f"{sender}_{function}"
            save_message(user_id, audio_data, text, timestamp)

            group_id = message.get("group_id")
            is_group = message.get("type") == "group_message" or group_id is not None
            
            # Include sender_id so clients can properly detect if message is theirs
            sender_id = f"{sender}_{function}"
            sender_token = message.get("sender_token", token)
            broadcast_payload = {
                "type": "group_message" if is_group else "message",
                "sender": sender,
                "sender_id": sender_id,
                "sender_token": sender_token,
                "function": function,
                "text": text,
                "timestamp": timestamp,
                "audio": audio_data
            }
            if is_group:
                broadcast_payload["group_id"] = group_id
            
            disconnected_users = []
            for user_token, user in list(users.items()):
                if not user["logged_in"] or not user["websocket"]:
                    disconnected_users.append(user_token)
                    continue
                # If it's a group message, send only to group members
                if is_group and user.get("group_id") != group_id:
                    continue
                
                muted_users = user.get("muted_users", set())
                # Only skip if this user muted the sender (not if they are the sender)
                if sender_id in muted_users and user_token != token:
                    continue
                try:
                    await user["websocket"].send_json(broadcast_payload)
                except Exception as e:
                    logger.error(f"Error al enviar audio a {user['name']}: {e}")
                    disconnected_users.append(user_token)

            for user_token in disconnected_users:
                if user_token in users:
                    users[user_token]["websocket"] = None
                    users[user_token]["logged_in"] = False
            if disconnected_users:
                await broadcast_users()

            audio_queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error procesando la cola de audio: {e}")

# Limpiar mensajes antiguos
async def clear_messages():
    while True:
        try:
            now = datetime.utcnow()
            # Programar a las 5:30 UTC todos los días
            start_time = now.replace(hour=5, minute=30, second=0, microsecond=0)
            if now >= start_time:
                start_time += timedelta(days=1)
            await asyncio.sleep((start_time - now).total_seconds())
            
            with sqlite3.connect("chat_history.db") as conn:
                c = conn.cursor()
                expiration_time = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
                c.execute("DELETE FROM messages WHERE date < ?", (expiration_time,))
                conn.commit()
                logger.info(f"Mensajes anteriores a 24 horas eliminados.")
        except Exception as e:
            logger.error(f"Error al limpiar mensajes: {e}")

# Limpiar sesiones expiradas
async def clean_expired_sessions():
    while True:
        try:
            with sqlite3.connect("chat_history.db") as conn:
                c = conn.cursor()
                expiration_time = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
                c.execute("DELETE FROM sessions WHERE last_active < ?", (expiration_time,))
                conn.commit()
        except Exception as e:
            logger.error(f"Error al limpiar sesiones: {e}")
        await asyncio.sleep(3600)

# Envío masivo de la lista de usuarios conectados
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
            
    for token, user in list(users.items()):
        if user["logged_in"] and user["websocket"]:
            try:
                await user["websocket"].send_json({
                    "type": "user_list",
                    "users": user_list
                })
            except Exception as e:
                logger.error(f"Error enviando lista de usuarios a {user['name']}: {e}")

async def broadcast_message(message: Dict):
    disconnected_users = []
    for token, user in list(users.items()):
        if not user["logged_in"] or not user["websocket"]:
            disconnected_users.append(token)
            continue
        try:
            await user["websocket"].send_json(message)
        except Exception as e:
            logger.error(f"Error al enviar mensaje general: {e}")
            disconnected_users.append(token)
            
    for token in disconnected_users:
        if token in users:
            users[token]["websocket"] = None
            users[token]["logged_in"] = False
    if disconnected_users:
        await broadcast_users()

# Loop periódico de vuelos y anuncios
async def update_flights_loop():
    while True:
        try:
            if app_state["updates_enabled"]:
                # Resetear tokens diarios si es un nuevo día
                if datetime.now() >= app_state["day_reset"]:
                    app_state["daily_token_count"] = 0
                    app_state["day_reset"] = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
                
                # Obtener vuelos y guardarlos en caché
                flights = await get_combined_flights()
                global_flights_cache["flights"] = flights
                logger.info(f"Datos de vuelos actualizados en caché ({len(flights)} vuelos cargados).")
                
                # Emitir a los clientes
                disconnected_users = []
                for token, user in list(users.items()):
                    if not user["logged_in"] or not user["websocket"]:
                        disconnected_users.append(token)
                        continue
                    try:
                        await user["websocket"].send_json({
                            "type": "flight_update",
                            "flights": flights
                        })
                    except Exception:
                        disconnected_users.append(token)
                        
                for token in disconnected_users:
                    if token in users:
                        users[token]["websocket"] = None
                        users[token]["logged_in"] = False
                if disconnected_users:
                    await broadcast_users()
                
                # Disparar anuncios automáticos si corresponde
                for flight in flights:
                    flight_number = flight['flight_number']
                    status = flight['status']
                    destination = flight['destination']
                    origin = flight['origin']
                    
                    # Anuncio de despegues (salidas de SABE)
                    if origin == "SABE" and flight_number not in app_state['announced_flights'] and status in ["Preembarque", "Embarcando", "Cerrado", "Próximo a despegar"]:
                        dep_time = parse_std_time(flight.get("sta"))
                        if dep_time:
                            diff_seconds = (dep_time - datetime.now()).total_seconds()
                            # Anunciar si el vuelo está a menos de 30 minutos de despegar
                            if 0 <= diff_seconds <= 1800:
                                app_state['announced_flights'].add(flight_number)
                                announcement_url = f"/announcement/{flight_number}/{destination}"
                                await broadcast_message({
                                    "type": "message",  # El cliente espera tipo 'message'
                                    "sender": "Sistema",
                                    "function": "Anuncio",
                                    "text": f"El vuelo {flight_number} con destino a {destination} está próximo a despegar.",
                                    "timestamp": datetime.utcnow().strftime("%H:%M"),
                                    "audio": f"/announcement/{flight_number}/{destination}"
                                })
                                logger.info(f"TTS automático disparado: {flight_number}")
        except Exception as e:
            logger.error(f"Error en update_flights_loop: {e}")
            
        await asyncio.sleep(60)  # Actualizar cada 1 minuto para mayor tiempo real

# Endpoint de WebSockets principal
@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    logger.info(f"Cliente intentando conectar con WebSocket: {token[:15]}...")

    try:
        try:
            decoded_token = base64.b64decode(token).decode('utf-8')
            employee_id, surname, sector = decoded_token.split('_')
        except Exception as e:
            logger.error(f"Error decodificando token WebSocket {token[:15]}...: {str(e)}")
            await websocket.send_json({"type": "error", "message": "Token inválido"})
            await websocket.close()
            return

        # Verificar en DB
        with sqlite3.connect("chat_history.db") as conn:
            c = conn.cursor()
            c.execute("SELECT surname, employee_id, sector FROM users WHERE surname = ? AND employee_id = ? AND sector = ?",
                      (surname, employee_id, sector))
            user = c.fetchone()

        # Dynamically restore valid token inside set to prevent disconnect rejection on reboot
        valid_tokens.add(token)

        if not user:
            logger.error(f"Usuario del token no registrado: {surname}")
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
            logger.info(f"Sesión restaurada para: {session['name']}")
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
            logger.info(f"Sesión nueva para: {surname}")

        # Confirmación de conexión exitosa
        await websocket.send_json({"type": "connection_success", "message": "Conectado"})
        
        # Enviar historial al usuario
        history = get_history()
        for msg in history:
            # Re-formatear del almacenamiento
            # msg['user_id'] es 'surname_sector'
            parts = msg['user_id'].split('_')
            snd = parts[0] if len(parts) > 0 else 'Unknown'
            fn = parts[1] if len(parts) > 1 else 'Rampa'
            sender_id = f"{snd}_{fn}"
            await websocket.send_json({
                "type": "message",
                "sender": snd,
                "sender_id": sender_id,
                "function": fn,
                "text": msg["text"],
                "timestamp": msg["timestamp"],
                "audio": msg["audio"]
            })
        
        # Señal para que el frontend sepa que terminó el historial y active el auto-play
        await websocket.send_json({"type": "history_end"})
            
        # Enviar lista de vuelos inicial
        await websocket.send_json({
            "type": "flight_update",
            "flights": global_flights_cache.get("flights", [])
        })
        
        await broadcast_users()

        # Escuchar mensajes entrantes del WebSocket
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                continue

            msg_type = message.get("type")
            
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
                save_session(
                    token,
                    users[token]["user_id"],
                    users[token]["name"],
                    users[token]["function"],
                    users[token]["group_id"],
                    users[token]["muted_users"]
                )
                
            elif msg_type == "toggle_updates":
                app_state["updates_enabled"] = message.get("enabled", True)
                await websocket.send_json({"type": "updates_status", "enabled": app_state["updates_enabled"]})
                
            elif msg_type == "refresh_users":
                # Client requests fresh user list (called periodically for live updates)
                await broadcast_users()
                
            elif msg_type in ["audio", "message", "group_message"]:
                # Accept 'audio' (legacy), 'message' (normal chat) and 'group_message' types
                audio_data = message.get("data") or message.get("audio")
                # Always normalize sender to the authenticated user's name/function from the server
                message["sender"] = users[token].get("name", "Unknown")
                message["function"] = users[token].get("function", "Unknown")
                message["sender_token"] = token  # Include token so broadcast can match sender
                if audio_data:
                    await audio_queue.put((token, audio_data, message))
                    
            elif msg_type == "logout":
                users[token]["logged_in"] = False
                delete_session(token)
                if token in users:
                    del users[token]
                await websocket.send_json({"type": "logout_success", "message": "Sesión cerrada"})
                await broadcast_users()
                await websocket.close()
                break
                
            elif msg_type == "mute_user":
                target = message.get("target_user_id")
                if target:
                    users[token]["muted_users"].add(target)
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        users[token]["group_id"],
                        users[token]["muted_users"]
                    )
                    
            elif msg_type == "unmute_user":
                target = message.get("target_user_id")
                if target:
                    users[token]["muted_users"].discard(target)
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        users[token]["group_id"],
                        users[token]["muted_users"]
                    )
                    
            elif msg_type == "create_group":
                group_id = message.get("group_id")
                if group_id:
                    groups[group_id] = [token]
                    users[token]["group_id"] = group_id
                    save_session(
                        token,
                        users[token]["user_id"],
                        users[token]["name"],
                        users[token]["function"],
                        group_id,
                        users[token]["muted_users"]
                    )
                    await websocket.send_json({"type": "group_joined", "group_id": group_id})
                    await broadcast_users()
                    
            elif msg_type == "join_group":
                group_id = message.get("group_id")
                if group_id:
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
                    await websocket.send_json({"type": "group_joined", "group_id": group_id})
                    await broadcast_users()
                    
            elif msg_type == "leave_group":
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
                await websocket.send_json({"type": "group_left"})
                await broadcast_users()
                
            elif msg_type == "flight_details_request":
                flight_number = message.get("flight_number")
                if flight_number:
                    try:
                        fd = await get_flight_details(flight_number)
                        await websocket.send_json({
                            "type": "flight_details_response",
                            "flight": fd
                        })
                    except Exception as e:
                        await websocket.send_json({
                            "type": "flight_details_error",
                            "message": str(e)
                        })

    except WebSocketDisconnect:
        logger.info(f"Cliente desconectado: {token[:15]}...")
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
        logger.error(f"Excepción en conexión WebSocket {token[:15]}...: {str(e)}")
        if token in users:
            users[token]["websocket"] = None
            users[token]["logged_in"] = False
            await broadcast_users()
        await websocket.close()

@app.get("/history")
async def get_history_endpoint():
    return get_history()

@app.get("/api/history")
async def get_api_history_endpoint():
    return get_history()

# Evento de inicio del servidor FastAPI
@app.on_event("startup")
async def startup_event():
    try:
        logger.info("Iniciando aplicación HANDLEPHONE...")
        init_db()
        
        # Cargar datos de vuelos inicialmente antes de arrancar las tareas en segundo plano
        logger.info("Pre-cargando vuelos de TAMS y radares...")
        try:
            flights = await get_combined_flights()
            global_flights_cache["flights"] = flights
            logger.info(f"Carga inicial de vuelos completada: {len(flights)} vuelos.")
        except Exception as e:
            logger.error(f"Error precargando vuelos: {e}")
            
        # Programar loops asíncronos en segundo plano
        asyncio.create_task(clear_messages())
        asyncio.create_task(process_audio_queue())
        asyncio.create_task(update_flights_loop())
        asyncio.create_task(clean_expired_sessions())
        logger.info("Tareas en segundo plano programadas exitosamente.")
    except Exception as e:
        logger.error(f"Error grave en el inicio de FastAPI: {e}")
        raise

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    logger.info(f"Ejecutando servidor Uvicorn en el puerto: {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)

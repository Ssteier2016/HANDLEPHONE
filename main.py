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
import speech_recognition as sr
import io
import soundfile as sf
from pydub import AudioSegment
from dotenv import load_dotenv
from pydantic import BaseModel, validator
import bcrypt

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
    "updates_enabled": True,  # Interruptor para actualizaciones
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

# Modelos Pydantic para validación
class TokenValidationRequest(BaseModel):
    token: str

class RegisterRequest(BaseModel):
    surname: str
    password: str

    @validator('surname')
    def validate_surname(cls, v):
        if not v.strip().replace(' ', '').isalpha():
            raise ValueError('El apellido debe contener solo letras')
        return v.strip().capitalize()

    @validator('password')
    def validate_password(cls, v):
        if len(v) < 4:
            raise ValueError('La contraseña debe tener al menos 4 caracteres')
        return v

class LoginRequest(BaseModel):
    surname: str
    password: str

    @validator('surname')
    def validate_surname(cls, v):
        if not v.strip().replace(' ', '').isalpha():
            raise ValueError('El apellido debe contener solo letras')
        return v.strip().capitalize()

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
            
            # Dynamically add duration column if it doesn't exist
            try:
                c.execute("ALTER TABLE messages ADD COLUMN duration INTEGER")
            except sqlite3.OperationalError:
                pass # Already exists
                
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
    password = request.password
    
    # Generar legajo simulado y sector por defecto de manera determinista basados en el apellido
    import hashlib
    hash_val = int(hashlib.md5(surname.encode('utf-8')).hexdigest(), 16)
    employee_id = str(10000 + (hash_val % 90000))  # Legajo de 5 dígitos determinista
    sector = "Operador"

    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT employee_id, password FROM users WHERE surname = ?", (surname,))
        user_exists = c.fetchone()
        
        hashed_password = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        if user_exists:
            # Sobrescribir contraseña y actualizar información
            c.execute("UPDATE users SET sector = ?, password = ? WHERE surname = ?",
                      (sector, hashed_password, surname))
            conn.commit()
            logger.info(f"Contraseña actualizada/recuperada para: {surname}")
            return {"message": "Contraseña actualizada exitosamente"}
        else:
            # Registrar nuevo usuario
            c.execute("INSERT INTO users (surname, employee_id, sector, password) VALUES (?, ?, ?, ?)",
                      (surname, employee_id, sector, hashed_password))
            conn.commit()
            logger.info(f"Usuario registrado: {surname} (Legajo: {employee_id}, Sector: {sector})")
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
    password = request.password

    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT surname, employee_id, sector, password FROM users WHERE surname = ?",
                  (surname,))
        user = c.fetchone()

    if not user:
        logger.error(f"Credenciales inválidas para apellido: {surname}")
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    stored_password = user[3]
    stored_bytes = stored_password.encode('utf-8') if isinstance(stored_password, str) else stored_password
    if not bcrypt.checkpw(password.encode('utf-8'), stored_bytes):
        logger.error(f"Contraseña incorrecta para: {surname}")
        raise HTTPException(status_code=401, detail="Contraseña incorrecta")

    employee_id = user[1]
    sector = user[2]
    token_data = f"{employee_id}_{surname}_{sector}"
    token = base64.b64encode(token_data.encode('utf-8')).decode('utf-8')
    valid_tokens.add(token)
    save_session(token, token_data, surname, sector)
    logger.info(f"Login exitoso: {surname} (Legajo: {employee_id}, Sector: {sector})")
    return {"token": token, "message": "Inicio de sesión exitoso"}

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

def save_message(user_id: str, audio_data: str, text: str, timestamp: str, duration: Optional[int] = None) -> int:
    date = datetime.utcnow().strftime("%Y-%m-%d")
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("INSERT INTO messages (user_id, audio, text, timestamp, date, duration) VALUES (?, ?, ?, ?, ?, ?)",
                  (user_id, audio_data, text, timestamp, date, duration))
        conn.commit()
        return c.lastrowid

def get_history() -> List[Dict]:
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT id, user_id, audio, text, timestamp, date, duration FROM messages ORDER BY date, timestamp")
        rows = c.fetchall()
    return [{"id": row[0], "user_id": row[1], "audio": row[2], "text": row[3], "timestamp": row[4], "date": row[5], "duration": row[6]} for row in rows]

def get_history_since(msg_id: int) -> List[Dict]:
    """Get messages with id > msg_id (for missed-message recovery)."""
    with sqlite3.connect("chat_history.db") as conn:
        c = conn.cursor()
        c.execute("SELECT id, user_id, audio, text, timestamp, date, duration FROM messages WHERE id > ? ORDER BY id", (msg_id,))
        rows = c.fetchall()
    return [{"id": row[0], "user_id": row[1], "audio": row[2], "text": row[3], "timestamp": row[4], "date": row[5], "duration": row[6]} for row in rows]

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
            duration = message.get("duration")
            msg_db_id = save_message(user_id, audio_data, text, timestamp, duration)

            group_id = message.get("group_id")
            target_user_id = message.get("target_user_id")
            
            is_group = message.get("type") == "group_message" or group_id is not None
            is_direct = message.get("type") == "direct_message" or target_user_id is not None
            
            # Include sender_id so clients can properly detect if message is theirs
            sender_id = f"{sender}_{function}"
            sender_token = message.get("sender_token", token)
            broadcast_payload = {
                "type": "group_message" if is_group else ("direct_message" if is_direct else "message"),
                "id": msg_db_id,
                "sender": sender,
                "sender_id": sender_id,
                "sender_token": sender_token,
                "function": function,
                "text": text,
                "timestamp": timestamp,
                "duration": duration,
                "audio": audio_data
            }
            if is_group:
                broadcast_payload["group_id"] = group_id
            if is_direct:
                broadcast_payload["target_user_id"] = target_user_id
            
            disconnected_users = []
            for user_token, user in list(users.items()):
                # Only broadcast to users who have an active socket.
                # If they are logged_in but websocket is None, we don't drop them, we just skip transmitting.
                if not user["logged_in"]:
                    continue
                if not user["websocket"]:
                    continue
                # If it's a group message, send only to group members
                if is_group and user.get("group_id") != group_id:
                    continue
                # If it's a direct message, send only to the sender and the target operator
                if is_direct:
                    dest_user_id = f"{user['name']}_{user['function']}"
                    is_dest = (dest_user_id == target_user_id)
                    is_src = (user_token == token)
                    if not is_dest and not is_src:
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
                    users[user_token]["active"] = False
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
            # Sesiones ya no expiran automáticamente por inactividad. Solo se cierran si se presiona 'Salir'.
            pass
        except Exception as e:
            logger.error(f"Error al limpiar sesiones: {e}")
        await asyncio.sleep(3600)

# Busca el token de un usuario a partir de su user_id ("nombre_funcion")
def find_token_by_user_id(target_user_id: str) -> Optional[str]:
    for tk, u in users.items():
        if f"{u['name']}_{u['function']}" == target_user_id:
            return tk
    return None

# Envío masivo de la lista de usuarios conectados
async def broadcast_users():
    user_list = []
    for token in users:
        if users[token]["logged_in"]:
            decoded_token = base64.b64decode(token).decode('utf-8', errors='ignore')
            legajo, name, _ = decoded_token.split('_', 2) if '_' in decoded_token else (token, "Anónimo", "Desconocida")
            user_id = f"{users[token]['name']}_{users[token]['function']}"
            
            # Active means the user has a live websocket connection
            is_active = users[token].get("websocket") is not None
            user_list.append({
                "display": f"{users[token]['name']} ({legajo})",
                "user_id": user_id,
                "group_id": users[token]["group_id"],
                "active": is_active
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

# Endpoint de WebSockets principal
@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    logger.info(f"Cliente intentando conectar con WebSocket: {token[:15]}...")

    try:
        try:
            decoded_token = base64.b64decode(token).decode('utf-8')
            parts = decoded_token.split('_')
            if len(parts) == 3:
                employee_id, surname, sector = parts
            else:
                employee_id = "99999"
                surname = decoded_token if decoded_token else "Invitado"
                sector = "Operador"
                decoded_token = f"{employee_id}_{surname}_{sector}"
        except Exception as e:
            logger.error(f"Error decodificando token WebSocket fallback: {str(e)}")
            employee_id = "99999"
            surname = "Invitado"
            sector = "Operador"
            decoded_token = f"{employee_id}_{surname}_{sector}"

        # Dynamically restore valid token inside set to prevent disconnect rejection on reboot
        valid_tokens.add(token)

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
                "group_id": session["group_id"],
                "active": True
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
                "group_id": None,
                "active": True
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
                "id": msg["id"],
                "sender": snd,
                "sender_id": sender_id,
                "function": fn,
                "text": msg["text"],
                "timestamp": msg["timestamp"],
                "audio": msg["audio"]
            })
        
        # Señal para que el frontend sepa que terminó el historial y active el auto-play
        await websocket.send_json({"type": "history_end"})

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
                
            elif msg_type == "status_update":
                if token in users:
                    users[token]["active"] = message.get("active", True)
                    await broadcast_users()

            elif msg_type == "toggle_updates":
                app_state["updates_enabled"] = message.get("enabled", True)
                await websocket.send_json({"type": "updates_status", "enabled": app_state["updates_enabled"]})
                
            elif msg_type == "refresh_users":
                # Client requests fresh user list (called periodically for live updates)
                await broadcast_users()
                
            elif msg_type in ["audio", "message", "group_message", "direct_message"]:
                # Accept 'audio', 'message', 'group_message' and 'direct_message' types
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

            elif msg_type in [
                "video_call_request", "video_call_accept", "video_call_reject",
                "video_call_end", "video_offer", "video_answer", "video_ice_candidate"
            ]:
                # Señalización WebRTC 1 a 1: el servidor solo reenvía el mensaje
                # tal cual al destinatario, sin guardar estado de la llamada.
                target_user_id = message.get("target_user_id")
                target_token = find_token_by_user_id(target_user_id) if target_user_id else None
                target_ws = users[target_token]["websocket"] if target_token and target_token in users else None

                if target_ws:
                    sender_user_id = f"{users[token]['name']}_{users[token]['function']}"
                    try:
                        await target_ws.send_json({**message, "from_user_id": sender_user_id})
                    except Exception as e:
                        logger.error(f"Error reenviando señal de video a {target_user_id}: {e}")
                elif msg_type == "video_call_request":
                    await websocket.send_json({
                        "type": "video_call_error",
                        "message": "El operador no está disponible para videollamada."
                    })

    except WebSocketDisconnect:
        logger.info(f"Cliente desconectado (en segundo plano): {token[:15]}...")
        if token in users:
            users[token]["websocket"] = None
            users[token]["active"] = False
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
            users[token]["active"] = False
            await broadcast_users()
        await websocket.close()

@app.get("/history")
async def get_history_endpoint():
    return get_history()

@app.get("/api/history")
async def get_api_history_endpoint():
    return get_history()

@app.get("/api/history/since/{msg_id}")
async def get_history_since_endpoint(msg_id: int):
    return get_history_since(msg_id)


# Evento de inicio del servidor FastAPI
@app.on_event("startup")
async def startup_event():
    try:
        logger.info("Iniciando aplicación HANDLEPHONE...")
        init_db()

        # Pre-cargar sesiones registradas en DB al diccionario de usuarios activo en memoria
        try:
            with sqlite3.connect("chat_history.db") as conn:
                c = conn.cursor()
                c.execute("SELECT token, user_id, name, function, group_id, muted_users FROM sessions")
                for row in c.fetchall():
                    token, user_id, name, function, group_id, muted_users_str = row
                    try:
                        muted_users = set(json.loads(muted_users_str))
                    except Exception:
                        muted_users = set()
                    
                    # Cargar como desconectados temporales (active=False, websocket=None) pero logged_in=True
                    users[token] = {
                        "user_id": user_id,
                        "name": name,
                        "function": function,
                        "logged_in": True,
                        "websocket": None,
                        "muted_users": muted_users,
                        "subscription": None,
                        "group_id": group_id,
                        "active": False
                    }
            logger.info(f"Sesiones persistentes precargadas en memoria: {len(users)}")
        except Exception as db_err:
            logger.error(f"Error cargando sesiones persistentes al inicio: {db_err}")

        # Programar loops asíncronos en segundo plano
        asyncio.create_task(clear_messages())
        asyncio.create_task(process_audio_queue())
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

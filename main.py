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
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup
import speech_recognition as sr
import io
import soundfile as sf
from pydub import AudioSegment

app = FastAPI()
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Cargar index.html para la ruta raíz
with open("templates/index.html", "r") as f:
    INDEX_HTML = f.read()

@app.get("/", response_class=HTMLResponse)
async def read_root():
    # Agregar encabezados para evitar caché en Chrome
    response = HTMLResponse(content=INDEX_HTML)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# Configurar logging
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

# Diccionarios para manejar usuarios, colas y grupos
users = {}  # {token: {"name": str, "function": str, "logged_in": bool, "websocket": WebSocket (o None), "subscription": push_subscription, "muted_users": set, "group_id": str or None}}
audio_queue = asyncio.Queue()
groups = {}  # {group_id: [lista de tokens de usuarios]}

# Variable global para rastrear el muteo general
global_mute_active = False  # Inicia desmuteado por defecto

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
        url = "https://api.airplanes.live/v2/point/-34.5597/-58.4116/250"  # 250 millas desde Aeroparque
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

# Función para hacer web scraping de TAMS (actualizada con reintentos y mejor manejo de errores)
def scrape_tams():
    url = "http://www.tams.com.ar/ORGANISMOS/Vuelos.aspx"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    session = requests.Session()
    retries = Retry(total=3, backoff_factor=1, status_forcelist=[502, 503, 504])
    session.mount("http://", HTTPAdapter(max_retries=retries))

    try:
        # Verificar si el sitio está accesible
        response = session.head(url, timeout=5)
        if response.status_code != 200:
            logger.warning(f"No se puede acceder a TAMS. Código de estado: {response.status_code}")
            return []

        # Hacer la solicitud completa
        response = session.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        flights = []

        # Buscar spans y extraer datos
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
            status = row[15] if len(row) > 15 else "Desconocido"  # Estado del vuelo (puede incluir "Cancelado")

            if airline == "AR":  # Solo vuelos de Aerolíneas Argentinas
                flights.append({
                    "Vuelo": f"AR{flight_number}",
                    "STD": scheduled_time,
                    "Posicion": position,
                    "Destino": destination,
                    "Matricula": registration if registration != " " else "N/A",
                    "Estado": status  # Agregar el estado del vuelo
                })

        logger.info(f"Datos scrapeados de TAMS: {len(flights)} vuelos de Aerolíneas Argentinas encontrados")
        return flights
    except requests.exceptions.RequestException as e:
        logger.error(f"Error al scrapear TAMS: {e}")
        return []
    except Exception as e:
        logger.error(f"Error inesperado al scrapear TAMS: {e}")
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
        else:
            logger.warning("No se encontraron vuelos únicos en TAMS para enviar")
        await asyncio.sleep(300)  # 5 minutos

@app.get("/opensky")
async def get_opensky_data():
    airplanes_data = await get_airplanes_live_data()
    tams_data = scrape_tams()
    
    if isinstance(airplanes_data, dict) and "error" in airplanes_data:
        logger.error(f"Error en Airplanes.Live: {airplanes_data['error']}")
        airplanes_data = []  # Continuar con datos vacíos para mostrar al menos los datos de TAMS
    if isinstance(tams_data, dict) and "error" in tams_data:
        logger.error(f"Error en TAMS: {tams_data['error']}")
        tams_data = []  # Continuar con datos vacíos para mostrar al menos los datos de Airplanes.Live

    combined_data = []
    # Primero, agregar vuelos activos de Airplanes.Live
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
            # Combinar con datos de TAMS si están disponibles
            for tams_flight in tams_data:
                if tams_flight["Matricula"] == registration:
                    plane_info.update({
                        "scheduled": tams_flight["STD"],
                        "position": tams_flight["Posicion"],
                        "destination": tams_flight["Destino"],
                        "status": tams_flight.get("Estado", "Desconocido")
                    })
                    break
            combined_data.append(plane_info)
    
    # Agregar vuelos de TAMS que no están en Airplanes.Live (por ejemplo, cancelados o programados)
    for tams_flight in tams_data:
        if not any(plane["registration"] == tams_flight["Matricula"] for plane in combined_data):
            combined_data.append({
                "flight": tams_flight["Vuelo"],
                "registration": tams_flight["Matricula"],
                "scheduled": tams_flight["STD"],
                "position": tams_flight["Posicion"],
                "destination": tams_flight["Destino"],
                "status": tams_flight.get("Estado", "Desconocido"),
                "lat": None,
                "lon": None,
                "alt_geom": None,
                "gs": None,
                "vert_rate": None,
                "origin_dest": None
            })

    logger.info(f"Datos combinados: {len(combined_data)} vuelos (Airplanes.Live: {len(airplanes_data)}, TAMS: {len(tams_data)})")
    return combined_data

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
    logger.info(f"Mensaje guardado en la base de datos: user_id={user_id}, timestamp={timestamp}")

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

            logger.info(f"Procesando mensaje de audio de {sender} ({function}) con token {token}")

            # Si el muteo global está activo, no transmitir el audio
            if global_mute_active:
                logger.info("Muteo global activo, audio no transmitido")
                audio_queue.task_done()
                continue

            # Si el cliente no proporcionó una transcripción, transcribir en el servidor
            if text == "Sin transcripción" or text == "Pendiente de transcripción":
                logger.info("Transcribiendo audio en el servidor...")
                text = await transcribe_audio(audio_data)
                logger.info(f"Transcripción del servidor: {text}")

            # Guardar el mensaje en la base de datos
            user_id = f"{sender}_{function}"
            try:
                save_message(user_id, audio_data, text, timestamp)
            except Exception as e:
                logger.error(f"Error al guardar el mensaje en la base de datos: {e}")

            # Retransmitir el mensaje a los usuarios conectados
            broadcast_message = {
                "type": "audio",
                "sender": sender,
                "function": function,
                "text": text,
                "timestamp": timestamp,
                "data": audio_data
            }
            logger.info(f"Retransmitiendo mensaje a {len(users)} usuarios")
            for user_token, user in list(users.items()):
                if user_token == token:
                    continue
                # Verificar si el usuario ha muteado al remitente
                muted_users = user.get("muted_users", set())
                sender_id = f"{sender}_{function}"
                if sender_id in muted_users:
                    logger.info(f"Usuario {user['name']} ha muteado a {sender_id}, no recibirá el mensaje")
                    continue
                # Si el usuario está en un grupo, no recibirá mensajes generales
                if user.get("group_id"):
                    logger.info(f"Usuario {user['name']} está en un grupo ({user['group_id']}), no recibirá mensajes generales")
                    continue
                ws = user.get("websocket")
                if ws:
                    try:
                        await ws.send_json(broadcast_message)
                        logger.info(f"Mensaje enviado a {user['name']} ({user_token})")
                    except Exception as e:
                        logger.error(f"Error al enviar mensaje a {user['name']} ({user_token}): {e}")
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
    logger.info(f"Cliente conectado con token: {token}")

    # Declarar global_mute_active al inicio de la función para todo el ámbito
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
                "muted_users": set(),  # Lista de usuarios muteados (como "name_function")
                "subscription": None,
                "group_id": None  # Nuevo: campo para rastrear el grupo al que pertenece el usuario
            }

        # Enviar confirmación de conexión al cliente
        await websocket.send_json({"type": "connection_success", "message": "Conectado al servidor"})
        logger.info(f"Confirmación de conexión enviada a {token}")

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
                logger.info(f"Usuario registrado: {name} ({function}) con token {token}, confirmación enviada")
                await broadcast_users()

            elif message["type"] == "subscribe":
                users[token]["subscription"] = message["subscription"]
                logger.info(f"Suscripción push recibida para {token}")

            elif message["type"] == "audio":
                audio_data = message.get("data")
                if not audio_data:
                    logger.error("Mensaje de audio sin datos de audio")
                    continue
                await audio_queue.put((token, audio_data, message))
                logger.info(f"Mensaje de audio recibido de {token} y agregado a la cola")

            elif message["type"] == "logout":
                if token in users:
                    group_id = users[token]["group_id"]
                    if group_id and group_id in groups:
                        if token in groups[group_id]:
                            groups[group_id].remove(token)
                        if not groups[group_id]:  # Si el grupo está vacío, eliminarlo
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
                    logger.info(f"Usuario {users[token]['name']} muteó a {target_user_id}")
                else:
                    logger.error("Mensaje de mute_user sin target_user_id")

            elif message["type"] == "unmute_user":
                target_user_id = message.get("target_user_id")
                if target_user_id:
                    users[token]["muted_users"].discard(target_user_id)
                    logger.info(f"Usuario {users[token]['name']} desmuteó a {target_user_id}")
                else:
                    logger.error("Mensaje de unmute_user sin target_user_id")

            elif message["type"] == "unmute_all":
                global_mute_active = False
                await broadcast_global_mute_state("unmute_all_success", "Muteo global desactivado")
                logger.info(f"Usuario {users[token]['name']} desactivó muteo global")

            elif message["type"] == "mute":
                logger.info(f"Usuario {users[token]['name']} activó mute local")
                await websocket.send_json({"type": "mute_success", "message": "Mute activado"})

            elif message["type"] == "unmute":
                logger.info(f"Usuario {users[token]['name']} desactivó mute local")
                await websocket.send_json({"type": "unmute_success", "message": "Mute desactivado"})

            # Nuevos tipos de mensajes para grupos privados
            elif message["type"] == "join_group":
                group_id = message["group_id"]
                if group_id not in groups:
                    groups[group_id] = []
                if token not in groups[group_id]:
                    groups[group_id].append(token)
                users[token]["group_id"] = group_id
                await websocket.send_json({"type": "join_group", "group_id": group_id})
                logger.info(f"Usuario {users[token]['name']} se unió al grupo {group_id}")
                await broadcast_users()

            elif message["type"] == "leave_group":
                group_id = message["group_id"]
                if token and group_id in groups:
                    if token in groups[group_id]:
                        groups[group_id].remove(token)
                    if not groups[group_id]:  # Si el grupo está vacío, eliminarlo
                        del groups[group_id]
                    users[token]["group_id"] = None
                    await broadcast_users()
                    logger.info(f"Usuario {users[token]['name']} salió del grupo {group_id}")

            elif message["type"] == "check_group":
                group_id = message["group_id"]
                in_group = False
                if token and group_id in groups and token in groups[group_id]:
                    in_group = True
                await websocket.send_json({"type": "check_group", "group_id": group_id, "in_group": in_group})
                logger.info(f"Verificación de grupo para {users[token]['name']}: {'está' if in_group else 'no está'} en el grupo {group_id}")

            elif message["type"] == "group_message":
                group_id = users[token]["group_id"]
                if group_id and group_id in groups:
                    audio_data = message.get("data")
                    if not audio_data:
                        logger.error("Mensaje de grupo sin datos de audio")
                        continue
                    text = message.get("text", "Sin transcripción")
                    timestamp = message.get("timestamp", datetime.utcnow().strftime("%H:%M"))

                    # Si el cliente no proporcionó una transcripción, transcribir en el servidor
                    if text == "Sin transcripción" or text == "Pendiente de transcripción":
                        logger.info("Transcribiendo audio de grupo en el servidor...")
                        text = await transcribe_audio(audio_data)
                        logger.info(f"Transcripción del servidor para mensaje de grupo: {text}")

                    # Guardar el mensaje en la base de datos
                    user_id = f"{users[token]['name']}_{users[token]['function']}"
                    try:
                        save_message(user_id, audio_data, f"[Grupo {group_id}] {text}", timestamp)
                    except Exception as e:
                        logger.error(f"Error al guardar el mensaje de grupo en la base de datos: {e}")

                    # Enviar el mensaje solo a los usuarios del grupo
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
                            # Verificar si el usuario ha muteado al remitente
                            muted_users = user.get("muted_users", set())
                            sender_id = f"{users[token]['name']}_{users[token]['function']}"
                            if sender_id in muted_users:
                                logger.info(f"Usuario {user['name']} ha muteado a {sender_id}, no recibirá el mensaje de grupo")
                                continue
                            ws = user.get("websocket")
                            if ws:
                                try:
                                    await ws.send_json(broadcast_message)
                                    logger.info(f"Mensaje de grupo enviado a {user['name']} ({user_token}) en el grupo {group_id}")
                                except Exception as e:
                                    logger.error(f"Error al enviar mensaje de grupo a {user['name']} ({user_token}): {e}")
                                    user["websocket"] = None
                                    users[user_token]["logged_in"] = False
                                    await broadcast_users()

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
        logger.error(f"Error en WebSocket para el cliente {token}: {str(e)}", exc_info=True)
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

# Nueva función para difundir el estado de muteo global
async def broadcast_global_mute_state(message_type, message_text):
    for user in list(users.values()):
        if user["logged_in"] and user["websocket"] is not None:
            try:
                await user["websocket"].send_json({"type": message_type, "message": message_text})
                logger.info(f"Estado de muteo global ({message_type}) enviado a {user['name']}")
            except Exception as e:
                logger.error(f"Error al enviar estado de muteo global a {user['name']}: {e}")
                user["websocket"] = None
                user["logged_in"] = False
                await broadcast_users()

async def broadcast_users():
    user_list = []
    for token in users:
        if users[token]["logged_in"]:
            decoded_token = base64.b64decode(token).decode('utf-8')
            legajo, name, _ = decoded_token.split('_', 2)
            user_id = f"{users[token]['name']}_{users[token]['function']}"  # Identificador único para mutear
            user_list.append({
                "display": f"{users[token]['name']} ({legajo})",
                "user_id": user_id,
                "group_id": users[token]["group_id"]  # Incluir el group_id en la lista de usuarios
            })
    for user in list(users.values()):
        if user["logged_in"] and user["websocket"] is not None:
            try:
                await user["websocket"].send_text(json.dumps({
                    "type": "users",
                    "count": len(user_list),
                    "list": user_list
                }))
                logger.info(f"Lista de usuarios enviada a {user['name']}")
            except Exception as e:
                logger.error(f"Error al enviar lista de usuarios a un cliente: {e}")
                user["websocket"] = None
                user["logged_in"] = False

@app.get("/history")
async def get_history_endpoint():
    history = get_history()
    logger.info(f"Historial solicitado, {len(history)} mensajes devueltos")
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
    asyncio.create_task(update_tams_flights())
    logger.info("Aplicación iniciada, tareas programadas")

import os
import psycopg2
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import logging
import json
import asyncio
from fastapi import APIRouter, FastAPI

app = FastAPI()
logger = logging.getLogger(__name__)

def scrape_aa2000(flight_type="partidas", airport="Aeroparque, AEP"):
    date = datetime.now().strftime("%d-%m-%Y")
    url = f"https://www.aeropuertosargentina.com/es/vuelos?movtp={flight_type}&idarpt={airport.replace(', ', '%2C%20')}&fecha={date}"
    
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Connection": "keep-alive",
            "Referer": "https://www.aeropuertosargentina.com/",
            "Accept-Encoding": "gzip, deflate, br"
        }
        logger.info(f"Intentando acceder a {url}")
        response = requests.get(url, headers=headers, timeout=20)
        response.raise_for_status()
        logger.info(f"Respuesta HTTP: {response.status_code}")
        
        soup = BeautifulSoup(response.text, "html.parser")
        logger.info(f"HTML recibido (primeros 1000 caracteres): {response.text[:1000]}...")
        
        # Probar más selectores genéricos
        flight_list = (soup.find("div", class_="flight-table") or
                       soup.find("table", class_="flights") or
                       soup.find("div", id="flight-data") or
                       soup.find("section", class_="flight-info") or
                       soup.find("div", class_="vuelos-lista") or
                       soup.find("table", class_="vuelo-table") or
                       soup.find("div", class_="flight-list") or
                       soup.find("div", class_="flights-container") or
                       soup.find("table", class_="vuelos") or
                       soup.find("div", class_="vuelos-container") or
                       soup.find("section", class_="vuelos") or
                       soup.find("div", class_="flight-info"))
        if not flight_list:
            logger.warning("No se encontró la lista de vuelos (probó flight-table, flights, flight-data, flight-info, vuelos-lista, vuelo-table, flight-list, flights-container, vuelos, vuelos-container, vuelos, flight-info).")
            # Buscar cualquier tabla o div con "vuelo" o "flight" en la clase
            flight_list = soup.find(lambda tag: tag.name in ["table", "div", "section"] and
                                    any(x in tag.get("class", []) for x in ["vuelo", "flight", "flights", "vuelos"]))
            if not flight_list:
                logger.warning("Tampoco se encontró ninguna tabla/div con 'vuelo' o 'flight' en la clase.")
                return []
            logger.info("Encontrada tabla/div genérica con 'vuelo' o 'flight' en la clase.")
        
        flights = []
        flight_items = (flight_list.find_all("div", class_="flight-row") or
                        flight_list.find_all("tr", class_="flight") or
                        flight_list.find_all("div", class_="flight-item") or
                        flight_list.find_all("tr", class_="vuelo") or
                        flight_list.find_all("div", class_="vuelo-item") or
                        flight_list.find_all("tr") or  # Probar todas las filas si no hay clase específica
                        flight_list.find_all("div", class_="vuelo-row"))
        logger.info(f"Encontrados {len(flight_items)} elementos de vuelos")
        for item in flight_items:
            airline = (item.find("span", class_="flight-airline") or
                       item.find("td", class_="airline") or
                       item.find("div", class_="airline") or
                       item.find("span", class_="vuelo-aerolinea") or
                       item.find(lambda tag: tag.name in ["span", "td", "div"] and "aerolíneas argentinas" in tag.text.lower()))
            airline_text = airline.text.strip() if airline else ""
            if "Aerolíneas Argentinas" not in airline_text.lower():
                continue
            
            def get_text(selector, class_name):
                element = item.find(selector, class_name)
                return element.text.strip() if element else "N/A"
            
            flight = {
                "flight_number": (get_text("span", "flight-number") or
                                  get_text("td", "flight-number") or
                                  get_text("div", "flight-number") or
                                  get_text("span", "vuelo-numero") or
                                  get_text("td", "vuelo-numero")),
                "origin_destination": (get_text("span", "flight-destination") or
                                       get_text("td", "destination") or
                                       get_text("div", "destination") or
                                       get_text("span", "vuelo-destino") or
                                       get_text("td", "vuelo-destino")),
                "scheduled_time": (get_text("span", "flight-scheduled") or
                                   get_text("td", "scheduled") or
                                   get_text("div", "scheduled") or
                                   get_text("span", "vuelo-horario") or
                                   get_text("td", "vuelo-horario")),
                "status": (get_text("span", "flight-status") or
                           get_text("td", "status") or
                           get_text("div", "status") or
                           get_text("span", "vuelo-estado") or
                           get_text("td", "vuelo-estado")),
                "gate": (get_text("span", "flight-gate") or
                         get_text("td", "gate") or
                         get_text("div", "gate") or
                         get_text("span", "vuelo-puerta") or
                         get_text("td", "vuelo-puerta")),
                "flight_type": flight_type
            }
            if flight["status"].lower() != "cancelado":
                flights.append(flight)
        
        logger.info(f"Scrapeados {len(flights)} vuelos válidos de {flight_type}")
        return flights
    
    except requests.exceptions.RequestException as e:
        logger.error(f"Error HTTP al scrapear AA2000 ({flight_type}): {str(e)}")
        return []
    except Exception as e:
        logger.error(f"Error general al scrapear AA2000 ({flight_type}): {str(e)}")
        return []               

def save_to_aa2000_database(flights, db_url):
    try:
        logger.info("Conectando a la base de datos para guardar vuelos")
        conn = psycopg2.connect(db_url)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS aa2000_flights (
                id SERIAL PRIMARY KEY,
                flight_number VARCHAR(10),
                origin_destination VARCHAR(100),
                scheduled_time VARCHAR(20),
                status VARCHAR(50),
                gate VARCHAR(20),
                flight_type VARCHAR(20),
                scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_aa2000_flight UNIQUE (flight_number, scheduled_time, flight_type)
            );
        """)
        for flight in flights:
            cursor.execute("""
                INSERT INTO aa2000_flights (flight_number, origin_destination, scheduled_time, status, gate, flight_type)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT ON CONSTRAINT unique_aa2000_flight
                DO NOTHING
            """, (
                flight["flight_number"],
                flight["origin_destination"],
                flight["scheduled_time"],
                flight["status"],
                flight["gate"],
                flight["flight_type"]
            ))
        conn.commit()
        logger.info(f"Guardados {len(flights)} vuelos de AA2000 en la base de datos")
    except Exception as e:
        logger.error(f"Error al guardar vuelos de AA2000: {e}")
    finally:
        if 'cursor' in locals():
            cursor.close()
        if 'conn' in locals():
            conn.close()

@app.get("/aa2000_flights")
async def get_aa2000_flights():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL no está definida")
        return {"error": "DATABASE_URL no está definida"}
    
    try:
        logger.info("Conectando a la base de datos para obtener vuelos")
        conn = psycopg2.connect(db_url)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS aa2000_flights (
                id SERIAL PRIMARY KEY,
                flight_number VARCHAR(10),
                origin_destination VARCHAR(100),
                scheduled_time VARCHAR(20),
                status VARCHAR(50),
                gate VARCHAR(20),
                flight_type VARCHAR(20),
                scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_aa2000_flight UNIQUE (flight_number, scheduled_time, flight_type)
            );
        """)
        cursor.execute("""
            SELECT flight_number, origin_destination, scheduled_time, status, gate, flight_type 
            FROM aa2000_flights 
            ORDER BY scraped_at DESC
        """)
        flights = cursor.fetchall()
        conn.commit()
        logger.info(f"Obtenidos {len(flights)} vuelos de AA2000 de la base de datos")
        return [
            {
                "flight_number": f[0],
                "origin_destination": f[1],
                "scheduled_time": f[2],
                "status": f[3],
                "gate": f[4],
                "flight_type": f[5]
            } for f in flights
        ]
    except Exception as e:
        logger.error(f"Error al obtener vuelos de AA2000: {e}")
        return {"error": str(e)}
    finally:
        if 'cursor' in locals():
            cursor.close()
        if 'conn' in locals():
            conn.close()

# Endpoint temporal para debuggear
@app.get("/debug_aa2000_scrape")
async def debug_aa2000_scrape():
    try:
        logger.info("Ejecutando debug de scraping AA2000")
        departures = scrape_aa2000(flight_type="partidas", airport="Aeroparque, AEP")
        arrivals = scrape_aa2000(flight_type="llegadas", airport="Aeroparque, AEP")
        all_flights = (departures or []) + (arrivals or [])
        db_url = os.getenv("DATABASE_URL")
        if all_flights and db_url:
            save_to_aa2000_database(all_flights, db_url)
        return {"flights": all_flights, "count": len(all_flights)}
    except Exception as e:
        logger.error(f"Error en debug_aa2000_scrape: {e}")
        return {"error": str(e)}

async def update_aa2000_flights():
    logger.info("Tarea update_aa2000_flights iniciada")
    while True:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            logger.error("DATABASE_URL no está definida")
            await asyncio.sleep(300)
            continue
        
        logger.info("Iniciando ciclo de actualización de vuelos AA2000")
        try:
            departures = scrape_aa2000(flight_type="partidas", airport="Aeroparque, AEP")
            arrivals = scrape_aa2000(flight_type="llegadas", airport="Aeroparque, AEP")
            
            all_flights = (departures or []) + (arrivals or [])
            
            if all_flights:
                save_to_aa2000_database(all_flights, db_url)
                try:
                    for user in users.values():
                        if user["logged_in"] and user["websocket"] is not None:
                            await user["websocket"].send_text(json.dumps({
                                "type": "aa2000_flight_update",
                                "flights": all_flights
                            }))
                            logger.info(f"Actualización de vuelos AA2000 enviada a {user['name']}")
                except NameError:
                    logger.warning("Variable 'users' no definida, omitiendo envío WebSocket")
                logger.info(f"Enviados {len(all_flights)} vuelos de AA2000")
            else:
                logger.warning("No se encontraron vuelos de AA2000")
        
        except Exception as e:
            logger.error(f"Error en update_aa2000_flights: {str(e)}")
        
        logger.info("Finalizando ciclo de actualización AA2000")
        await asyncio.sleep(300)  # 5 minutos

@app.on_event("startup")
async def startup_event():
    try:
        init_db()
        asyncio.create_task(clear_messages())
        asyncio.create_task(process_audio_queue())
        asyncio.create_task(update_tams_flights())
        asyncio.create_task(update_aa2000_flights())
        logger.info("Aplicación iniciada, tareas programadas")
    except Exception as e:
        logger.error(f"Error al iniciar aplicación: {e}")
        
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))  # Usar el puerto asignado por Render
    uvicorn.run(app, host="0.0.0.0", port=port)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Form, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, RedirectResponse, Response
import httpx
import uvicorn
import logging
import time
from datetime import datetime, timedelta
import pytz
import asyncio
import sqlite3
import bcrypt
import re
import secrets
import json

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Montar la carpeta templates para archivos estáticos
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Configurar Jinja2 para plantillas HTML
templates = Jinja2Templates(directory="templates")

# Clave de API de GoFlightLabs
GOFLIGHTLABS_API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI0IiwianRpIjoiZjkzOWJiZmM2ZWY3Y2QxMzcyY2I2NjJjZjI0NzI0ZTAwY2I0M2RmZTcyMmY2NDZiNTQwNjJiMTk0NGM4NGEwZDc3MjU1NWY1ZDA3YWRlZDkiLCJpYXQiOjE3NDQ5MjU3NjYsIm5iZiI6MTc0NDkyNTc2NiwiZXhwIjoxNzc2NDYxNzY1LCJzdWIiOiIyNDcxNyIsInNjb3BlcyI6W119.Ln6gpY3DDOUHesjuqbIeVYh86GLvggRaPaP8oGh-mGy8hQxMlqX7ie_U0zXfowKKFInnDdsHAg8PuZB2yt31qQ"
GOFLIGHTLABS_API_URL = f"https://www.goflightlabs.com/flights?access_key={GOFLIGHTLABS_API_KEY}"

# Clave de API de AviationStack
AVIATIONSTACK_API_KEY = "e2ffa37f30b26c5ab57dfbf77982a25b"
AVIATIONSTACK_API_URL = f"http://api.aviationstack.com/v1/flights?access_key={AVIATIONSTACK_API_KEY}"

# Clave de API de SerpApi
SERPAPI_API_KEY = "b1b5b25c9b389d5a70d5bceab6bc568dcdec531a1872b91e789d799c90c762fe"
SERPAPI_FLIGHTS_URL = f"https://serpapi.com/search?engine=google_flights&api_key={SERPAPI_API_KEY}"

# Coordenadas aproximadas de los aeropuertos
AIRPORT_COORDS = {
    "AEP": {"lat": -34.5592, "lon": -58.4156},
    "EZE": {"lat": -34.8222, "lon": -58.5358},
}

# Lista para rastrear conexiones WebSocket activas
connected_clients = set()

# Lista para almacenar usuarios conectados con sus detalles
connected_users = {}

# Lista predefinida de usuarios permitidos (legajo: apellido)
ALLOWED_USERS = {
    "35127": "Souto",
    "35145": "Gimenez",
    "35128": "Gomez",
    "33366": "Benitez",
    "38818": "Contartese",
    "38880": "Leites",
    "36000": "Duartero",
    "35596": "Arena",
    "35417": "Brandariz",
    "35152": "Fossati",
    "12345": "Test",
    "00000": "Bot",
    "39157": "Galofalo",
    "33753": "Mamani",
    "38546": "Leto",
}

# Lista de posiciones permitidas
ALLOWED_POSITIONS = [
    "Maletero", "Cintero", "Tractorista", "Equipos", "Supervisor",
    "Jefatura", "Administración", "Movilero", "Micros", "Pañolero", "Señalero"
]

# Inicializar la base de datos SQLite para usuarios y sesiones
def init_db():
    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    # Tabla para usuarios
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        legajo TEXT PRIMARY KEY,
        apellido TEXT NOT NULL,
        position TEXT NOT NULL,
        password TEXT NOT NULL
    )''')
    # Tabla para sesiones (almacenar tokens)
    c.execute('''CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        legajo TEXT NOT NULL,
        FOREIGN KEY (legajo) REFERENCES users (legajo)
    )''')
    conn.commit()
    conn.close()

# Inicializar la base de datos SQLite para mensajes del chat
def init_chat_db():
    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    # Tabla para mensajes del chat
    c.execute('''CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT,
        sender TEXT,
        content TEXT,
        timestamp TEXT
    )''')
    conn.commit()
    conn.close()

# Limpiar mensajes antiguos (más de 7 días)
def clean_old_messages():
    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    seven_days_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    c.execute("DELETE FROM messages WHERE timestamp < ?", (seven_days_ago,))
    conn.commit()
    conn.close()

# Inicializar las bases de datos al iniciar la app
init_db()
init_chat_db()

# Dependencia para verificar si el usuario está logueado usando cookies
def get_current_user(request: Request):
    token = request.cookies.get("session_token")
    if not token:
        return RedirectResponse(url="/login", status_code=303)

    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("SELECT legajo FROM sessions WHERE token = ?", (token,))
    session_data = c.fetchone()
    if not session_data:
        conn.close()
        return RedirectResponse(url="/login", status_code=303)

    legajo = session_data[0]
    c.execute("SELECT legajo, apellido, position FROM users WHERE legajo = ?", (legajo,))
    user = c.fetchone()
    conn.close()

    if not user:
        return RedirectResponse(url="/login", status_code=303)

    return {"legajo": user[0], "apellido": user[1], "position": user[2]}

# Ruta para la página de registro
@app.get("/register", response_class=HTMLResponse)
async def register_page(request: Request):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("register.html", {"request": request, "positions": ALLOWED_POSITIONS})

# Ruta para procesar el registro
@app.post("/register", response_class=HTMLResponse)
async def register(
    request: Request,
    legajo: str = Form(...),
    apellido: str = Form(...),
    position: str = Form(...),
    password: str = Form(...),
    confirm_password: str = Form(...)
):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)

    # Validar que el legajo y el apellido coincidan con la lista predefinida
    if legajo not in ALLOWED_USERS or ALLOWED_USERS[legajo].lower() != apellido.lower():
        return templates.TemplateResponse("register.html", {
            "request": request,
            "positions": ALLOWED_POSITIONS,
            "error": "Legajo y apellido no coinciden con los registros permitidos."
        })

    # Validar formato del legajo (5 números)
    if not re.match(r'^\d{5}$', legajo):
        return templates.TemplateResponse("register.html", {
            "request": request,
            "positions": ALLOWED_POSITIONS,
            "error": "El legajo debe contener exactamente 5 números."
        })

    # Validar formato del apellido (solo letras)
    if not re.match(r'^[A-Za-z]+$', apellido):
        return templates.TemplateResponse("register.html", {
            "request": request,
            "positions": ALLOWED_POSITIONS,
            "error": "El apellido debe contener solo letras."
        })

    # Validar posición
    if position not in ALLOWED_POSITIONS:
        return templates.TemplateResponse("register.html", {
            "request": request,
            "positions": ALLOWED_POSITIONS,
            "error": "Posición no válida."
        })

    # Validar que las contraseñas coincidan
    if password != confirm_password:
        return templates.TemplateResponse("register.html", {
            "request": request,
            "positions": ALLOWED_POSITIONS,
            "error": "Las contraseñas no coinciden."
        })

    # Hashear la contraseña
    hashed_password = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())

    # Guardar el usuario en la base de datos
    try:
        conn = sqlite3.connect("users.db")
        c = conn.cursor()
        c.execute("INSERT INTO users (legajo, apellido, position, password) VALUES (?, ?, ?, ?)",
                  (legajo, apellido, position, hashed_password))
        conn.commit()
        conn.close()
    except sqlite3.IntegrityError:
        return templates.TemplateResponse("register.html", {
            "request": request,
            "positions": ALLOWED_POSITIONS,
            "error": "El legajo ya está registrado."
        })

    return RedirectResponse(url="/login", status_code=303)

# Ruta para la página de inicio de sesión
@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("login.html", {"request": request})

# Ruta para procesar el inicio de sesión
@app.post("/login", response_class=HTMLResponse)
async def login(
    request: Request,
    legajo: str = Form(...),
    apellido: str = Form(...),
    password: str = Form(...)
):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)

    # Validar que el legajo y el apellido coincidan con la lista predefinida
    if legajo not in ALLOWED_USERS or ALLOWED_USERS[legajo].lower() != apellido.lower():
        return templates.TemplateResponse("login.html", {
            "request": request,
            "error": "Legajo y apellido no coinciden con los registros permitidos."
        })

    # Verificar si el usuario está registrado
    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE legajo = ?", (legajo,))
    user = c.fetchone()
    conn.close()

    if not user:
        return templates.TemplateResponse("login.html", {
            "request": request,
            "error": "Usuario no registrado. Por favor, regístrate primero."
        })

    # Verificar la contraseña
    stored_password = user[3]  # La contraseña hasheada está en la columna 4
    if not bcrypt.checkpw(password.encode('utf-8'), stored_password):
        return templates.TemplateResponse("login.html", {
            "request": request,
            "error": "Contraseña incorrecta."
        })

    # Generar un token de sesión
    session_token = secrets.token_hex(16)
    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("INSERT INTO sessions (token, legajo) VALUES (?, ?)", (session_token, legajo))
    conn.commit()
    conn.close()

    # Configurar la cookie y redirigir
    response = RedirectResponse(url="/", status_code=303)
    response.set_cookie(key="session_token", value=session_token, httponly=True, max_age=30*24*60*60)  # 30 días
    return response

# Ruta para cerrar sesión
@app.get("/logout", response_class=HTMLResponse)
async def logout(request: Request):
    token = request.cookies.get("session_token")
    if token:
        conn = sqlite3.connect("users.db")
        c = conn.cursor()
        c.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()

        # Remover usuario de la lista de conectados
        user_to_remove = None
        for ws, user in connected_users.items():
            if user["token"] == token:
                user_to_remove = ws
                break
        if user_to_remove:
            del connected_users[user_to_remove]

    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(key="session_token")
    return response

# Ruta para la página de restablecimiento de contraseña
@app.get("/reset-password", response_class=HTMLResponse)
async def reset_password_page(request: Request):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("reset_password.html", {"request": request})

# Ruta para procesar el restablecimiento de contraseña
@app.post("/reset-password", response_class=HTMLResponse)
async def reset_password(
    request: Request,
    legajo: str = Form(...),
    apellido: str = Form(...),
    new_password: str = Form(...),
    confirm_new_password: str = Form(...)
):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)

    # Validar que el legajo y el apellido coincidan con la lista predefinida
    if legajo not in ALLOWED_USERS or ALLOWED_USERS[legajo].lower() != apellido.lower():
        return templates.TemplateResponse("reset_password.html", {
            "request": request,
            "error": "Legajo y apellido no coinciden con los registros permitidos."
        })

    # Verificar si el usuario está registrado
    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE legajo = ?", (legajo,))
    user = c.fetchone()

    if not user:
        conn.close()
        return templates.TemplateResponse("reset_password.html", {
            "request": request,
            "error": "Usuario no registrado."
        })

    # Validar que las contraseñas coincidan
    if new_password != confirm_new_password:
        conn.close()
        return templates.TemplateResponse("reset_password.html", {
            "request": request,
            "error": "Las contraseñas no coinciden."
        })

    # Actualizar la contraseña
    hashed_password = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt())
    c.execute("UPDATE users SET password = ? WHERE legajo = ?", (hashed_password, legajo))
    conn.commit()
    conn.close()

    return RedirectResponse(url="/login", status_code=303)

# Ruta para servir la página principal (protegida)
@app.get("/", response_class=HTMLResponse)
@app.head("/", response_class=HTMLResponse)
async def read_root(request: Request, user: dict = Depends(get_current_user)):
    if isinstance(user, RedirectResponse):
        return user
    return templates.TemplateResponse("index.html", {
        "request": request,
        "user": user
    })

# Ruta para obtener todos los vuelos (protegida)
@app.get("/flights")
async def get_flights(page: int = 1, user: dict = Depends(get_current_user)):
    if isinstance(user, RedirectResponse):
        return user
    
    all_flights = []
    current_time = int(time.time())
    six_hours_future = current_time + (6 * 3600)
    failed_sources = []

    # 1. Consultar SerpApi (Google Flights)
    async with httpx.AsyncClient() as client:
        try:
            logger.info("Consultando la API de SerpApi (Google Flights)...")
            response = await client.get(
                SERPAPI_FLIGHTS_URL,
                params={
                    "departure_id": "AEP",
                    "arrival_id": "",  # Dejar vacío para buscar todos los destinos
                    "hl": "es",
                    "currency": "ARS",
                    "outbound_date": datetime.now().strftime("%Y-%m-%d"),
                    "type": "2",  # Tipo 2 para vuelos de ida
                    "sort": "3",  # Ordenar por hora de salida
                    "deep_search": "true"  # Habilitar búsqueda profunda para más resultados
                }
            )
            response.raise_for_status()
            data = response.json()

            logger.info(f"Datos recibidos de SerpApi: {data}")

            flights = data.get("best_flights", []) + data.get("other_flights", [])
            logger.info(f"Total de vuelos recibidos de SerpApi: {len(flights)}")

            if flights:
                logger.info(f"Primeros 3 vuelos crudos de SerpApi: {flights[:3]}")
            else:
                logger.info("No se recibieron vuelos de SerpApi")

            for flight in flights:
                airline = flight.get("flights", [{}])[0].get("airline", "")
                if "Aerolíneas Argentinas" not in airline:
                    continue

                departure = flight.get("flights", [{}])[0].get("departure_airport", {}).get("id", "N/A")
                arrival = flight.get("flights", [{}])[0].get("arrival_airport", {}).get("id", "N/A")

                if departure != "AEP" and arrival != "AEP":
                    continue

                lat = AIRPORT_COORDS.get(departure, {"lat": -34.5592})["lat"]
                lon = AIRPORT_COORDS.get(departure, {"lon": -58.4156})["lon"]

                estimated_departure = flight.get("flights", [{}])[0].get("departure_airport", {}).get("time", "N/A")
                estimated_arrival = flight.get("flights", [{}])[0].get("arrival_airport", {}).get("time", "N/A")
                departure_datetime = None
                if estimated_departure != "N/A":
                    try:
                        departure_datetime = datetime.strptime(estimated_departure, "%Y-%m-%d %H:%M")
                        estimated_departure = departure_datetime.strftime("%H:%M")
                    except ValueError:
                        estimated_departure = "N/A"
                if estimated_arrival != "N/A":
                    try:
                        estimated_arrival = datetime.strptime(estimated_arrival, "%Y-%m-%d %H:%M").strftime("%H:%M")
                    except ValueError:
                        estimated_arrival = "N/A"

                flight_number = flight.get("flights", [{}])[0].get("flight_number", "N/A")
                airline_name = flight.get("flights", [{}])[0].get("airline", "N/A")
                departure_airport = flight.get("flights", [{}])[0].get("departure_airport", {}).get("name", departure)
                arrival_airport = flight.get("flights", [{}])[0].get("arrival_airport", {}).get("name", arrival)

                all_flights.append({
                    "flight_iata": flight_number,
                    "airline_iata": "AR",
                    "airline_name": airline_name,
                    "departure": departure,
                    "departure_airport": departure_airport,
                    "arrival": arrival,
                    "arrival_airport": arrival_airport,
                    "estimated_departure": estimated_departure,
                    "estimated_arrival": estimated_arrival,
                    "scheduled_departure": estimated_departure,
                    "scheduled_arrival": estimated_arrival,
                    "departure_delay": "0",
                    "arrival_delay": "0",
                    "departure_gate": "N/A",
                    "arrival_gate": "N/A",
                    "departure_terminal": "N/A",
                    "arrival_terminal": "N/A",
                    "aircraft": "N/A",
                    "status": "scheduled",
                    "observations": "Datos obtenidos de Google Flights vía SerpApi",
                    "lat": lat,
                    "lon": lon,
                    "departure_datetime": departure_datetime  # Para ordenar
                })
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar SerpApi: {str(e)}")
            failed_sources.append("SerpApi")
        except Exception as e:
            logger.error(f"Error inesperado al consultar SerpApi: {str(e)}")
            failed_sources.append("SerpApi")

    # 2. Consultar GoFlightLabs
    async with httpx.AsyncClient() as client:
        try:
            logger.info("Consultando la API de GoFlightLabs...")
            response = await client.get(GOFLIGHTLABS_API_URL)
            response.raise_for_status()
            data = response.json()

            logger.info(f"Datos recibidos de GoFlightLabs: {data}")

            if not data.get("success"):
                logger.error("GoFlightLabs no devolvió éxito")
                failed_sources.append("GoFlightLabs")
            else:
                flights = data.get("data", [])
                logger.info(f"Total de vuelos recibidos de GoFlightLabs: {len(flights)}")
                
                if flights:
                    logger.info(f"Primeros 3 vuelos crudos de GoFlightLabs: {flights[:3]}")
                else:
                    logger.info("No se recibieron vuelos de GoFlightLabs")

                for flight in flights:
                    departure = flight.get("dep_iata", "N/A")
                    arrival = flight.get("arr_iata", "N/A")

                    # Filtrar solo vuelos que involucren AEP
                    if departure != "AEP" and arrival != "AEP":
                        continue

                    lat = AIRPORT_COORDS.get(departure, {"lat": -34.5592})["lat"]
                    lon = AIRPORT_COORDS.get(departure, {"lon": -58.4156})["lon"]

                    estimated_departure = flight.get("dep_estimated", flight.get("dep_scheduled", "N/A"))
                    estimated_arrival = flight.get("arr_estimated", flight.get("arr_scheduled", "N/A"))
                    scheduled_departure = flight.get("dep_scheduled", "N/A")
                    scheduled_arrival = flight.get("arr_scheduled", "N/A")
                    departure_datetime = None

                    if estimated_departure != "N/A":
                        try:
                            departure_datetime = datetime.strptime(estimated_departure, "%Y-%m-%d %H:%M:%S")
                            estimated_departure = departure_datetime.strftime("%H:%M")
                        except ValueError:
                            estimated_departure = "N/A"
                    if estimated_arrival != "N/A":
                        try:
                            estimated_arrival = datetime.strptime(estimated_arrival, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")
                        except ValueError:
                            estimated_arrival = "N/A"
                    if scheduled_departure != "N/A":
                        try:
                            scheduled_departure = datetime.strptime(scheduled_departure, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")
                        except ValueError:
                            scheduled_departure = "N/A"
                    if scheduled_arrival != "N/A":
                        try:
                            scheduled_arrival = datetime.strptime(scheduled_arrival, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")
                        except ValueError:
                            scheduled_arrival = "N/A"

                    flight_number = flight.get("flight_iata", "N/A")
                    airline_iata = flight.get("airline_iata", "N/A")
                    airline_name = flight.get("airline_name", "N/A")
                    departure_airport = flight.get("dep_airport", departure)
                    arrival_airport = flight.get("arr_airport", arrival)
                    status = flight.get("status", "N/A").lower()

                    all_flights.append({
                        "flight_iata": flight_number,
                        "airline_iata": airline_iata,
                        "airline_name": airline_name,
                        "departure": departure,
                        "departure_airport": departure_airport,
                        "arrival": arrival,
                        "arrival_airport": arrival_airport,
                        "estimated_departure": estimated_departure,
                        "estimated_arrival": estimated_arrival,
                        "scheduled_departure": scheduled_departure,
                        "scheduled_arrival": scheduled_arrival,
                        "departure_delay": flight.get("dep_delayed", "0"),
                        "arrival_delay": flight.get("arr_delayed", "0"),
                        "departure_gate": flight.get("dep_gate", "N/A"),
                        "arrival_gate": flight.get("arr_gate", "N/A"),
                        "departure_terminal": flight.get("dep_terminal", "N/A"),
                        "arrival_terminal": flight.get("arr_terminal", "N/A"),
                        "aircraft": flight.get("aircraft", "N/A"),
                        "status": status,
                        "observations": "Datos obtenidos de GoFlightLabs",
                        "lat": lat,
                        "lon": lon,
                        "departure_datetime": departure_datetime  # Para ordenar
                    })
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar GoFlightLabs: {str(e)}")
            failed_sources.append("GoFlightLabs")
        except Exception as e:
            logger.error(f"Error inesperado al consultar GoFlightLabs: {str(e)}")
            failed_sources.append("GoFlightLabs")

    # 3. Consultar AviationStack
    async with httpx.AsyncClient() as client:
        try:
            logger.info("Consultando la API de AviationStack...")
            response = await client.get(
                AVIATIONSTACK_API_URL,
                params={
                    "dep_iata": "AEP",
                    "flight_date": datetime.now().strftime("%Y-%m-%d"),
                }
            )
            response.raise_for_status()
            data = response.json()

            logger.info(f"Datos recibidos de AviationStack: {data}")

            flights = data.get("data", [])
            logger.info(f"Total de vuelos recibidos de AviationStack: {len(flights)}")

            if flights:
                logger.info(f"Primeros 3 vuelos crudos de AviationStack: {flights[:3]}")
            else:
                logger.info("No se recibieron vuelos de AviationStack")

            for flight in flights:
                airline_iata = flight.get("airline", {}).get("iata", "N/A")
                if airline_iata != "AR":  # Filtrar solo Aerolíneas Argentinas
                    continue

                departure = flight.get("departure", {}).get("iata", "N/A")
                arrival = flight.get("arrival", {}).get("iata", "N/A")

                if departure != "AEP" and arrival != "AEP":
                    continue

                lat = AIRPORT_COORDS.get(departure, {"lat": -34.5592})["lat"]
                lon = AIRPORT_COORDS.get(departure, {"lon": -58.4156})["lon"]

                estimated_departure = flight.get("departure", {}).get("estimated", "N/A")
                estimated_arrival = flight.get("arrival", {}).get("estimated", "N/A")
                scheduled_departure = flight.get("departure", {}).get("scheduled", "N/A")
                scheduled_arrival = flight.get("arrival", {}).get("scheduled", "N/A")
                departure_datetime = None

                if estimated_departure != "N/A":
                    try:
                        departure_datetime = datetime.strptime(estimated_departure, "%Y-%m-%dT%H:%M:%S+00:00")
                        estimated_departure = departure_datetime.strftime("%H:%M")
                    except ValueError:
                        estimated_departure = "N/A"
                if estimated_arrival != "N/A":
                    try:
                        estimated_arrival = datetime.strptime(estimated_arrival, "%Y-%m-%dT%H:%M:%S+00:00").strftime("%H:%M")
                    except ValueError:
                        estimated_arrival = "N/A"
                if scheduled_departure != "N/A":
                    try:
                        scheduled_departure = datetime.strptime(scheduled_departure, "%Y-%m-%dT%H:%M:%S+00:00").strftime("%H:%M")
                    except ValueError:
                        scheduled_departure = "N/A"
                if scheduled_arrival != "N/A":
                    try:
                        scheduled_arrival = datetime.strptime(scheduled_arrival, "%Y-%m-%dT%H:%M:%S+00:00").strftime("%H:%M")
                    except ValueError:
                        scheduled_arrival = "N/A"

                flight_number = flight.get("flight", {}).get("iata", "N/A")
                airline_name = flight.get("airline", {}).get("name", "N/A")
                departure_airport = flight.get("departure", {}).get("airport", departure)
                arrival_airport = flight.get("arrival", {}).get("airport", arrival)
                status = flight.get("flight_status", "N/A").lower()

                all_flights.append({
                    "flight_iata": flight_number,
                    "airline_iata": airline_iata,
                    "airline_name": airline_name,
                    "departure": departure,
                    "departure_airport": departure_airport,
                    "arrival": arrival,
                    "arrival_airport": arrival_airport,
                    "estimated_departure": estimated_departure,
                    "estimated_arrival": estimated_arrival,
                    "scheduled_departure": scheduled_departure,
                    "scheduled_arrival": scheduled_arrival,
                    "departure_delay": flight.get("departure", {}).get("delay", "0"),
                    "arrival_delay": flight.get("arrival", {}).get("delay", "0"),
                    "departure_gate": flight.get("departure", {}).get("gate", "N/A"),
                    "arrival_gate": flight.get("arrival", {}).get("gate", "N/A"),
                    "departure_terminal": flight.get("departure", {}).get("terminal", "N/A"),
                    "arrival_terminal": flight.get("arrival", {}).get("terminal", "N/A"),
                    "aircraft": "N/A",  # AviationStack no proporciona este dato
                    "status": status,
                    "observations": "Datos obtenidos de AviationStack",
                    "lat": lat,
                    "lon": lon,
                    "departure_datetime": departure_datetime  # Para ordenar
                })
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar AviationStack: {str(e)}")
            failed_sources.append("AviationStack")
        except Exception as e:
            logger.error(f"Error inesperado al consultar AviationStack: {str(e)}")
            failed_sources.append("AviationStack")

    # Eliminar duplicados y ordenar por fecha de salida
    unique_flights = {}
    for flight in all_flights:
        flight_key = (flight["flight_iata"], flight["estimated_departure"])
        if flight_key not in unique_flights:
            unique_flights[flight_key] = flight

    all_flights = list(unique_flights.values())
    all_flights.sort(key=lambda x: x["departure_datetime"] if x["departure_datetime"] else datetime.max)

    # Paginación
    flights_per_page = 25
    total_flights = len(all_flights)
    total_pages = (total_flights + flights_per_page - 1) // flights_per_page
    start_idx = (page - 1) * flights_per_page
    end_idx = start_idx + flights_per_page
    paginated_flights = all_flights[start_idx:end_idx]

    # Remover el campo departure_datetime de la respuesta
    for flight in paginated_flights:
        flight.pop("departure_datetime", None)

    return {
        "flights": paginated_flights,
        "total_pages": total_pages,
        "failed_sources": failed_sources
    }

# Ruta para obtener la lista de usuarios (para la sección "Guardia")
@app.get("/users")
async def get_users(user: dict = Depends(get_current_user)):
    if isinstance(user, RedirectResponse):
        return user

    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("SELECT legajo, apellido, position FROM users")
    users = [{"legajo": row[0], "apellido": row[1], "position": row[2]} for row in c.fetchall()]
    conn.close()
    return {"users": users}

# Ruta para obtener el historial del chat (últimos 7 días)
@app.get("/chat-history")
async def get_chat_history(user: dict = Depends(get_current_user)):
    if isinstance(user, RedirectResponse):
        return user

    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    seven_days_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    c.execute("SELECT type, sender, content, timestamp FROM messages WHERE timestamp >= ? ORDER BY timestamp ASC", (seven_days_ago,))
    messages = [{"type": row[0], "sender": row[1], "content": row[2], "timestamp": row[3]} for row in c.fetchall()]
    conn.close()
    return {"messages": messages}

# WebSocket para usuarios conectados
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    # Obtener el token de la cookie desde los headers del WebSocket
    token = None
    for header in websocket.headers.items():
        if header[0] == "cookie":
            cookies = header[1].split("; ")
            for cookie in cookies:
                if cookie.startswith("session_token="):
                    token = cookie.split("=")[1]
                    break
            break

    if token:
        conn = sqlite3.connect("users.db")
        c = conn.cursor()
        c.execute("SELECT legajo FROM sessions WHERE token = ?", (token,))
        session_data = c.fetchone()
        if session_data:
            legajo = session_data[0]
            c.execute("SELECT legajo, apellido, position FROM users WHERE legajo = ?", (legajo,))
            user = c.fetchone()
            if user:
                connected_users[websocket] = {
                    "token": token,
                    "legajo": user[0],
                    "apellido": user[1],
                    "position": user[2]
                }
        conn.close()

    try:
        # Enviar el conteo de usuarios conectados a todos los clientes
        await broadcast_user_count()
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.remove(websocket)
        if websocket in connected_users:
            del connected_users[websocket]
        await broadcast_user_count()

# WebSocket para el chat global
@app.websocket("/chat")
async def chat_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            message["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            # Guardar el mensaje en la base de datos
            conn = sqlite3.connect("chat.db")
            c = conn.cursor()
            c.execute("INSERT INTO messages (type, sender, content, timestamp) VALUES (?, ?, ?, ?)",
                      (message["type"], message["sender"], message["content"], message["timestamp"]))
            conn.commit()
            conn.close()

            # Limpiar mensajes antiguos
            clean_old_messages()

            # Enviar el mensaje a todos los clientes conectados al chat
            message_str = json.dumps(message)
            for client in connected_clients:
                try:
                    await client.send_text(message_str)
                except WebSocketDisconnect:
                    connected_clients.remove(client)
    except WebSocketDisconnect:
        pass

# Función para enviar el conteo de usuarios conectados
async def broadcast_user_count():
    count = len(connected_users)
    message = json.dumps({"type": "user_count", "count": count})
    for client in connected_clients:
        try:
            await client.send_text(message)
        except WebSocketDisconnect:
            connected_clients.remove(client)

# Iniciar la app
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

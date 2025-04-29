from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi.requests import Request
import httpx
import uvicorn
import logging
import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from datetime import datetime, timedelta
import pytz
import asyncio

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

# Coordenadas aproximadas de los aeropuertos
AIRPORT_COORDS = {
    "AEP": {"lat": -34.5592, "lon": -58.4156},
    "EZE": {"lat": -34.8222, "lon": -58.5358},
}

# Lista para rastrear conexiones WebSocket activas
connected_clients = set()

# Configurar Selenium para el scraper
def setup_driver():
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    try:
        logger.info("Intentando inicializar el driver de Selenium...")
        service = Service('/usr/local/bin/chromedriver')
        logger.info("Ruta de ChromeDriver especificada: /usr/local/bin/chromedriver")
        driver = webdriver.Chrome(service=service, options=chrome_options)
        logger.info("Driver de Selenium inicializado correctamente")
        return driver
    except Exception as e:
        logger.error(f"Error al inicializar el driver de Selenium: {str(e)}")
        return None

# Función para parsear la fecha y hora del formato de AA2000
def parse_aa2000_datetime(date_str, time_str):
    try:
        datetime_str = f"{date_str} {time_str} 2025"
        dt = datetime.strptime(datetime_str, "%d %b %H:%M %Y")
        tz = pytz.timezone("America/Argentina/Buenos_Aires")
        dt = tz.localize(dt)
        return int(dt.timestamp()), dt.strftime("%H:%M")
    except Exception as e:
        logger.error(f"Error al parsear fecha de AA2000: {date_str} {time_str}, error: {str(e)}")
        return 0, "N/A"

# Scraper para AA2000
def scrape_aa2000_flights():
    driver = None
    flights = []
    current_time = int(time.time())
    six_hours_future = current_time + (6 * 3600)

    try:
        logger.info("Scrapeando datos de AA2000...")
        driver = setup_driver()
        if driver is None:
            logger.error("No se pudo inicializar el driver de Selenium. Saltando el scraper de AA2000.")
            return flights

        url = "https://www.aa2000.com.ar/arribos-y-partidas?airport=AEP"
        driver.get(url)
        time.sleep(5)

        arrivals = driver.find_elements(By.CSS_SELECTOR, "div.arrivals table tbody tr")
        departures = driver.find_elements(By.CSS_SELECTOR, "div.departures table tbody tr")

        for row in arrivals:
            cells = row.find_elements(By.TAG_NAME, "td")
            if len(cells) >= 5:
                flight_number = cells[0].text.strip()
                airline = cells[1].text.strip()
                origin = cells[2].text.strip()
                scheduled_time = cells[3].text.strip()
                date = datetime.now().strftime("%d %b")
                status = cells[4].text.strip()

                if "AR" in flight_number or "Aerolíneas Argentinas" in airline:
                    scheduled_timestamp, formatted_time = parse_aa2000_datetime(date, scheduled_time)
                    if current_time <= scheduled_timestamp <= six_hours_future:
                        flights.append({
                            "flight_iata": flight_number,
                            "airline_iata": "AR",
                            "departure": origin,
                            "arrival": "AEP",
                            "estimated_departure": "N/A",
                            "estimated_arrival": formatted_time,
                            "status": status,
                            "lat": AIRPORT_COORDS.get(origin, AIRPORT_COORDS["AEP"])["lat"],
                            "lon": AIRPORT_COORDS.get(origin, AIRPORT_COORDS["AEP"])["lon"]
                        })

        for row in departures:
            cells = row.find_elements(By.TAG_NAME, "td")
            if len(cells) >= 5:
                flight_number = cells[0].text.strip()
                airline = cells[1].text.strip()
                destination = cells[2].text.strip()
                scheduled_time = cells[3].text.strip()
                date = datetime.now().strftime("%d %b")
                status = cells[4].text.strip()

                if "AR" in flight_number or "Aerolíneas Argentinas" in airline:
                    scheduled_timestamp, formatted_time = parse_aa2000_datetime(date, scheduled_time)
                    if current_time <= scheduled_timestamp <= six_hours_future:
                        flights.append({
                            "flight_iata": flight_number,
                            "airline_iata": "AR",
                            "departure": "AEP",
                            "arrival": destination,
                            "estimated_departure": formatted_time,
                            "estimated_arrival": "N/A",
                            "status": status,
                            "lat": AIRPORT_COORDS.get("AEP", {"lat": -34.5592})["lat"],
                            "lon": AIRPORT_COORDS.get("AEP", {"lon": -58.4156})["lon"]
                        })

        logger.info(f"Vuelos scrapeados de AA2000 (AR, AEP, próximas 6 horas): {len(flights)}")
        if flights:
            logger.info(f"Primeros 3 vuelos scrapeados de AA2000: {flights[:3]}")

    except Exception as e:
        logger.error(f"Error al scrapear AA2000: {str(e)}")
    finally:
        if driver:
            driver.quit()

    return flights

# Ruta para servir la página principal
@app.get("/", response_class=HTMLResponse)
@app.head("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# Ruta para obtener todos los vuelos
@app.get("/flights")
async def get_flights():
    all_flights = []
    current_time = int(time.time())
    six_hours_future = current_time + (6 * 3600)

    # 1. Scraper de AA2000
    try:
        aa2000_flights = scrape_aa2000_flights()
        all_flights.extend(aa2000_flights)
    except Exception as e:
        logger.error(f"Error al obtener vuelos de AA2000: {str(e)}")

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
                    lat = AIRPORT_COORDS.get(departure, {"lat": -34.5592})["lat"]
                    lon = AIRPORT_COORDS.get(departure, {"lon": -58.4156})["lon"]

                    estimated_departure = flight.get("dep_estimated", "N/A")
                    estimated_arrival = flight.get("arr_estimated", "N/A")
                    if estimated_departure != "N/A":
                        estimated_departure = datetime.strptime(estimated_departure, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")
                    if estimated_arrival != "N/A":
                        estimated_arrival = datetime.strptime(estimated_arrival, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")

                    all_flights.append({
                        "flight_iata": flight.get("flight_iata", "N/A"),
                        "airline_iata": flight.get("airline_iata", "N/A"),
                        "departure": departure,
                        "arrival": arrival,
                        "estimated_departure": estimated_departure,
                        "estimated_arrival": estimated_arrival,
                        "status": flight.get("status", "N/A"),
                        "lat": lat,
                        "lon": lon
                    })
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar GoFlightLabs: {str(e)}")
        except Exception as e:
            logger.error(f"Error inesperado al consultar GoFlightLabs: {str(e)}")

    # 3. Consultar AviationStack
    async with httpx.AsyncClient() as client:
        try:
            logger.info("Consultando la API de AviationStack...")
            response = await client.get(AVIATIONSTACK_API_URL)
            response.raise_for_status()
            data = response.json()

            logger.info(f"Datos recibidos de AviationStack: {data}")

            flights = data.get("data", [])
            logger.info(f"Total de vuelos recibidos de AviationStack: {len(flights)}")
            
            if flights:
                logger.info(f"Primeros 3 vuelos crudos de AviationStack: {flights[:3]}")
            else:
                logger.info("No se recibieron vuelos de AviationStack")

            filtered_flights = [
                flight for flight in flights
                if (
                    flight.get("airline", {}).get("iata", "").upper() == "AR"
                    and (flight.get("departure", {}).get("iata", "") == "AEP"
                         or flight.get("arrival", {}).get("iata", "") == "AEP")
                    and flight.get("departure", {}).get("scheduled", None) is not None
                )
            ]

            filtered_flights = [
                flight for flight in filtered_flights
                if (
                    current_time <= parse_aviationstack_time(
                        flight.get("departure", {}).get("scheduled", "1970-01-01T00:00:00+00:00")
                    ) <= six_hours_future
                )
            ]

            logger.info(f"Vuelos filtrados de AviationStack (AR, AEP, próximas 6 horas): {len(filtered_flights)}")

            for flight in filtered_flights:
                departure = flight.get("departure", {}).get("iata", "N/A")
                arrival = flight.get("arrival", {}).get("iata", "N/A")
                lat = AIRPORT_COORDS.get(departure, {"lat": -34.5592})["lat"]
                lon = AIRPORT_COORDS.get(departure, {"lon": -58.4156})["lon"]

                status = flight.get("flight_status", "N/A")

                estimated_departure = flight.get("departure", {}).get("estimated", "N/A")
                estimated_arrival = flight.get("arrival", {}).get("estimated", "N/A")
                if estimated_departure != "N/A":
                    estimated_departure = datetime.strptime(estimated_departure[:19], "%Y-%m-%dT%H:%M:%S").strftime("%H:%M")
                if estimated_arrival != "N/A":
                    estimated_arrival = datetime.strptime(estimated_arrival[:19], "%Y-%m-%dT%H:%M:%S").strftime("%H:%M")

                all_flights.append({
                    "flight_iata": flight.get("flight", {}).get("iata", "N/A"),
                    "airline_iata": flight.get("airline", {}).get("iata", "N/A"),
                    "departure": departure,
                    "arrival": arrival,
                    "estimated_departure": estimated_departure,
                    "estimated_arrival": estimated_arrival,
                    "status": status,
                    "lat": lat,
                    "lon": lon
                })
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar AviationStack: {str(e)}")
        except Exception as e:
            logger.error(f"Error inesperado al consultar AviationStack: {str(e)}")

    # 4. Eliminar duplicados basados en flight_iata
    seen_flights = set()
    unique_flights = []
    for flight in all_flights:
        flight_iata = flight["flight_iata"]
        if flight_iata not in seen_flights:
            seen_flights.add(flight_iata)
            unique_flights.append(flight)

    logger.info(f"Total de vuelos procesados: {len(unique_flights)}")

    return {"flights": unique_flights}

# Función auxiliar para parsear el tiempo de AviationStack
def parse_aviationstack_time(time_str):
    try:
        return int(time.mktime(time.strptime(time_str[:19], "%Y-%m-%dT%H:%M:%S")))
    except Exception as e:
        logger.error(f"Error al parsear tiempo de AviationStack: {time_str}, error: {str(e)}")
        return 0

# WebSocket para rastrear usuarios conectados
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    try:
        # Enviar el número inicial de usuarios conectados
        await websocket.send_text(str(len(connected_clients)))
        # Notificar a todos los clientes del nuevo número de usuarios conectados
        for client in connected_clients:
            if client != websocket:  # No enviar al cliente que se acaba de conectar
                await client.send_text(str(len(connected_clients)))
        while True:
            await websocket.receive_text()  # Mantener la conexión viva
    except WebSocketDisconnect:
        connected_clients.remove(websocket)
        # Notificar a los clientes restantes del nuevo número de usuarios conectados
        for client in connected_clients:
            await client.send_text(str(len(connected_clients)))
    except Exception as e:
        logger.error(f"Error en WebSocket: {str(e)}")
        connected_clients.remove(websocket)
        for client in connected_clients:
            await client.send_text(str(len(connected_clients)))

# Iniciar el servidor
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

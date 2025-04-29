from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi.requests import Request
import httpx
import uvicorn
import logging
import time
from datetime import datetime
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
    failed_sources = []

    # 1. Scraper de AA2000 (Desactivado temporalmente hasta resolver el problema con chromedriver)
    """
    try:
        aa2000_flights = scrape_aa2000_flights()
        all_flights.extend(aa2000_flights)
    except Exception as e:
        logger.error(f"Error al obtener vuelos de AA2000: {str(e)}")
        failed_sources.append("AA2000")
    """

    # 2. Scraper de TAMS (Desactivado temporalmente hasta resolver el problema con chromedriver)
    """
    try:
        tams_flights = scrape_tams_flights()
        all_flights.extend(tams_flights)
    except Exception as e:
        logger.error(f"Error al obtener vuelos de TAMS: {str(e)}")
        failed_sources.append("TAMS")
    """

    # 3. Consultar GoFlightLabs
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
                    lat = AIRPORT_COORDS.get(departure, {"lat": -34.5592})["lat"]
                    lon = AIRPORT_COORDS.get(departure, {"lon": -58.4156})["lon"]

                    estimated_departure = flight.get("dep_estimated", "N/A")
                    estimated_arrival = flight.get("arr_estimated", "N/A")
                    if estimated_departure != "N/A":
                        estimated_departure = datetime.strptime(estimated_departure, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")
                    if estimated_arrival != "N/A":
                        estimated_arrival = datetime.strptime(estimated_arrival, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")

                    scheduled_departure = flight.get("dep_scheduled", "N/A")
                    scheduled_arrival = flight.get("arr_scheduled", "N/A")
                    if scheduled_departure != "N/A":
                        scheduled_departure = datetime.strptime(scheduled_departure, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")
                    if scheduled_arrival != "N/A":
                        scheduled_arrival = datetime.strptime(scheduled_arrival, "%Y-%m-%d %H:%M:%S").strftime("%H:%M")

                    departure_delay = str(flight.get("dep_delayed", "0"))
                    arrival_delay = str(flight.get("arr_delayed", "0"))
                    departure_gate = flight.get("dep_gate", "N/A")
                    arrival_gate = flight.get("arr_gate", "N/A")
                    departure_terminal = flight.get("dep_terminal", "N/A")
                    arrival_terminal = flight.get("arr_terminal", "N/A")
                    aircraft = flight.get("aircraft_iata", "N/A")
                    airline_name = flight.get("airline_name", "N/A")
                    departure_airport = flight.get("dep_airport", departure)
                    arrival_airport = flight.get("arr_airport", arrival)

                    all_flights.append({
                        "flight_iata": flight.get("flight_iata", "N/A"),
                        "airline_iata": flight.get("airline_iata", "N/A"),
                        "airline_name": airline_name,
                        "departure": departure,
                        "departure_airport": departure_airport,
                        "arrival": arrival,
                        "arrival_airport": arrival_airport,
                        "estimated_departure": estimated_departure,
                        "estimated_arrival": estimated_arrival,
                        "scheduled_departure": scheduled_departure,
                        "scheduled_arrival": scheduled_arrival,
                        "departure_delay": departure_delay,
                        "arrival_delay": arrival_delay,
                        "departure_gate": departure_gate,
                        "arrival_gate": arrival_gate,
                        "departure_terminal": departure_terminal,
                        "arrival_terminal": arrival_terminal,
                        "aircraft": aircraft,
                        "status": flight.get("status", "N/A"),
                        "observations": "N/A",
                        "lat": lat,
                        "lon": lon
                    })
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar GoFlightLabs: {str(e)}")
            failed_sources.append("GoFlightLabs")
        except Exception as e:
            logger.error(f"Error inesperado al consultar GoFlightLabs: {str(e)}")
            failed_sources.append("GoFlightLabs")

    # 4. Consultar AviationStack
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

            # Filtrar vuelos, manejando valores None
            filtered_flights = []
            for flight in flights:
                airline_iata = flight.get("airline", {}).get("iata", "") or ""
                departure_iata = flight.get("departure", {}).get("iata", "") or ""
                arrival_iata = flight.get("arrival", {}).get("iata", "") or ""
                scheduled = flight.get("departure", {}).get("scheduled", None)

                if (
                    airline_iata.upper() == "AR"
                    and (departure_iata == "AEP" or arrival_iata == "AEP")
                    and scheduled is not None
                ):
                    filtered_flights.append(flight)

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

                scheduled_departure = flight.get("departure", {}).get("scheduled", "N/A")
                scheduled_arrival = flight.get("arrival", {}).get("scheduled", "N/A")
                if scheduled_departure != "N/A":
                    scheduled_departure = datetime.strptime(scheduled_departure[:19], "%Y-%m-%dT%H:%M:%S").strftime("%H:%M")
                if scheduled_arrival != "N/A":
                    scheduled_arrival = datetime.strptime(scheduled_arrival[:19], "%Y-%m-%dT%H:%M:%S").strftime("%H:%M")

                departure_delay = str(flight.get("departure", {}).get("delay", "0"))
                arrival_delay = str(flight.get("arrival", {}).get("delay", "0"))
                departure_gate = flight.get("departure", {}).get("gate", "N/A")
                arrival_gate = flight.get("arrival", {}).get("gate", "N/A")
                departure_terminal = flight.get("departure", {}).get("terminal", "N/A")
                arrival_terminal = flight.get("arrival", {}).get("terminal", "N/A")
                aircraft = flight.get("aircraft", {}).get("iata", "N/A")
                airline_name = flight.get("airline", {}).get("name", "N/A")
                departure_airport = flight.get("departure", {}).get("airport", departure)
                arrival_airport = flight.get("arrival", {}).get("airport", arrival)

                all_flights.append({
                    "flight_iata": flight.get("flight", {}).get("iata", "N/A"),
                    "airline_iata": flight.get("airline", {}).get("iata", "N/A"),
                    "airline_name": airline_name,
                    "departure": departure,
                    "departure_airport": departure_airport,
                    "arrival": arrival,
                    "arrival_airport": arrival_airport,
                    "estimated_departure": estimated_departure,
                    "estimated_arrival": estimated_arrival,
                    "scheduled_departure": scheduled_departure,
                    "scheduled_arrival": scheduled_arrival,
                    "departure_delay": departure_delay,
                    "arrival_delay": arrival_delay,
                    "departure_gate": departure_gate,
                    "arrival_gate": arrival_gate,
                    "departure_terminal": departure_terminal,
                    "arrival_terminal": arrival_terminal,
                    "aircraft": aircraft,
                    "status": status,
                    "observations": "N/A",
                    "lat": lat,
                    "lon": lon
                })
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar AviationStack: {str(e)}")
            failed_sources.append("AviationStack")
        except Exception as e:
            logger.error(f"Error inesperado al consultar AviationStack: {str(e)}")
            failed_sources.append("AviationStack")

    # 5. Eliminar duplicados basados en flight_iata
    seen_flights = set()
    unique_flights = []
    for flight in all_flights:
        flight_iata = flight["flight_iata"]
        if flight_iata not in seen_flights:
            seen_flights.add(flight_iata)
            unique_flights.append(flight)

    logger.info(f"Total de vuelos procesados: {len(unique_flights)}")

    return {
        "flights": unique_flights,
        "failed_sources": failed_sources
    }

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
        await websocket.send_text(str(len(connected_clients)))
        for client in connected_clients:
            if client != websocket:
                await client.send_text(str(len(connected_clients)))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.remove(websocket)
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

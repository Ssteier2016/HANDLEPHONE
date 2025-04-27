from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi.requests import Request
import httpx
import uvicorn
import logging
import time

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Montar la carpeta templates para archivos estáticos
app.mount("/templates", StaticFiles(directory="templates"), name="templates")

# Configurar Jinja2 para plantillas HTML
templates = Jinja2Templates(directory="templates")

# Clave de API de GoFlightLabs
API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI0IiwianRpIjoiZjkzOWJiZmM2ZWY3Y2QxMzcyY2I2NjJjZjI0NzI0ZTAwY2I0M2RmZTcyMmY2NDZiNTQwNjJiMTk0NGM4NGEwZDc3MjU1NWY1ZDA3YWRlZDkiLCJpYXQiOjE3NDQ5MjU3NjYsIm5iZiI6MTc0NDkyNTc2NiwiZXhwIjoxNzc2NDYxNzY1LCJzdWIiOiIyNDcxNyIsInNjb3BlcyI6W119.Ln6gpY3DDOUHesjuqbIeVYh86GLvggRaPaP8oGh-mGy8hQxMlqX7ie_U0zXfowKKFInnDdsHAg8PuZB2yt31qQ"
API_URL = f"https://www.goflightlabs.com/flights?access_key={API_KEY}"

# Coordenadas aproximadas de los aeropuertos
AIRPORT_COORDS = {
    "AEP": {"lat": -34.5592, "lon": -58.4156},
    "EZE": {"lat": -34.8222, "lon": -58.5358}
}

# Ruta para servir la página principal (permitir GET y HEAD)
@app.get("/", response_class=HTMLResponse)
@app.head("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# Ruta para obtener los vuelos de Aeroparque (AEP) y Ezeiza (EZE)
@app.get("/flights")
async def get_flights():
    all_flights = []

    # Calcular el rango de tiempo: desde 12 horas en el pasado hasta 12 horas en el futuro
    current_time = int(time.time())
    twelve_hours_ago = current_time - (12 * 3600)  # 12 horas en el pasado
    twelve_hours_future = current_time + (12 * 3600)  # 12 horas en el futuro

    # 1. Consultar GoFlightLabs
    async with httpx.AsyncClient() as client:
        try:
            logger.info("Consultando la API de GoFlightLabs...")
            response = await client.get(API_URL)
            response.raise_for_status()
            data = response.json()

            logger.info(f"Datos recibidos de GoFlightLabs: {data}")

            if not data.get("success"):
                logger.error("GoFlightLabs no devolvió éxito")
            else:
                flights = data.get("data", [])
                logger.info(f"Total de vuelos recibidos de GoFlightLabs: {len(flights)}")

                # Filtrar vuelos de GoFlightLabs
                filtered_goflight_flights = [
                    flight for flight in flights
                    if (flight.get("dep_iata") in ["AEP", "EZE"] or flight.get("arr_iata") in ["AEP", "EZE"])
                    and (flight.get("flight_iata", "").startswith("AR") or flight.get("flight_iata", "").startswith("ARG"))
                    and twelve_hours_ago <= flight.get("updated", 0) <= twelve_hours_future
                ]

                # Formatear vuelos de GoFlightLabs y añadir coordenadas
                for flight in filtered_goflight_flights:
                    departure = flight.get("dep_iata", "N/A")
                    arrival = flight.get("arr_iata", "N/A")
                    
                    # Asignar coordenadas aproximadas (simulamos posición intermedia)
                    if departure in AIRPORT_COORDS and arrival in AIRPORT_COORDS:
                        dep_coords = AIRPORT_COORDS[departure]
                        arr_coords = AIRPORT_COORDS[arrival]
                        # Simulamos una posición intermedia entre salida y llegada
                        lat = (dep_coords["lat"] + arr_coords["lat"]) / 2
                        lon = (dep_coords["lon"] + arr_coords["lon"]) / 2
                    else:
                        # Si no conocemos las coordenadas, usamos un valor por defecto (centro entre AEP y EZE)
                        lat = (-34.5592 + -34.8222) / 2
                        lon = (-58.4156 + -58.5358) / 2

                    all_flights.append({
                        "flight_iata": flight.get("flight_iata", "N/A"),
                        "airline_iata": flight.get("airline_iata", "N/A"),
                        "departure": departure,
                        "arrival": arrival,
                        "status": flight.get("status", "N/A"),
                        "updated": flight.get("updated", 0),
                        "lat": lat,
                        "lon": lon
                    })
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar GoFlightLabs: {str(e)}")
        except Exception as e:
            logger.error(f"Error inesperado al consultar GoFlightLabs: {str(e)}")

    # 2. Eliminar duplicados basados en flight_iata
    seen_flights = set()
    unique_flights = []
    for flight in all_flights:
        flight_iata = flight["flight_iata"]
        if flight_iata not in seen_flights:
            seen_flights.add(flight_iata)
            unique_flights.append(flight)

    logger.info(f"Vuelos combinados y filtrados para AEP/EZE y AR/ARG (entre 12h pasado y 12h futuro): {len(unique_flights)}")

    return {"flights": unique_flights}

# Iniciar el servidor
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

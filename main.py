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

# Ruta para servir la página principal (permitir GET y HEAD)
@app.get("/", response_class=HTMLResponse)
@app.head("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# Ruta para obtener los vuelos de Aeroparque (AEP)
@app.get("/flights")
async def get_flights():
    async with httpx.AsyncClient() as client:
        try:
            # Hacer solicitud a la API de GoFlightLabs
            logger.info("Consultando la API de GoFlightLabs...")
            response = await client.get(API_URL)
            response.raise_for_status()
            data = response.json()

            # Registrar los datos crudos
            logger.info(f"Datos recibidos de la API: {data}")

            if not data.get("success"):
                logger.error("La API no devolvió éxito")
                return {"error": "No se pudo obtener datos de la API"}

            # Filtrar vuelos que llegan o salen de Aeroparque (AEP) y están en las últimas 12 horas
            flights = data.get("data", [])
            logger.info(f"Total de vuelos recibidos: {len(flights)}")

            # Calcular el timestamp de hace 12 horas
            current_time = int(time.time())
            twelve_hours_ago = current_time - (12 * 3600)  # 12 horas en segundos

            aep_flights = [
                flight for flight in flights
                if (flight.get("dep_iata") == "AEP" or flight.get("arr_iata") == "AEP")
                and flight.get("updated", 0) >= twelve_hours_ago
            ]

            logger.info(f"Vuelos filtrados para AEP (últimas 12 horas): {len(aep_flights)}")

            # Formatear los datos para el frontend
            formatted_flights = []
            for flight in aep_flights:
                formatted_flights.append({
                    "flight_iata": flight.get("flight_iata", "N/A"),
                    "airline_iata": flight.get("airline_iata", "N/A"),
                    "departure": flight.get("dep_iata", "N/A"),
                    "arrival": flight.get("arr_iata", "N/A"),
                    "status": flight.get("status", "N/A"),
                    "updated": flight.get("updated", 0)
                })

            return {"flights": formatted_flights}
        except httpx.HTTPStatusError as e:
            logger.error(f"Error HTTP al consultar la API: {str(e)}")
            return {"error": f"Error al consultar la API: {str(e)}"}
        except Exception as e:
            logger.error(f"Error inesperado: {str(e)}")
            return {"error": f"Error inesperado: {str(e)}"}

# Iniciar el servidor
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

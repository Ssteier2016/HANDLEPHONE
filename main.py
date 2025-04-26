from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi.requests import Request
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

# Datos simulados para vuelos de Aeroparque (AEP)
# Timestamps ajustados para probar el filtro de 12 horas
SIMULATED_FLIGHTS = [
    {
        "flight_iata": "AR1234",
        "airline_iata": "AR",
        "dep_iata": "AEP",
        "arr_iata": "COR",
        "status": "en-route",
        "updated": int(time.time()) - 3600  # Hace 1 hora
    },
    {
        "flight_iata": "AR5678",
        "airline_iata": "AR",
        "dep_iata": "MDZ",
        "arr_iata": "AEP",
        "status": "landed",
        "updated": int(time.time()) - 7200  # Hace 2 horas
    },
    {
        "flight_iata": "AR9012",
        "airline_iata": "AR",
        "dep_iata": "AEP",
        "arr_iata": "IGR",
        "status": "en-route",
        "updated": int(time.time()) - 54000  # Hace 15 horas (fuera del rango)
    },
    {
        "flight_iata": "AR3456",
        "airline_iata": "AR",
        "dep_iata": "ROS",
        "arr_iata": "AEP",
        "status": "landed",
        "updated": int(time.time()) - 18000  # Hace 5 horas
    }
]

# Ruta para servir la página principal (permitir GET y HEAD)
@app.get("/", response_class=HTMLResponse)
@app.head("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# Ruta para obtener los vuelos de Aeroparque (AEP)
@app.get("/flights")
async def get_flights():
    try:
        # Usar datos simulados
        logger.info("Usando datos simulados para vuelos de Aeroparque (AEP)")
        
        # Calcular el timestamp de hace 12 horas
        current_time = int(time.time())
        twelve_hours_ago = current_time - (12 * 3600)  # 12 horas en segundos
        
        # Filtrar vuelos de las últimas 12 horas
        recent_flights = [
            flight for flight in SIMULATED_FLIGHTS
            if flight.get("updated", 0) >= twelve_hours_ago
        ]

        logger.info(f"Vuelos simulados totales: {len(SIMULATED_FLIGHTS)}")
        logger.info(f"Vuelos filtrados (últimas 12 horas): {len(recent_flights)}")

        # Formatear los datos para el frontend
        formatted_flights = []
        for flight in recent_flights:
            formatted_flights.append({
                "flight_iata": flight.get("flight_iata", "N/A"),
                "airline_iata": flight.get("airline_iata", "N/A"),
                "departure": flight.get("dep_iata", "N/A"),
                "arrival": flight.get("arr_iata", "N/A"),
                "status": flight.get("status", "N/A"),
                "updated": flight.get("updated", 0)
            })

        return {"flights": formatted_flights}
    except Exception as e:
        logger.error(f"Error inesperado: {str(e)}")
        return {"error": f"Error inesperado: {str(e)}"}

# Iniciar el servidor
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

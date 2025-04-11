import time
import os
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from bs4 import BeautifulSoup
from datetime import datetime
import psycopg2
from psycopg2 import sql

# Configurar Selenium con Chrome en modo headless
def setup_driver():
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
    
    # En Render, Chromium y ChromeDriver ya están instalados por el buildCommand
    driver = webdriver.Chrome(options=chrome_options)
    return driver

# Función para extraer vuelos
def scrape_flights(flight_type="partidas", airport="Aeroparque, AEP", date="11-04-2025"):
    driver = setup_driver()
    url = f"https://www.aeropuertosargentina.com/es/vuelos?movtp={flight_type}&idarpt={airport.replace(', ', '%2C%20')}&fecha={date}"

    try:
        driver.get(url)
        print(f"Página cargada para {flight_type} en {airport} el {date}. Esperando elementos...")

        flight_type_button = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.XPATH, f"//button[span[text()='{flight_type.capitalize()}']]"))
        )
        flight_type_button.click()
        print(f"Botón de '{flight_type.capitalize()}' seleccionado.")

        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.CLASS_NAME, "flight-list"))  # Ajusta este selector
        )
        print("Lista de vuelos detectada.")

        html = driver.page_source
        soup = BeautifulSoup(html, "html.parser")

        flight_list = soup.find("div", class_="flight-list")  # Ajusta según el HTML real
        if not flight_list:
            print("No se encontró la lista de vuelos. Revisa el HTML de la página.")
            return None

        flights = []
        flight_items = flight_list.find_all("div", class_="flight-item")  # Ajusta la clase
        for item in flight_items:
            flight = {
                "flight_number": item.find("span", class_="flight-number").text.strip() if item.find("span", class_="flight-number") else "N/A",
                "destination": item.find("span", class_="destination").text.strip() if item.find("span", class_="destination") else "N/A",
                "scheduled_time": item.find("span", class_="scheduled-time").text.strip() if item.find("span", class_="scheduled-time") else "N/A",
                "status": item.find("span", class_="status").text.strip() if item.find("span", class_="status") else "N/A",
                "gate": item.find("span", class_="gate").text.strip() if item.find("span", class_="gate") else "N/A",
                "flight_type": flight_type
            }
            flights.append(flight)

        return flights

    except Exception as e:
        print(f"Error al realizar el scraping: {e}")
        return None
    finally:
        driver.quit()

# Función para guardar en PostgreSQL
def save_to_database(flights, host, user, password, database, port="5432"):
    try:
        connection = psycopg2.connect(
            host=host,
            user=user,
            password=password,
            database=database,
            port=port
        )
        cursor = connection.cursor()

        for flight in flights:
            cursor.execute("""
                INSERT INTO flights (flight_number, destination, scheduled_time, status, gate, flight_type)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT ON CONSTRAINT unique_flight
                DO NOTHING
            """, (
                flight["flight_number"],
                flight["destination"],
                flight["scheduled_time"],
                flight["status"],
                flight["gate"],
                flight["flight_type"]
            ))

        connection.commit()
        print(f"Se guardaron {len(flights)} vuelos en la base de datos a las {datetime.now()}.")

    except Exception as e:
        print(f"Error al guardar en la base de datos: {e}")
    finally:
        connection.close()

# Función principal
def main():
    print(f"Scraping iniciado a las {datetime.now()}")
    
    departures = scrape_flights(flight_type="partidas", airport="Aeroparque, AEP", date="11-04-2025")
    arrivals = scrape_flights(flight_type="arribos", airport="Aeroparque, AEP", date="11-04-2025")
    
    all_flights = (departures or []) + (arrivals or [])
    all_flights = [flight for flight in all_flights if flight["status"].lower() != "cancelado"]
    
    if all_flights:
        save_to_database(
            flights=all_flights,
            host=os.getenv("DB_HOST"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
            database=os.getenv("DB_NAME"),
            port=os.getenv("DB_PORT", "5432")
        )
    else:
        print("No se pudieron obtener los datos de los vuelos.")
    
    print(f"Scraping finalizado a las {datetime.now()}")

if __name__ == "__main__":
    main()

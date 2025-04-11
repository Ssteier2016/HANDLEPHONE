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

def setup_driver():
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
    driver = webdriver.Chrome(options=chrome_options)
    return driver

def save_to_database(flights, db_url):
    try:
        conn = psycopg2.connect(db_url)
        cursor = conn.cursor()
        # Crear tabla si no existe
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS flights (
                id SERIAL PRIMARY KEY,
                flight_number VARCHAR(10),
                origin_destination VARCHAR(100),
                scheduled_time VARCHAR(20),
                status VARCHAR(50),
                gate VARCHAR(20),
                flight_type VARCHAR(20),
                scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_flight UNIQUE (flight_number, scheduled_time, flight_type)
            );
        """)
        # Insertar vuelos
        for flight in flights:
            cursor.execute("""
                INSERT INTO flights (flight_number, origin_destination, scheduled_time, status, gate, flight_type)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT ON CONSTRAINT unique_flight
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
        print(f"Guardados {len(flights)} vuelos a las {datetime.now()}.")
    except Exception as e:
        print(f"Error en DB: {e}")
    finally:
        if 'cursor' in locals():
            cursor.close()
        if 'conn' in locals():
            conn.close()

def scrape_flights(flight_type="partidas", airport="Aeroparque, AEP"):
    driver = setup_driver()
    date = datetime.now().strftime("%d-%m-%Y")  # Fecha actual
    url = f"https://www.aeropuertosargentina.com/es/vuelos?movtp={flight_type}&idarpt={airport.replace(', ', '%2C%20')}&fecha={date}"
    
    try:
        driver.get(url)
        print(f"Cargando {flight_type} para {airport} el {date}...")
        
        # Esperar a que cargue la lista de vuelos
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.CLASS_NAME, "flight-list"))  # Ajustar
        )
        html = driver.page_source
        soup = BeautifulSoup(html, "html.parser")
        
        flight_list = soup.find("div", class_="flight-list")
        if not flight_list:
            print("No se encontró la lista de vuelos.")
            return []
        
        flights = []
        flight_items = flight_list.find_all("div", class_="flight-item")  # Ajustar
        for item in flight_items:
            airline = item.find("span", class_="airline").text.strip() if item.find("span", class_="airline") else ""
            if "Aerolíneas Argentinas" not in airline:
                continue
            flight = {
                "flight_number": item.find("span", class_="flight-number").text.strip() if item.find("span", class_="flight-number") else "N/A",
                "origin_destination": item.find("span", class_="destination").text.strip() if item.find("span", class_="destination") else "N/A",
                "scheduled_time": item.find("span", class_="scheduled-time").text.strip() if item.find("span", class_="scheduled-time") else "N/A",
                "status": item.find("span", class_="status").text.strip() if item.find("span", class_="status") else "N/A",
                "gate": item.find("span", class_="gate").text.strip() if item.find("span", class_="gate") else "N/A",
                "flight_type": flight_type
            }
            if flight["status"].lower() != "cancelado":
                flights.append(flight)
        
        return flights
    
    except Exception as e:
        print(f"Error scraping {flight_type}: {e}")
        return []
    finally:
        driver.quit()

def main():
    print(f"Scraping iniciado a las {datetime.now()}")
    
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("Error: DATABASE_URL no está definida")
        return
    
    departures = scrape_flights(flight_type="partidas", airport="Aeroparque, AEP")
    arrivals = scrape_flights(flight_type="llegadas", airport="Aeroparque, AEP")
    
    all_flights = (departures or []) + (arrivals or [])
    
    if all_flights:
        save_to_database(all_flights, db_url)
    else:
        print("No se obtuvieron vuelos.")
    
    print(f"Scraping finalizado a las {datetime.now()}")

if __name__ == "__main__":
    main()

document.addEventListener('DOMContentLoaded', () => {
  console.log("Script cargado y DOM listo");

  const refreshBtn = document.getElementById('refresh-btn');
  const flightsBody = document.getElementById('flights-body');
  const airportName = document.getElementById('airport-name');

  if (!refreshBtn || !flightsBody || !airportName) {
    console.error("No se encontraron los elementos del DOM:", {
      refreshBtn: !!refreshBtn,
      flightsBody: !!flightsBody,
      airportName: !!airportName
    });
    return;
  }

  // Inicializar el mapa con Leaflet
  const map = L.map('map').setView([-34.6907, -58.4757], 10); // Centro entre AEP y EZE, zoom 10

  // Añadir capa de OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Función para actualizar los marcadores en el mapa
  function updateMapMarkers(flights) {
    // Limpiar marcadores existentes (excepto la capa base del mapa)
    map.eachLayer(layer => {
      if (layer instanceof L.Marker) {
        map.removeLayer(layer);
      }
    });

    // Añadir marcadores para cada vuelo
    flights.forEach(flight => {
      if (flight.lat && flight.lon) {
        const marker = L.marker([flight.lat, flight.lon]).addTo(map);
        marker.bindPopup(`
          <b>Vuelo:</b> ${flight.flight_iata}<br>
          <b>Aerolínea:</b> ${flight.airline_iata}<br>
          <b>Salida:</b> ${flight.departure}<br>
          <b>Llegada:</b> ${flight.arrival}<br>
          <b>Estado:</b> ${flight.status}
        `);
      }
    });
  }

  // Función para obtener y mostrar los vuelos
  async function fetchFlights() {
    try {
      console.log("Haciendo solicitud a /flights...");
      const response = await fetch('/flights');
      console.log("Respuesta recibida:", response);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log("Datos recibidos:", data);

      if (data.error) {
        flightsBody.innerHTML = `<tr><td colspan="6">Error: ${data.error}</td></tr>`;
        return;
      }

      const flights = data.flights || [];
      if (flights.length === 0) {
        airportName.textContent = "Aeroparque (AEP) y Ezeiza (EZE)";
        flightsBody.innerHTML = '<tr><td colspan="6">No se encontraron vuelos de Aerolíneas Argentinas (AR/ARG) para Aeroparque (AEP) o Ezeiza (EZE) entre 12 horas en el pasado y 12 horas en el futuro.</td></tr>';
        updateMapMarkers([]); // Limpiar el mapa
        return;
      }

      // Actualizar el nombre del aeropuerto
      airportName.textContent = "Aeroparque (AEP) y Ezeiza (EZE)";

      // Limpiar tabla
      flightsBody.innerHTML = '';

      // Llenar tabla con datos de vuelos
      flights.forEach(flight => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${flight.flight_iata}</td>
          <td>${flight.airline_iata}</td>
          <td>${flight.departure}</td>
          <td>${flight.arrival}</td>
          <td>${flight.status}</td>
          <td>${new Date(flight.updated * 1000).toLocaleString('es-AR')}</td>
        `;
        flightsBody.appendChild(row);
      });

      // Actualizar el mapa con los marcadores
      updateMapMarkers(flights);

    } catch (error) {
      console.error("Error al cargar los vuelos:", error);
      flightsBody.innerHTML = `<tr><td colspan="6">Error al cargar los vuelos: ${error.message}</td></tr>`;
      updateMapMarkers([]); // Limpiar el mapa en caso de error
    }
  }

  // Cargar vuelos al iniciar
  console.log("Cargando vuelos al iniciar...");
  fetchFlights();

  // Actualizar vuelos al hacer clic en el botón
  refreshBtn.addEventListener('click', () => {
    console.log("Botón de actualizar clicado");
    fetchFlights();
  });
});

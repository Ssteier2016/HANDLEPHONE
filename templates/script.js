document.addEventListener('DOMContentLoaded', () => {
  console.log("Script cargado y DOM listo");

  const refreshBtn = document.getElementById('refresh-btn');
  const filterBtn = document.getElementById('filter-btn');
  const airlineFilter = document.getElementById('airline-filter');
  const flightsBody = document.getElementById('flights-body');
  const lastUpdated = document.getElementById('last-updated');

  if (!refreshBtn || !filterBtn || !airlineFilter || !flightsBody || !lastUpdated) {
    console.error("No se encontraron los elementos del DOM:", {
      refreshBtn: !!refreshBtn,
      filterBtn: !!filterBtn,
      airlineFilter: !!airlineFilter,
      flightsBody: !!flightsBody,
      lastUpdated: !!lastUpdated
    });
    return;
  }

  // Inicializar el mapa con Leaflet (centrado en un punto genérico)
  const map = L.map('map').setView([-34.6907, -58.4757], 5);

  // Añadir capa de OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Variable para almacenar todos los vuelos
  let allFlights = [];

  // Función para actualizar los marcadores en el mapa
  function updateMapMarkers(flights) {
    console.log("Actualizando marcadores en el mapa con", flights.length, "vuelos");
    map.eachLayer(layer => {
      if (layer instanceof L.Marker) {
        map.removeLayer(layer);
      }
    });

    flights.forEach(flight => {
      if (flight.lat && flight.lon) {
        console.log("Añadiendo marcador para vuelo:", flight.flight_iata, "en", flight.lat, flight.lon);
        const marker = L.marker([flight.lat, flight.lon]).addTo(map);
        marker.bindPopup(`
          <b>Vuelo:</b> ${flight.flight_iata || 'N/A'}<br>
          <b>Aerolínea:</b> ${flight.airline_iata || 'N/A'}<br>
          <b>Salida:</b> ${flight.departure || 'N/A'}<br>
          <b>Llegada:</b> ${flight.arrival || 'N/A'}<br>
          <b>Estado:</b> ${flight.status || 'N/A'}
        `);
      } else {
        console.warn("Vuelo sin coordenadas:", flight);
      }
    });
  }

  // Función para actualizar la tabla
  function updateTable(flights) {
    console.log("Actualizando tabla con", flights.length, "vuelos");
    flightsBody.innerHTML = '';
    if (flights.length === 0) {
      flightsBody.innerHTML = '<tr><td colspan="5">No se encontraron vuelos para esta aerolínea.</td></tr>';
      return;
    }

    flights.forEach(flight => {
      console.log("Añadiendo fila para vuelo:", flight);
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${flight.flight_iata || 'N/A'}</td>
        <td>${flight.airline_iata || 'N/A'}</td>
        <td>${flight.departure || 'N/A'}</td>
        <td>${flight.arrival || 'N/A'}</td>
        <td>${flight.status || 'N/A'}</td>
      `;
      flightsBody.appendChild(row);
    });
  }

  // Función para actualizar la hora de la última actualización
  function updateLastUpdated() {
    const now = new Date();
    lastUpdated.textContent = `Última actualización: ${now.toLocaleString('es-AR')}`;
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
        console.error("Error en los datos:", data.error);
        flightsBody.innerHTML = `<tr><td colspan="5">Error: ${data.error}</td></tr>`;
        updateMapMarkers([]);
        return;
      }

      allFlights = data.flights || [];
      console.log("Vuelos procesados:", allFlights);

      if (allFlights.length === 0) {
        flightsBody.innerHTML = '<tr><td colspan="5">No se encontraron vuelos.</td></tr>';
        updateMapMarkers([]);
        return;
      }

      // Mostrar todos los vuelos inicialmente
      updateTable(allFlights);
      updateMapMarkers(allFlights);
      updateLastUpdated();

    } catch (error) {
      console.error("Error al cargar los vuelos:", error);
      flightsBody.innerHTML = `<tr><td colspan="5">Error al cargar los vuelos: ${error.message}</td></tr>`;
      updateMapMarkers([]);
    }
  }

  // Función para filtrar vuelos por aerolínea
  function filterFlights() {
    const airline = airlineFilter.value.trim().toUpperCase();
    console.log("Filtrando vuelos por aerolínea:", airline);
    if (!airline) {
      updateTable(allFlights);
      updateMapMarkers(allFlights);
      return;
    }

    const filteredFlights = allFlights.filter(flight => 
      (flight.airline_iata || '').toUpperCase() === airline || 
      (flight.flight_iata || '').toUpperCase().startsWith(airline)
    );
    console.log("Vuelos filtrados:", filteredFlights);

    updateTable(filteredFlights);
    updateMapMarkers(filteredFlights);
  }

  // Cargar vuelos al iniciar
  console.log("Cargando vuelos al iniciar...");
  fetchFlights();

  // Actualizar vuelos automáticamente cada hora (3600000 ms = 1 hora)
  setInterval(() => {
    console.log("Actualización automática de vuelos...");
    fetchFlights();
  }, 3600000);

  // Actualizar vuelos al hacer clic en el botón de refrescar
  refreshBtn.addEventListener('click', () => {
    console.log("Botón de actualizar clicado");
    fetchFlights();
  });

  // Filtrar vuelos al hacer clic en el botón de filtrar
  filterBtn.addEventListener('click', () => {
    console.log("Botón de filtrar clicado");
    filterFlights();
  });

  // Filtrar vuelos al presionar Enter en el campo de texto
  airlineFilter.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
      console.log("Enter presionado en el campo de filtro");
      filterFlights();
    }
  });
});

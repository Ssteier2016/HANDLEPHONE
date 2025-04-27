document.addEventListener('DOMContentLoaded', () => {
  console.log("Script cargado y DOM listo");

  const refreshBtn = document.getElementById('refresh-btn');
  const filterBtn = document.getElementById('filter-btn');
  const airlineFilter = document.getElementById('airline-filter');
  const flightsBody = document.getElementById('flights-body');
  const airportName = document.getElementById('airport-name');

  if (!refreshBtn || !filterBtn || !airlineFilter || !flightsBody) {
    console.error("No se encontraron los elementos del DOM:", {
      refreshBtn: !!refreshBtn,
      filterBtn: !!filterBtn,
      airlineFilter: !!airlineFilter,
      flightsBody: !!flightsBody,
      airportName: !!airportName
    });
    return;
  }

  // Inicializar el mapa con Leaflet (centrado en un punto genérico)
  const map = L.map('map').setView([-34.6907, -58.4757], 5); // Centro entre AEP y EZE, pero con zoom más amplio

  // Añadir capa de OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Variable para almacenar todos los vuelos
  let allFlights = [];

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

  // Función para actualizar la tabla
  function updateTable(flights) {
    flightsBody.innerHTML = '';
    if (flights.length === 0) {
      flightsBody.innerHTML = '<tr><td colspan="6">No se encontraron vuelos para esta aerolínea.</td></tr>';
      return;
    }

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
        updateMapMarkers([]);
        return;
      }

      allFlights = data.flights || [];
      if (allFlights.length === 0) {
        flightsBody.innerHTML = '<tr><td colspan="6">No se encontraron vuelos.</td></tr>';
        updateMapMarkers([]);
        return;
      }

      // Mostrar todos los vuelos inicialmente
      updateTable(allFlights);
      updateMapMarkers(allFlights);

    } catch (error) {
      console.error("Error al cargar los vuelos:", error);
      flightsBody.innerHTML = `<tr><td colspan="6">Error al cargar los vuelos: ${error.message}</td></tr>`;
      updateMapMarkers([]);
    }
  }

  // Función para filtrar vuelos por aerolínea
  function filterFlights() {
    const airline = airlineFilter.value.trim().toUpperCase();
    if (!airline) {
      // Si el campo está vacío, mostramos todos los vuelos
      updateTable(allFlights);
      updateMapMarkers(allFlights);
      return;
    }

    const filteredFlights = allFlights.filter(flight => 
      flight.airline_iata === airline || flight.flight_iata.startsWith(airline)
    );

    updateTable(filteredFlights);
    updateMapMarkers(filteredFlights);
  }

  // Cargar vuelos al iniciar
  console.log("Cargando vuelos al iniciar...");
  fetchFlights();

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

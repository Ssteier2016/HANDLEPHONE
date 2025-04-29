document.addEventListener('DOMContentLoaded', () => {
  console.log("Script cargado y DOM listo");

  const refreshBtn = document.getElementById('refresh-btn');
  const filterBtn = document.getElementById('filter-btn');
  const airlineFilter = document.getElementById('airline-filter');
  const originFilter = document.getElementById('origin-filter');
  const destinationFilter = document.getElementById('destination-filter');
  const voiceToggle = document.getElementById('voice-toggle');
  const flightsBody = document.getElementById('flights-body');
  const lastUpdated = document.getElementById('last-updated');

  if (!refreshBtn || !filterBtn || !airlineFilter || !originFilter || !destinationFilter || !voiceToggle || !flightsBody || !lastUpdated) {
    console.error("No se encontraron los elementos del DOM:", {
      refreshBtn: !!refreshBtn,
      filterBtn: !!filterBtn,
      airlineFilter: !!airlineFilter,
      originFilter: !!originFilter,
      destinationFilter: !!destinationFilter,
      voiceToggle: !!voiceToggle,
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
    // Limpiar marcadores existentes
    map.eachLayer(layer => {
      if (layer instanceof L.Marker) {
        map.removeLayer(layer);
      }
    });

    flights.forEach(flight => {
      // Verificar que las coordenadas existan y sean válidas
      if (flight.lat && flight.lon && !isNaN(flight.lat) && !isNaN(flight.lon)) {
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
        console.warn("Vuelo con coordenadas inválidas:", flight);
      }
    });
  }

  // Función para actualizar la tabla
  function updateTable(flights) {
    console.log("Actualizando tabla con", flights.length, "vuelos");
    flightsBody.innerHTML = '';
    if (flights.length === 0) {
      flightsBody.innerHTML = '<tr><td colspan="7">No se encontraron vuelos para los filtros aplicados.</td></tr>';
      return;
    }

    flights.forEach(flight => {
      console.log("Añadiendo fila para vuelo:", flight);
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${flight.flight_iata || 'N/A'}</td>
        <td>${flight.airline_iata || 'N/A'}</td>
        <td>${flight.estimated_departure || 'N/A'}</td>
        <td>${flight.departure || 'N/A'}</td>
        <td>${flight.estimated_arrival || 'N/A'}</td>
        <td>${flight.arrival || 'N/A'}</td>
        <td>${flight.status || 'N/A'}</td>
      `;
      flightsBody.appendChild(row);
    });

    // Si la opción de voz está habilitada, leer las llegadas
    if (voiceToggle.checked) {
      speakArrivals(flights);
    }
  }

  // Función para leer las llegadas (y opcionalmente salidas) usando Web Speech Synthesis
  function speakArrivals(flights) {
    if ('speechSynthesis' in window) {
      console.log("Leyendo llegadas con voz...");
      const arrivals = flights.filter(flight => flight.estimated_arrival !== 'N/A' && flight.arrival === 'AEP');
      
      if (arrivals.length === 0) {
        const utterance = new SpeechSynthesisUtterance("No hay llegadas disponibles para leer.");
        utterance.lang = 'es-ES';
        window.speechSynthesis.speak(utterance);
        return;
      }

      arrivals.forEach(flight => {
        const text = `Vuelo ${flight.flight_iata || 'desconocido'} de ${flight.airline_iata || 'aerolínea desconocida'}, procedente de ${flight.departure || 'origen desconocido'}, llegando a ${flight.arrival || 'destino desconocido'} a las ${flight.estimated_arrival || 'hora desconocida'}. Estado: ${flight.status || 'desconocido'}.`;
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'es-ES';
        window.speechSynthesis.speak(utterance);
      });
    } else {
      console.warn("La API de Web Speech Synthesis no está soportada en este navegador.");
      alert("Lo siento, tu navegador no soporta la función de voz.");
    }
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
        flightsBody.innerHTML = `<tr><td colspan="7">Error: ${data.error}</td></tr>`;
        updateMapMarkers([]);
        return;
      }

      allFlights = data.flights || [];
      console.log("Vuelos procesados:", allFlights);

      if (allFlights.length === 0) {
        flightsBody.innerHTML = '<tr><td colspan="7">No se encontraron vuelos.</td></tr>';
        updateMapMarkers([]);
        return;
      }

      // Mostrar todos los vuelos inicialmente
      updateTable(allFlights);
      updateMapMarkers(allFlights);
      updateLastUpdated();

    } catch (error) {
      console.error("Error al cargar los vuelos:", error);
      flightsBody.innerHTML = `<tr><td colspan="7">Error al cargar los vuelos: ${error.message}</td></tr>`;
      updateMapMarkers([]);
    }
  }

  // Función para filtrar vuelos por aerolínea, origen y destino
  function filterFlights() {
    const airline = airlineFilter.value.trim().toUpperCase();
    const origin = originFilter.value.trim().toUpperCase();
    const destination = destinationFilter.value.trim().toUpperCase();
    console.log("Filtrando vuelos por:", { airline, origin, destination });

    let filteredFlights = allFlights;

    if (airline) {
      filteredFlights = filteredFlights.filter(flight => 
        (flight.airline_iata || '').toUpperCase() === airline || 
        (flight.flight_iata || '').toUpperCase().startsWith(airline)
      );
    }

    if (origin) {
      filteredFlights = filteredFlights.filter(flight => 
        (flight.departure || '').toUpperCase() === origin
      );
    }

    if (destination) {
      filteredFlights = filteredFlights.filter(flight => 
        (flight.arrival || '').toUpperCase() === destination
      );
    }

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

  // Filtrar vuelos al presionar Enter en los campos de texto
  [airlineFilter, originFilter, destinationFilter].forEach(input => {
    input.addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        console.log("Enter presionado en el campo de filtro");
        filterFlights();
      }
    });
  });
});

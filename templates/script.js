document.addEventListener('DOMContentLoaded', () => {
  console.log("Script cargado y DOM listo");

  const refreshBtn = document.getElementById('refresh-btn');
  const filterBtn = document.getElementById('filter-btn');
  const searchFilter = document.getElementById('search-filter');
  const voiceToggle = document.getElementById('voice-toggle');
  const flightsBody = document.getElementById('flights-body');
  const lastUpdated = document.getElementById('last-updated');
  const connectedUsers = document.getElementById('connected-users');

  if (!refreshBtn || !filterBtn || !searchFilter || !voiceToggle || !flightsBody || !lastUpdated || !connectedUsers) {
    console.error("No se encontraron los elementos del DOM:", {
      refreshBtn: !!refreshBtn,
      filterBtn: !!filterBtn,
      searchFilter: !!searchFilter,
      voiceToggle: !!voiceToggle,
      flightsBody: !!flightsBody,
      lastUpdated: !!lastUpdated,
      connectedUsers: !!connectedUsers
    });
    return;
  }

  // Inicializar el mapa con Leaflet (centrado en un punto genérico)
  const map = L.map('map').setView([-34.6907, -58.4757], 5);

  // Añadir capa de OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Definir ícono personalizado para los marcadores
  const planeIcon = L.icon({
    iconUrl: '/templates/aero.png',
    iconSize: [32, 32], // Tamaño del ícono
    iconAnchor: [16, 16], // Punto del ícono que se alinea con la coordenada
    popupAnchor: [0, -16] // Punto donde se abre el popup respecto al ícono
  });

  // Variable para almacenar todos los vuelos
  let allFlights = [];

  // Configurar WebSocket para rastrear usuarios conectados
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
  let ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Conexión WebSocket establecida");
  };

  ws.onmessage = (event) => {
    const userCount = event.data;
    console.log("Usuarios conectados:", userCount);
    connectedUsers.textContent = `Usuarios conectados: ${userCount}`;
  };

  ws.onclose = () => {
    console.log("Conexión WebSocket cerrada. Intentando reconectar...");
    setTimeout(() => {
      ws = new WebSocket(wsUrl);
    }, 5000);
  };

  ws.onerror = (error) => {
    console.error("Error en WebSocket:", error);
  };

  // Función para actualizar los marcadores en el mapa
  function updateMapMarkers(flights) {
    console.log("Actualizando marcadores en el mapa con", flights.length, "vuelos");
    map.eachLayer(layer => {
      if (layer instanceof L.Marker) {
        map.removeLayer(layer);
      }
    });

    flights.forEach(flight => {
      if (flight.lat && flight.lon && !isNaN(flight.lat) && !isNaN(flight.lon)) {
        console.log("Añadiendo marcador para vuelo:", flight.flight_iata, "en", flight.lat, flight.lon);
        const marker = L.marker([flight.lat, flight.lon], { icon: planeIcon }).addTo(map);
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

    if (voiceToggle.checked) {
      speakArrivals(flights);
    }
  }

  // Función para leer las llegadas usando Web Speech Synthesis
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

      updateTable(allFlights);
      updateMapMarkers(allFlights);
      updateLastUpdated();

    } catch (error) {
      console.error("Error al cargar los vuelos:", error);
      flightsBody.innerHTML = `<tr><td colspan="7">Error al cargar los vuelos: ${error.message}</td></tr>`;
      updateMapMarkers([]);
    }
  }

  // Función para filtrar vuelos por términos de búsqueda
  function filterFlights() {
    const searchTerms = searchFilter.value.trim().toUpperCase().split(/\s+/);
    console.log("Filtrando vuelos por términos:", searchTerms);

    let filteredFlights = allFlights;

    if (searchTerms.length > 0) {
      filteredFlights = filteredFlights.filter(flight => {
        const airlineMatch = searchTerms.some(term => 
          (flight.airline_iata || '').toUpperCase() === term || 
          (flight.flight_iata || '').toUpperCase().startsWith(term)
        );
        const originMatch = searchTerms.some(term => 
          (flight.departure || '').toUpperCase() === term
        );
        const destinationMatch = searchTerms.some(term => 
          (flight.arrival || '').toUpperCase() === term
        );

        // Si no hay términos de búsqueda, mostrar todos los vuelos
        // Si hay términos, un vuelo debe coincidir con al menos uno de los criterios
        return searchTerms.length === 0 || airlineMatch || originMatch || destinationMatch;
      });
    }

    console.log("Vuelos filtrados:", filteredFlights);
    updateTable(filteredFlights);
    updateMapMarkers(filteredFlights);
  }

  // Cargar vuelos al iniciar
  console.log("Cargando vuelos al iniciar...");
  fetchFlights();

  // Actualizar vuelos automáticamente cada hora
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

  // Filtrar vuelos al presionar Enter en el campo de búsqueda
  searchFilter.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
      console.log("Enter presionado en el campo de búsqueda");
      filterFlights();
    }
  });
});
